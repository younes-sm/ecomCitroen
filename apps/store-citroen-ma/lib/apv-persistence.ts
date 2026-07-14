// Shared APV persistence helpers — used by both /api/rihla/chat and
// /api/rihla/voice/event so service appointments and complaints land in
// Supabase + sync to Stellantis Salesforce no matter which channel triggered
// the tool call. Voice tool calls used to silently no-op for these two tools;
// extracting the logic here closed that gap.

import { createServiceAppointment, createComplaint } from "@/lib/persistence";
import { validatePhone, normalizePhone } from "@/lib/phone";
import { validateEmail } from "@/lib/email";
import { validateVin, normalizeVin } from "@/lib/vin";
import { validateAppointmentDate, validateServiceDate } from "@/lib/dates";
import { nextRefNumber } from "@/lib/reference-number";
import { adminClient } from "@/lib/supabase/admin";
import { submitJeepApvAppointment, submitJeepApvComplaint } from "@/lib/salesforce";

export type ApvPersistResult = {
  ok: boolean;
  /** Local human-friendly reference (e.g. "RDV-20260604-001") — what the
   *  customer sees in the chat / hears in voice. */
  refNumber: string;
  /** Salesforce Case Id returned by Stellantis CRM ("500Tv00000…") — the
   *  "Id de ticket créé" from the NBS API spec. Stored for back-office
   *  cross-reference. `null` if the SF sync failed or hasn't completed. */
  salesforceCaseId: string | null;
  summary: Record<string, string | undefined>;
  warnings: string[];
};

// Strip any obvious placeholder / marker the model might have shoved into a
// required field. Sources of bad values we've actually seen in production:
//   - Template syntax the model hallucinated:
//       "<customer_phone_from_session>", "<...STEP_4>", "(non communiqué)", "TBD"
//   - Wire markers leaking through (the chat client prepends [FIELD_TYPED] /
//     [MAISON_SELECTED] to sensitive typed turns — Gemini sometimes copies a
//     fragment of the marker into the tool arg, producing values like
//     "[FIELD@gmail.com" or "[MAISON SELECTED] Italcar"). These crash
//     Salesforce with INVALID_EMAIL_ADDRESS / invalid phone format.
// Treat them as MISSING so the per-field validators reject cleanly and the
// case lands with a warning instead of a Salesforce 400.
function sanitisePlaceholder(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (s.includes("<") || s.includes(">")) return "";
  // Wire-marker leakage: any value that starts with "[" + uppercase letters
  // is almost certainly a half-pasted "[FIELD_TYPED]" / "[MAISON_SELECTED]"
  // marker — never a real name / phone / email / VIN. Drop the whole value.
  if (/^\[[A-Z_]+/.test(s)) return "";
  if (/FIELD_?TYPED|MAISON_?SELECTED/i.test(s)) return "";
  if (/STEP_?\d|customer_(phone|email|name|lastname)|collected_by_STEP|_from_session/i.test(s)) return "";
  if (/^\(?non\s+communiqué\)?$/i.test(s)) return "";
  if (/^TBD$/i.test(s)) return "";
  return s;
}

export async function persistAppointment(args: {
  brandSlug: string;
  conversationId: string | null;
  input: Record<string, unknown>;
}): Promise<ApvPersistResult> {
  const i = args.input;
  const warnings: string[] = [];

  let brandId = "";
  try {
    const supa = adminClient();
    const { data } = await supa.from("brands").select("id").eq("slug", args.brandSlug).single();
    brandId = (data as unknown as { id?: string } | null)?.id ?? "";
  } catch { /* offline */ }

  // Idempotency — ONE appointment per conversation. book_service_appointment
  // gets re-fired across turns; without this each call minted a new RDV (the
  // duplicate-records bug). Return the existing one instead.
  if (args.conversationId) {
    try {
      const supa = adminClient();
      const { data: existing } = await (supa.from("service_appointments") as any)
        .select("ref_number")
        .eq("conversation_id", args.conversationId)
        .limit(1)
        .maybeSingle();
      if (existing?.ref_number) {
        console.log(`[apv/appointment] dedup — already exists for conv=${args.conversationId} ref=${existing.ref_number}`);
        return { ok: true, refNumber: existing.ref_number, salesforceCaseId: null, summary: {}, warnings: [] };
      }
    } catch { /* best-effort dedup — fall through */ }
  }

  const refNumber = brandId
    ? await nextRefNumber({ brandId, kind: "RDV" })
    : `RDV-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.floor(Math.random() * 999).toString().padStart(3, "0")}`;

  const fullNameClean = sanitisePlaceholder(i.fullName);
  if (!fullNameClean && i.fullName) warnings.push("fullName-placeholder-stripped");

  const phoneRaw = sanitisePlaceholder(i.phone);
  if (!phoneRaw) warnings.push(`phone-placeholder-stripped`);
  const phone = validatePhone(phoneRaw, "MA");
  if (!phone.ok) warnings.push(`phone-format: ${phone.reason ?? "?"}`);
  const phoneFinal = phone.ok ? phone.canonical : normalizePhone(phoneRaw, "MA");

  const emailRaw = sanitisePlaceholder(i.email);
  if (!emailRaw) warnings.push(`email-placeholder-stripped`);
  const email = validateEmail(emailRaw);
  if (!email.ok) warnings.push(`email-format: ${email.reason ?? "?"}`);
  const emailFinal = email.ok ? email.canonical : emailRaw;

  const vin = validateVin(String(i.vin ?? ""));
  if (!vin.ok) warnings.push(`vin-format: ${vin.reason ?? "?"}`);
  const vinFinal = vin.ok ? vin.canonical : normalizeVin(String(i.vin ?? ""));

  const date = validateAppointmentDate(String(i.preferredDate ?? ""));
  if (!date.ok) warnings.push(`date-${date.reason ?? "?"}`);
  // Use the validator's canonical ISO ONLY when valid. On failure canonical
  // holds the raw input verbatim (e.g. malformed "y009-05-31"), which would
  // crash Salesforce — fall back to tomorrow as a safe default.
  const dateFinal = date.ok
    ? date.canonical
    : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const interventionRaw = String(i.interventionType ?? "service_rapide");
  const intervention: "service_rapide" | "mechanical" | "bodywork" =
    interventionRaw === "bodywork" || interventionRaw === "mechanical" || interventionRaw === "service_rapide"
      ? interventionRaw
      : "service_rapide";
  const slot = String(i.preferredSlot ?? "morning") as "morning" | "afternoon";
  const cndp = i.cndpConsent === true;
  if (!cndp) warnings.push("cndp-missing");

  console.log(
    `[apv/appointment] persist brand=${args.brandSlug} conv=${args.conversationId ?? "n/a"} vin=${vinFinal} model=${String(i.vehicleModel ?? "?")}`
  );

  const persisted = await createServiceAppointment({
    brandSlug: args.brandSlug,
    conversationId: args.conversationId,
    refNumber,
    fullName: fullNameClean,
    phone: phoneFinal,
    email: emailFinal,
    vehicleBrand: String(i.vehicleBrand ?? ""),
    vehicleModel: String(i.vehicleModel ?? ""),
    vin: vinFinal,
    interventionType: intervention,
    city: String(i.city ?? ""),
    preferredDate: dateFinal,
    preferredSlot: slot,
    comment: typeof i.comment === "string" ? i.comment : undefined,
    cndpConsentAt: new Date().toISOString(),
    notes: warnings.length > 0 ? `validation-warnings: ${warnings.join(" · ")}` : undefined,
  });

  // Salesforce Case sync — Jeep only. Now AWAITED (was fire-and-forget) so
  // we can return the SF Case Id ("Id de ticket créé" per the NBS API spec)
  // to the caller — the chat / voice routes surface it to the customer and
  // store it for back-office cross-reference. Duplicate 400s are treated
  // as success inside createCase, so a typical call resolves in <1s.
  let salesforceCaseId: string | null = null;
  if (args.brandSlug === "jeep-ma") {
    const finalRef = persisted?.refNumber ?? refNumber;
    try {
      console.log(
        `[salesforce/case] → POST appointment ref=${finalRef} conv=${args.conversationId ?? "n/a"}`
      );
      // Agent may pass the maison choice as showroomName / showroom / site —
      // any of those becomes the canonical maison API name we feed into
      // resolveJeepLeadPicklists() to compute Dealer__c + Showroom__c.
      const showroomFromInput =
        (typeof i.showroomName === "string" && i.showroomName.trim()) ||
        (typeof i.showroom === "string" && i.showroom.trim()) ||
        (typeof i.site === "string" && i.site.trim()) ||
        undefined;
      const { payload, response } = await submitJeepApvAppointment({
        fullName: fullNameClean,
        phone: phoneFinal,
        email: emailFinal,
        vehicleModel: String(i.vehicleModel ?? ""),
        vin: vinFinal,
        interventionType: intervention,
        city: String(i.city ?? ""),
        showroom: showroomFromInput,
        preferredDate: dateFinal,
        preferredSlot: slot,
        comment: typeof i.comment === "string" ? i.comment : undefined,
        refNumber: finalRef,
        conversationId: args.conversationId,
      });
      console.log("[salesforce/case]   payload:", JSON.stringify(payload, null, 2));
      console.log("[salesforce/case]   response:", JSON.stringify(response, null, 2));
      console.log(
        `[salesforce/case] ✓ Jeep RDV synced: caseId=${response.id} ref=${finalRef} success=${response.success}`
      );
      if (response.success && response.id) {
        salesforceCaseId = response.id;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[salesforce/case] ✗ Jeep RDV sync failed for ref=${finalRef}:`,
        msg
      );
    }
  }

  return {
    ok: !!persisted,
    refNumber: persisted?.refNumber ?? refNumber,
    salesforceCaseId,
    summary: {
      fullName: fullNameClean,
      phone: phoneFinal,
      email: emailFinal,
      vehicleBrand: String(i.vehicleBrand ?? ""),
      vehicleModel: String(i.vehicleModel ?? ""),
      vin: vinFinal,
      interventionType: intervention,
      city: String(i.city ?? ""),
      preferredDate: dateFinal,
      preferredSlot: slot,
    },
    warnings,
  };
}

export async function persistComplaint(args: {
  brandSlug: string;
  conversationId: string | null;
  input: Record<string, unknown>;
}): Promise<ApvPersistResult> {
  const i = args.input;
  const warnings: string[] = [];

  let brandId = "";
  try {
    const supa = adminClient();
    const { data } = await supa.from("brands").select("id").eq("slug", args.brandSlug).single();
    brandId = (data as unknown as { id?: string } | null)?.id ?? "";
  } catch { /* offline */ }

  // Idempotency — ONE complaint per conversation. submit_complaint re-fires
  // across turns; without this each call created a new réclamation (the 16-rows-
  // for-3-people bug seen in production). Return the existing one instead.
  if (args.conversationId) {
    try {
      const supa = adminClient();
      const { data: existing } = await (supa.from("complaints") as any)
        .select("ref_number")
        .eq("conversation_id", args.conversationId)
        .limit(1)
        .maybeSingle();
      if (existing?.ref_number) {
        console.log(`[apv/complaint] dedup — already exists for conv=${args.conversationId} ref=${existing.ref_number}`);
        return { ok: true, refNumber: existing.ref_number, salesforceCaseId: null, summary: {}, warnings: [] };
      }
    } catch { /* best-effort dedup — fall through */ }
  }

  const refNumber = brandId
    ? await nextRefNumber({ brandId, kind: "REL" })
    : `REL-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.floor(Math.random() * 999).toString().padStart(3, "0")}`;

  const fullNameClean = sanitisePlaceholder(i.fullName);
  if (!fullNameClean && i.fullName) warnings.push("fullName-placeholder-stripped");

  const phoneRaw = sanitisePlaceholder(i.phone);
  if (!phoneRaw) warnings.push("phone-placeholder-stripped");
  const phone = validatePhone(phoneRaw, "MA");
  if (!phone.ok) warnings.push(`phone-format: ${phone.reason ?? "?"}`);
  const phoneFinal = phone.ok ? phone.canonical : normalizePhone(phoneRaw, "MA");

  const emailRaw = sanitisePlaceholder(i.email);
  if (!emailRaw) warnings.push("email-placeholder-stripped");
  const email = validateEmail(emailRaw);
  if (!email.ok) warnings.push(`email-format: ${email.reason ?? "?"}`);
  const emailFinal = email.ok ? email.canonical : emailRaw;

  const vin = validateVin(String(i.vin ?? ""));
  if (!vin.ok) warnings.push(`vin-format: ${vin.reason ?? "?"}`);
  const vinFinal = vin.ok ? vin.canonical : normalizeVin(String(i.vin ?? ""));

  let serviceDateFinal: string | null = null;
  if (typeof i.serviceDate === "string" && i.serviceDate.trim()) {
    const sd = validateServiceDate(i.serviceDate);
    if (!sd.ok) warnings.push(`service-date-${sd.reason ?? "?"}`);
    serviceDateFinal = sd.canonical || null;
  }

  const reason = String(i.reason ?? "").trim();
  if (reason.length < 20) warnings.push("reason-too-short");

  const interventionRaw = String(i.interventionType ?? "service_rapide");
  const intervention: "service_rapide" | "mechanical" | "bodywork" =
    interventionRaw === "bodywork" || interventionRaw === "mechanical" || interventionRaw === "service_rapide"
      ? interventionRaw
      : "service_rapide";
  const cndp = i.cndpConsent === true;
  if (!cndp) warnings.push("cndp-missing");

  console.log(
    `[apv/complaint] persist brand=${args.brandSlug} conv=${args.conversationId ?? "n/a"} vin=${vinFinal} site=${String(i.site ?? "?")}`
  );

  const persisted = await createComplaint({
    brandSlug: args.brandSlug,
    conversationId: args.conversationId,
    refNumber,
    fullName: fullNameClean,
    phone: phoneFinal,
    email: emailFinal,
    vehicleBrand: String(i.vehicleBrand ?? ""),
    vehicleModel: String(i.vehicleModel ?? ""),
    vin: vinFinal,
    interventionType: intervention,
    site: String(i.site ?? ""),
    serviceDate: serviceDateFinal,
    reason,
    attachmentUrl: typeof i.attachmentUrl === "string" ? i.attachmentUrl : undefined,
    cndpConsentAt: new Date().toISOString(),
    crcNotes: warnings.length > 0 ? `validation-warnings: ${warnings.join(" · ")}` : undefined,
  });

  // Salesforce Case sync — awaited so we can return the SF Case Id.
  let salesforceCaseId: string | null = null;
  if (args.brandSlug === "jeep-ma") {
    const finalRef = persisted?.refNumber ?? refNumber;
    try {
      console.log(
        `[salesforce/case] → POST complaint ref=${finalRef} conv=${args.conversationId ?? "n/a"}`
      );
      const { payload, response } = await submitJeepApvComplaint({
        fullName: fullNameClean,
        phone: phoneFinal,
        email: emailFinal,
        vehicleModel: String(i.vehicleModel ?? ""),
        vin: vinFinal,
        interventionType: intervention,
        site: String(i.site ?? ""),
        serviceDate: serviceDateFinal,
        reason,
        attachmentUrl: typeof i.attachmentUrl === "string" ? i.attachmentUrl : undefined,
        refNumber: finalRef,
        conversationId: args.conversationId,
      });
      console.log("[salesforce/case]   payload:", JSON.stringify(payload, null, 2));
      console.log("[salesforce/case]   response:", JSON.stringify(response, null, 2));
      console.log(
        `[salesforce/case] ✓ Jeep réclamation synced: caseId=${response.id} ref=${finalRef} success=${response.success}`
      );
      if (response.success && response.id) {
        salesforceCaseId = response.id;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[salesforce/case] ✗ Jeep réclamation sync failed for ref=${finalRef}:`,
        msg
      );
    }
  }

  return {
    ok: !!persisted,
    refNumber: persisted?.refNumber ?? refNumber,
    salesforceCaseId,
    summary: {
      fullName: fullNameClean,
      phone: phoneFinal,
      email: emailFinal,
      vehicleBrand: String(i.vehicleBrand ?? ""),
      vehicleModel: String(i.vehicleModel ?? ""),
      vin: vinFinal,
      interventionType: intervention,
      site: String(i.site ?? ""),
      serviceDate: serviceDateFinal ?? undefined,
      reason: reason.slice(0, 100),
    },
    warnings,
  };
}

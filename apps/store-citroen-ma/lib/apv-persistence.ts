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
  refNumber: string;
  summary: Record<string, string | undefined>;
  warnings: string[];
};

// Strip any obvious placeholder string the model might have shoved into a
// required field ("<customer_phone_from_session>", "<customer_email_if_collected_by_STEP_4>",
// "TBD", "(non communiqué)", any value with < or > or "STEP_"). These come
// from the model hallucinating template syntax instead of asking for the
// real value — they crash Salesforce with INVALID_EMAIL_ADDRESS / invalid
// phone format. Treat them as missing so the per-field validators reject
// cleanly and the lead lands with a warning instead of a Salesforce 400.
function sanitisePlaceholder(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (s.includes("<") || s.includes(">")) return "";
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

  // Salesforce Case sync — Jeep only. Fire-and-forget so a slow / failing
  // Stellantis Salesforce never blocks the user-facing booking confirmation.
  if (args.brandSlug === "jeep-ma") {
    void (async () => {
      const finalRef = persisted?.refNumber ?? refNumber;
      try {
        console.log(
          `[salesforce/case] → POST appointment ref=${finalRef} conv=${args.conversationId ?? "n/a"}`
        );
        const { payload, response } = await submitJeepApvAppointment({
          fullName: fullNameClean,
          phone: phoneFinal,
          email: emailFinal,
          vehicleModel: String(i.vehicleModel ?? ""),
          vin: vinFinal,
          interventionType: intervention,
          city: String(i.city ?? ""),
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
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[salesforce/case] ✗ Jeep RDV sync failed for ref=${finalRef}:`,
          msg
        );
      }
    })();
  }

  return {
    ok: !!persisted,
    refNumber: persisted?.refNumber ?? refNumber,
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

  if (args.brandSlug === "jeep-ma") {
    void (async () => {
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
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[salesforce/case] ✗ Jeep réclamation sync failed for ref=${finalRef}:`,
          msg
        );
      }
    })();
  }

  return {
    ok: !!persisted,
    refNumber: persisted?.refNumber ?? refNumber,
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

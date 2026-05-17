// Conversation + message + tool-call + event persistence to Supabase.
// All functions are best-effort — a Supabase outage must not break the agent.

import { adminClient } from "@/lib/supabase/admin";
import { submitJeepTestDriveLead } from "@/lib/salesforce";
import type {
  Conversation,
  Channel,
  ConversationStatus,
  ImageCardPayload,
  Locale,
  ToolUsePayload,
} from "@/lib/supabase/database.types";

function client() {
  try {
    return adminClient();
  } catch {
    return null;
  }
}

/** Create a conversation row. Returns the new row id, or null on failure. */
export async function createConversation(args: {
  brandSlug: string;
  promptId?: string | null;
  locale: Locale;
  channel: Channel;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<string | null> {
  const supa = client();
  if (!supa) return null;
  try {
    const { data: brandRow } = await supa.from("brands").select("id").eq("slug", args.brandSlug).single();
    const brandId = (brandRow as unknown as { id?: string } | null)?.id;
    if (!brandId) return null;
    const { data, error } = await (supa.from("conversations") as any)
      .insert({
        brand_id: brandId,
        prompt_id: args.promptId ?? null,
        locale: args.locale,
        channel: args.channel,
        ip_country: args.ip ?? null,
        user_agent: args.userAgent ?? null,
        status: "open",
      })
      .select("id")
      .single();
    if (error || !data) return null;
    return (data as { id: string }).id;
  } catch (err) {
    console.warn("[persistence] createConversation failed:", (err as Error).message.slice(0, 100));
    return null;
  }
}

export async function appendUserMessage(conversationId: string, text: string): Promise<void> {
  const supa = client();
  if (!supa) return;
  try {
    await (supa.from("messages") as any).insert({
      conversation_id: conversationId,
      role: "user",
      kind: "text",
      content: text,
    });
  } catch { /* swallow */ }
}

export async function appendAssistantMessage(conversationId: string, text: string): Promise<void> {
  if (!text) return;
  const supa = client();
  if (!supa) return;
  try {
    await (supa.from("messages") as any).insert({
      conversation_id: conversationId,
      role: "assistant",
      kind: "text",
      content: text,
    });
  } catch { /* swallow */ }
}

export async function appendImageCard(conversationId: string, payload: ImageCardPayload): Promise<void> {
  const supa = client();
  if (!supa) return;
  try {
    await (supa.from("messages") as any).insert({
      conversation_id: conversationId,
      role: "assistant",
      kind: "image_card",
      content: payload.caption ?? null,
      payload,
    });
  } catch { /* swallow */ }
}

/** Returns true if ANY of the 4 booking tools has already been recorded for
 *  this conversation. Used by the voice end_call handler to detect "stalled
 *  booking" — agent emitted confirmation text but never fired the tool. */
export async function hasBookingToolFired(conversationId: string): Promise<boolean> {
  const supa = client();
  if (!supa) return false;
  try {
    const { data } = await (supa.from("tool_calls") as any)
      .select("name")
      .eq("conversation_id", conversationId)
      .in("name", [
        "book_test_drive",
        "book_showroom_visit",
        "book_service_appointment",
        "submit_complaint",
      ])
      .limit(1);
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

/** Fetch the last N messages for a conversation, newest first. Used by the
 *  voice end_call stalled-booking detector to scan the transcript for the
 *  CNDP-yes + agent-confirmation pattern and try to recover the lead. */
export async function fetchRecentMessages(
  conversationId: string,
  limit = 30,
): Promise<Array<{ role: string; kind: string; text: string | null; created_at: string }>> {
  const supa = client();
  if (!supa) return [];
  try {
    const { data } = await (supa.from("messages") as any)
      .select("role, kind, text, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(limit);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function recordToolCall(args: {
  conversationId: string;
  name: string;
  input: Record<string, unknown>;
  result?: unknown;
  succeeded?: boolean;
}): Promise<void> {
  const supa = client();
  if (!supa) return;
  try {
    const { data: msg } = await (supa.from("messages") as any)
      .insert({
        conversation_id: args.conversationId,
        role: "assistant",
        kind: "tool_use",
        payload: { name: args.name, input: args.input, output: args.result } as ToolUsePayload,
      })
      .select("id")
      .single();
    await (supa.from("tool_calls") as any).insert({
      conversation_id: args.conversationId,
      message_id: (msg as unknown as { id?: string } | null)?.id ?? null,
      name: args.name,
      input: args.input,
      result: args.result ?? null,
      succeeded: args.succeeded ?? null,
    });
  } catch { /* swallow */ }
}

export async function recordEvent(args: {
  conversationId?: string | null;
  brandSlug?: string;
  name: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const supa = client();
  if (!supa) return;
  try {
    let brandId: string | null = null;
    if (args.brandSlug) {
      const { data } = await supa.from("brands").select("id").eq("slug", args.brandSlug).single();
      brandId = (data as unknown as { id?: string } | null)?.id ?? null;
    }
    await (supa.from("events") as any).insert({
      conversation_id: args.conversationId ?? null,
      brand_id: brandId,
      name: args.name,
      payload: args.payload ?? {},
    });
  } catch { /* swallow */ }
}

/**
 * Detect funnel checkpoint progress from a fresh user/assistant turn and stamp
 * the corresponding column on the conversation row. Cheap heuristics — good
 * enough for analytics, not used for any control-flow decisions.
 */
export async function updateFunnelCheckpoints(args: {
  conversationId: string;
  userText: string;
  assistantText: string;
}): Promise<void> {
  const supa = client();
  if (!supa) return;
  const u = args.userText.toLowerCase();
  const a = args.assistantText.toLowerCase();
  const updates: Partial<Conversation> = {};
  // Usage answered → first user message after greeting typically mentions city/family/work.
  if (/famille|enfant|ville|usage|trajet|بغيت|للعائلة|للمدينة|family|city|kids|commute/.test(u)) {
    updates.reached_usage = new Date().toISOString();
  }
  // Budget mentioned in user message
  if (/\d{3,}.*(mad|dh|sar|riyal|dirham)|mensualité|monthly|budget|ميزانية|شهري/.test(u)) {
    updates.reached_budget = new Date().toISOString();
  }
  // Recommendation given by assistant (mentions a model name and price)
  if (/\d{3,}\s*(mad|dh|sar|dhs|dirham|riyal)/.test(a)) {
    updates.reached_recommendation = new Date().toISOString();
  }
  if (Object.keys(updates).length === 0) return;
  try {
    await (supa.from("conversations") as any).update(updates).eq("id", args.conversationId);
  } catch { /* swallow */ }
}

/** Result reported back to the chat route so it can emit a customer-friendly
 *  message when Salesforce flags a duplicate (the customer's lead is already
 *  in CRM — we don't want the agent to say "error", we want it to say "we
 *  already have your details, a commercial will contact you"). */
export type CaptureLeadResult = {
  supabaseOk: boolean;
  salesforce: "ok" | "duplicate" | "failed" | "skipped";
  salesforceMessage?: string;
};

export async function captureLeadFromBooking(args: {
  conversationId: string;
  brandSlug: string;
  modelSlug: string;
  firstName: string;
  phone: string;
  email?: string;
  city?: string;
  preferredSlot?: string;
  showroomName?: string;
  notes?: string;
}): Promise<CaptureLeadResult> {
  const result: CaptureLeadResult = { supabaseOk: false, salesforce: "skipped" };
  const supa = client();
  if (!supa) return result;
  // Trim + lightly validate email so a "yes, take it" garbage value doesn't
  // poison the leads table. Anything that doesn't look like an email is
  // dropped silently — Salesforce sync below will then skip the field too.
  const cleanEmail = (() => {
    const e = args.email?.trim();
    if (!e) return undefined;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : undefined;
  })();
  try {
    const { data: brandRow } = await supa.from("brands").select("id").eq("slug", args.brandSlug).single();
    const brandId = (brandRow as unknown as { id?: string } | null)?.id;
    if (!brandId) return result;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const leadRow: any = {
      brand_id: brandId,
      conversation_id: args.conversationId,
      model_slug: args.modelSlug,
      first_name: args.firstName,
      phone: args.phone,
      city: args.city ?? null,
      preferred_slot: args.preferredSlot ?? null,
      status: "new",
    };
    if (cleanEmail) leadRow.email = cleanEmail;
    if (args.showroomName) leadRow.showroom_name = args.showroomName;
    if (args.notes) leadRow.notes = args.notes;
    await (supa.from("leads") as any).insert(leadRow);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const convUpdate: any = {
      status: "closed_lead",
      booked_test_drive: new Date().toISOString(),
      captured_name: new Date().toISOString(),
      captured_phone: new Date().toISOString(),
      captured_city: args.city ? new Date().toISOString() : null,
      captured_slot: args.preferredSlot ? new Date().toISOString() : null,
      lead_name: args.firstName,
      lead_phone: args.phone,
      lead_city: args.city ?? null,
      lead_slot: args.preferredSlot ?? null,
      lead_model_slug: args.modelSlug,
      ended_at: new Date().toISOString(),
    };
    if (cleanEmail) {
      convUpdate.lead_email = cleanEmail;
      convUpdate.captured_email = new Date().toISOString();
    }
    if (args.showroomName) convUpdate.lead_showroom = args.showroomName;
    await (supa.from("conversations") as any).update(convUpdate).eq("id", args.conversationId);
    result.supabaseOk = true;
  } catch { /* swallow */ }

  // Salesforce sync — Jeep only. AWAITED (not fire-and-forget anymore) so the
  // chat route can detect DUPLICATES_DETECTED and switch the agent's message
  // from "saved successfully" to "we already have your details on file — a
  // commercial will reach out shortly". Without awaiting, the duplicate
  // signal arrived after the response had already been streamed and the
  // customer saw confusing "technique" messages while their info was in
  // fact already saved.
  if (args.brandSlug === "jeep-ma") {
    try {
      const sfResult = await submitJeepTestDriveLead({
        firstName: args.firstName,
        phone: args.phone,
        email: cleanEmail,
        city: args.city,
        modelSlug: args.modelSlug,
        preferredSlot: args.preferredSlot,
        showroom: args.showroomName,
        conversationId: args.conversationId,
      });
      console.log(
        `[salesforce] ✓ Jeep lead synced to Stellantis CRM: id=${sfResult.id} firstName=${args.firstName} model=${args.modelSlug} (conv=${args.conversationId})`
      );
      result.salesforce = "ok";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Stellantis Salesforce returns DUPLICATES_DETECTED (HTTP 400) when the
      // phone or email matches an existing Lead. We log it as informational
      // (not an error) and pass the signal up so the agent says the right
      // thing to the customer.
      const isDuplicate = /DUPLICATES_DETECTED|duplicateRule|Lead\s*Duplicate/i.test(msg);
      if (isDuplicate) {
        console.log(
          `[salesforce] ◷ Jeep lead duplicate detected — already in CRM. firstName=${args.firstName} phone=${args.phone}`
        );
        result.salesforce = "duplicate";
        result.salesforceMessage = msg.slice(0, 200);
      } else {
        console.error(
          `[salesforce] ✗ Jeep lead push failed for firstName=${args.firstName} phone=${args.phone}:`,
          msg
        );
        result.salesforce = "failed";
        result.salesforceMessage = msg.slice(0, 200);
      }
    }
  }

  return result;
}

/* ─────────────────── APV (after-sales) persistence ─────────────────── */

export async function createServiceAppointment(args: {
  brandSlug: string;
  conversationId?: string | null;
  refNumber: string;
  fullName: string;
  phone: string;
  email: string;
  vehicleBrand: string;
  vehicleModel: string;
  vin: string;
  interventionType: "service_rapide" | "mechanical" | "bodywork";
  city: string;
  preferredDate: string;          // ISO yyyy-mm-dd
  preferredSlot: "morning" | "afternoon";
  comment?: string;
  cndpConsentAt: string;          // ISO timestamp
  notes?: string;
}): Promise<{ id: string; refNumber: string } | null> {
  const supa = client();
  if (!supa) return null;
  try {
    const { data: brandRow } = await supa.from("brands").select("id").eq("slug", args.brandSlug).single();
    const brandId = (brandRow as unknown as { id?: string } | null)?.id;
    if (!brandId) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supa.from("service_appointments") as any)
      .insert({
        brand_id: brandId,
        conversation_id: args.conversationId ?? null,
        ref_number: args.refNumber,
        full_name: args.fullName,
        phone: args.phone,
        email: args.email,
        vehicle_brand: args.vehicleBrand,
        vehicle_model: args.vehicleModel,
        vin: args.vin,
        intervention_type: args.interventionType,
        city: args.city,
        preferred_date: args.preferredDate,
        preferred_slot: args.preferredSlot,
        comment: args.comment ?? null,
        cndp_consent_at: args.cndpConsentAt,
        source: "chatbot",
        notes: args.notes ?? null,
      })
      .select("id, ref_number")
      .single();
    if (error || !data) return null;
    return { id: (data as { id: string }).id, refNumber: (data as { ref_number: string }).ref_number };
  } catch (err) {
    console.warn("[persistence] createServiceAppointment failed:", (err as Error).message.slice(0, 100));
    return null;
  }
}

export async function createComplaint(args: {
  brandSlug: string;
  conversationId?: string | null;
  refNumber: string;
  fullName: string;
  phone: string;
  email: string;
  vehicleBrand: string;
  vehicleModel: string;
  vin: string;
  interventionType: "service_rapide" | "mechanical" | "bodywork";
  site: string;
  serviceDate?: string | null;
  reason: string;
  attachmentUrl?: string | null;
  cndpConsentAt: string;
  crcNotes?: string;
}): Promise<{ id: string; refNumber: string } | null> {
  const supa = client();
  if (!supa) return null;
  try {
    const { data: brandRow } = await supa.from("brands").select("id").eq("slug", args.brandSlug).single();
    const brandId = (brandRow as unknown as { id?: string } | null)?.id;
    if (!brandId) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supa.from("complaints") as any)
      .insert({
        brand_id: brandId,
        conversation_id: args.conversationId ?? null,
        ref_number: args.refNumber,
        full_name: args.fullName,
        phone: args.phone,
        email: args.email,
        vehicle_brand: args.vehicleBrand,
        vehicle_model: args.vehicleModel,
        vin: args.vin,
        intervention_type: args.interventionType,
        site: args.site,
        service_date: args.serviceDate ?? null,
        reason: args.reason,
        attachment_url: args.attachmentUrl ?? null,
        cndp_consent_at: args.cndpConsentAt,
        source: "chatbot",
        crc_notes: args.crcNotes ?? null,
      })
      .select("id, ref_number")
      .single();
    if (error || !data) return null;
    return { id: (data as { id: string }).id, refNumber: (data as { ref_number: string }).ref_number };
  } catch (err) {
    console.warn("[persistence] createComplaint failed:", (err as Error).message.slice(0, 100));
    return null;
  }
}

export async function closeConversation(
  conversationId: string,
  status: ConversationStatus = "closed_no_lead"
): Promise<void> {
  const supa = client();
  if (!supa) return;
  try {
    // Don't downgrade an already-closed_lead conversation: read first.
    const { data } = await supa.from("conversations").select("status").eq("id", conversationId).single();
    const current = (data as unknown as { status?: ConversationStatus } | null)?.status;
    if (current === "closed_lead") return;
    await (supa.from("conversations") as any)
      .update({ status, ended_at: new Date().toISOString() })
      .eq("id", conversationId);
  } catch { /* swallow */ }
}

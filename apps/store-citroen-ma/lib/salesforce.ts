// Salesforce REST integration — OAuth2 password flow + Lead creation.
// Used to push Jeep test-drive bookings into Stellantis CRM.

const SF_AUTH_URL =
  process.env.SF_AUTH_URL ?? "https://login.salesforce.com/services/oauth2/token";
const SF_LEAD_URL =
  process.env.SF_LEAD_URL ??
  "https://stellantis-e.my.salesforce.com/services/data/v54.0/sobjects/Lead";
const SF_CASE_URL =
  process.env.SF_CASE_URL ??
  "https://stellantis-e.my.salesforce.com/services/data/v54.0/sobjects/Case";

// RecordTypeIds for the Stellantis Case object (from NBS Consulting API doc).
// Each combination of Type × department maps to one RecordTypeId. These IDs
// are MANDATORY in the payload — Stellantis routing rules use them to dispatch
// Cases to the right team (RDV/SAV → workshop, Réclamation/SAV → CRC, etc).
//
// History: there was an earlier "INVALID_CROSS_REFERENCE_KEY" error when the
// integration user's Profile didn't have the RecordType assigned. That's been
// fixed admin-side by Abderrahim (Profile → Record Type Settings → Case). The
// values below are the live IDs and are always sent in the payload now.
// Env vars can override per-deploy if Stellantis ever changes the IDs.
//
// Trim + fall back so a setting of "" in .env doesn't accidentally blank the
// field — historically that was an escape hatch but Stellantis now requires
// the ID and the escape hatch caused the field to be missing in production.
const RECORD_TYPE_INFOS_SAV =
  (process.env.SF_RECORD_TYPE_INFOS_SAV?.trim() || "012Tv00000IRHP0IAP");
const RECORD_TYPE_RDV_SAV =
  (process.env.SF_RECORD_TYPE_RDV_SAV?.trim() || "012Tv00000IRHP3IAP");
const RECORD_TYPE_RECLAMATION_SAV =
  (process.env.SF_RECORD_TYPE_RECLAMATION_SAV?.trim() || "012Tv00000IRHP6IAP");

const TOKEN_SAFETY_WINDOW_MS = 60_000;
const TOKEN_DEFAULT_TTL_SECONDS = 3600;

type CachedToken = { access_token: string; expires_at: number };

let cachedToken: CachedToken | null = null;
let inflightToken: Promise<string> | null = null;

async function fetchNewToken(): Promise<string> {
  const username = process.env.SF_USERNAME;
  const password = process.env.SF_PASSWORD;
  const securityToken = process.env.SF_SECURITY_TOKEN ?? "";
  const clientId = process.env.SF_CLIENT_ID;
  const clientSecret = process.env.SF_CLIENT_SECRET;

  if (!username || !password || !clientId || !clientSecret) {
    throw new Error(
      "Missing SF_USERNAME, SF_PASSWORD, SF_CLIENT_ID, or SF_CLIENT_SECRET env var"
    );
  }

  const params = new URLSearchParams({
    grant_type: "password",
    client_id: clientId,
    client_secret: clientSecret,
    username,
    password: password + securityToken,
  });

  const res = await fetch(SF_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Salesforce token request failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in?: number };
  const ttlSeconds =
    typeof data.expires_in === "number" ? data.expires_in : TOKEN_DEFAULT_TTL_SECONDS;
  cachedToken = {
    access_token: data.access_token,
    expires_at: Date.now() + ttlSeconds * 1000 - TOKEN_SAFETY_WINDOW_MS,
  };
  return data.access_token;
}

export async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expires_at) {
    return cachedToken.access_token;
  }
  if (inflightToken) return inflightToken;
  inflightToken = fetchNewToken().finally(() => {
    inflightToken = null;
  });
  return inflightToken;
}

export interface LeadPayload {
  Salutation: string;
  LastName: string;
  FirstName: string;
  MobilePhone: string;
  Email: string;
  Marque_interet_FB__c: string;
  Modele_d_interet_Text__c: string;
  Showroom_Text__c: string;
  City: string;
  LeadSource: string;
  is_Web__c: boolean;
  Ticket_type__c: string;
  Description: string;
  RecordTypeId: string;
}

export interface SalesforceCreateResponse {
  id: string;
  success: boolean;
  errors: unknown[];
}

async function postLead(token: string, payload: LeadPayload): Promise<Response> {
  return fetch(SF_LEAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      // Bypass Stellantis "Lead_Duplicate_Rule" — chatbot bookings should always
      // create a record even when a matching lead already exists; the CRM team
      // dedupes downstream.
      "Sforce-Duplicate-Rule-Header": "allowSave=true",
    },
    body: JSON.stringify(payload),
  });
}

export async function createLead(payload: LeadPayload): Promise<SalesforceCreateResponse> {
  // Always log the payload going to Salesforce — same observability the Case
  // helper has. Lets dev / on-call correlate "lead not in CRM" reports with
  // the exact JSON Stellantis received.
  console.log("[salesforce/lead] → POST", JSON.stringify(payload, null, 2));

  const token = await getAccessToken();
  let res = await postLead(token, payload);

  if (res.status === 401) {
    cachedToken = null;
    const freshToken = await getAccessToken();
    res = await postLead(freshToken, payload);
  }

  if (!res.ok) {
    const text = await res.text();
    // Stellantis "Lead_Duplicate_Rule" returns HTTP 400 with a duplicateResult
    // body when a matching lead (same phone / email) already exists. From the
    // customer's point of view their data IS in the CRM — a commercial sees
    // the existing record either way. Treat the duplicate as SUCCESS so the
    // agent never tells the customer "un problème technique" for a booking
    // that effectively went through. Only genuine errors throw.
    if (res.status === 400 && isDuplicateError(text)) {
      console.log(
        `[salesforce/lead] ◷ duplicate detected — lead already in CRM, treating as success`
      );
      return { id: "duplicate-existing-lead", success: true, errors: [] };
    }
    console.error(`[salesforce/lead] ✗ ${res.status} ${text.slice(0, 400)}`);
    throw new Error(`Salesforce lead creation failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as SalesforceCreateResponse;
  console.log(`[salesforce/lead] ✓ created id=${json.id} success=${json.success}`);
  return json;
}

/** True when a Salesforce 400 body is a duplicate-rule rejection (Lead OR
 *  Case). The customer's data is effectively in the CRM in that case, so we
 *  treat it as a success rather than surfacing a technical error. */
function isDuplicateError(body: string): boolean {
  return /DUPLICATES_DETECTED|duplicateRule|duplicateResult|Duplicate\s*Rule|Lead\s*Duplicate|Case\s*Duplicate/i.test(body);
}

// ─── Jeep test-drive helpers ──────────────────────────────────────────────

const JEEP_MODEL_LABELS: Record<string, string> = {
  avenger: "Avenger",
  compass: "Compass",
  "compass-hybrid": "Compass Hybrid",
  "grand-cherokee": "Grand Cherokee",
  renegade: "Renegade",
  "renegade-hybrid": "Renegade Hybrid",
  wrangler: "Wrangler",
};

// Country-code → expected total phone length (per Stellantis validation rules).
const PHONE_LENGTH_BY_PREFIX: Record<string, number> = {
  "+212": 13,
  "+34": 12,
  "+33": 12,
  "+39": 13,
  "+971": 15,
  "+966": 15,
};

/**
 * Normalize a Moroccan-or-international phone string into the +CC format
 * Stellantis CRM validates against. Defaults country code to +212.
 */
export function normalizePhone(raw: string, defaultPrefix = "+212"): string {
  const trimmed = raw.trim();
  let digits = trimmed.replace(/[^\d+]/g, "");

  if (digits.startsWith("00")) digits = "+" + digits.slice(2);

  let prefix = defaultPrefix;
  let local = digits;

  if (digits.startsWith("+")) {
    const match = Object.keys(PHONE_LENGTH_BY_PREFIX).find((p) => digits.startsWith(p));
    if (match) {
      prefix = match;
      local = digits.slice(match.length);
    } else {
      return digits;
    }
  } else if (digits.startsWith("0")) {
    local = digits.slice(1);
  }

  return prefix + local.replace(/\D/g, "");
}

export type JeepTestDriveInput = {
  firstName: string;
  lastName?: string;
  phone: string;
  email?: string;
  city?: string;
  modelSlug?: string;
  preferredSlot?: string;
  showroom?: string;
  conversationId?: string;
  /** Optional override; defaults to "Demande de Test Drive". */
  ticketType?: string;
  /** Optional override; defaults to "Avito". Must be a Salesforce-allowed picklist value. */
  leadSource?: string;
};

export function buildJeepLead(input: JeepTestDriveInput): LeadPayload {
  const recordTypeId =
    process.env.SF_RECORD_TYPE_PARTICULIER ?? "0128d000000DtwFAAS";

  const modelLabel = input.modelSlug
    ? JEEP_MODEL_LABELS[input.modelSlug] ?? input.modelSlug
    : "";

  const descriptionLines = [
    `Source: Chatbot (Jeep Maroc demo)`,
    input.preferredSlot ? `Créneau préféré: ${input.preferredSlot}` : null,
    input.modelSlug ? `Modèle: ${modelLabel}` : null,
    input.conversationId ? `Conversation ID: ${input.conversationId}` : null,
  ].filter(Boolean) as string[];

  return {
    Salutation: "Mr.",
    FirstName: input.firstName,
    LastName: input.lastName?.trim() || "(non communiqué)",
    MobilePhone: normalizePhone(input.phone),
    Email: input.email?.trim() || "",
    Marque_interet_FB__c: "Jeep",
    Modele_d_interet_Text__c: modelLabel,
    Showroom_Text__c: input.showroom?.trim() || input.city?.trim() || "",
    City: input.city?.trim() || "",
    LeadSource: input.leadSource ?? "chatbot",
    is_Web__c: true,
    Ticket_type__c: input.ticketType ?? "Demande de Test Drive",
    Description: descriptionLines.join("\n"),
    RecordTypeId: recordTypeId,
  };
}

export async function submitJeepTestDriveLead(
  input: JeepTestDriveInput
): Promise<SalesforceCreateResponse> {
  return createLead(buildJeepLead(input));
}

// ─── Jeep APV (Case) helpers ──────────────────────────────────────────────
//
// SAV flow (Service Après-Vente). Per Stellantis API doc, after-sales tickets
// are POSTed to the Case object (not Lead). We collect every field from the
// customer in-conversation — there is NO VIN lookup / pre-fill on this path.

// NOTE on naming — the NBS doc and the live Stellantis Case sobject are out
// of sync. So far the live org has rejected, with INVALID_FIELD:
//   - Salutation__c  (and the standard Salutation)
//   - Lead_Type__c
// Each rejection means the field isn't provisioned on Case in this Salesforce
// org. We drop them as they fail and document the gap; restoring them later
// requires the NBS admin team to add the columns. The Particulier/Professionnel
// distinction (formerly Lead_Type__c) is stuffed into the Description for now.
export interface CasePayload {
  SuppliedName: string;
  SuppliedPhone: string;
  SuppliedEmail: string;
  Ville__c: string;
  Marque_interet_FB__c: string;
  Modele_d_interet_Text__c: string;
  Showroom_FB__c: string;
  Description: string;
  is_Web__c: boolean;
  Type: "Infos" | "Devis commercial" | "Demande de Test Drive" | "Prise de RDV" | "Réclamation";
  RecordTypeId?: string;
  Numero_de_chassis__c: string;
  Date_de_RDV__c?: string;
}

async function postCase(token: string, payload: CasePayload): Promise<Response> {
  return fetch(SF_CASE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Sforce-Duplicate-Rule-Header": "allowSave=true",
    },
    body: JSON.stringify(payload),
  });
}

export async function createCase(payload: CasePayload): Promise<SalesforceCreateResponse> {
  const token = await getAccessToken();
  let res = await postCase(token, payload);

  if (res.status === 401) {
    cachedToken = null;
    const freshToken = await getAccessToken();
    res = await postCase(freshToken, payload);
  }

  if (!res.ok) {
    const text = await res.text();
    // Same duplicate-as-success handling as createLead — a Case the CRM
    // flags as a duplicate is effectively registered; never surface it as a
    // technical error to the customer.
    if (res.status === 400 && isDuplicateError(text)) {
      console.log(
        `[salesforce/case] ◷ duplicate detected — case already in CRM, treating as success`
      );
      return { id: "duplicate-existing-case", success: true, errors: [] };
    }
    console.error(`[salesforce/case] ✗ ${res.status} ${text.slice(0, 400)}`);
    throw new Error(`Salesforce case creation failed (${res.status}): ${text}`);
  }

  return (await res.json()) as SalesforceCreateResponse;
}

export type ApvInterventionType = "service_rapide" | "mechanical" | "bodywork";

export type JeepApvAppointmentInput = {
  fullName: string;
  phone: string;
  email: string;
  vehicleModel: string;
  vin: string;
  interventionType: ApvInterventionType;
  city: string;
  preferredDate: string;
  preferredSlot: "morning" | "afternoon";
  comment?: string;
  refNumber: string;
  conversationId?: string | null;
};

export type JeepApvComplaintInput = {
  fullName: string;
  phone: string;
  email: string;
  vehicleModel: string;
  vin: string;
  interventionType: ApvInterventionType;
  site: string;
  serviceDate?: string | null;
  reason: string;
  attachmentUrl?: string;
  refNumber: string;
  conversationId?: string | null;
};

function interventionLabel(t: ApvInterventionType): string {
  if (t === "bodywork") return "Carrosserie";
  if (t === "service_rapide") return "Service Rapide";
  return "Mécanique";
}

function modelLabelFromSlug(slug: string): string {
  return JEEP_MODEL_LABELS[slug] ?? slug;
}

// Stellantis Salesforce stores Date_de_RDV__c as a DateTime field, not a Date —
// it rejects bare YYYY-MM-DD with a misleading "field-level security" error
// (confirmed by NBS, May 2026). We combine the customer-chosen date with a
// representative time per slot and emit ISO 8601 in UTC.
//   morning   → 09:00 UTC ≈ 10:00 Casablanca
//   afternoon → 14:00 UTC ≈ 15:00 Casablanca
//
// Defensive: only emit the datetime if `date` strictly matches YYYY-MM-DD with
// a 4-digit year. The agent has been observed hallucinating malformed years
// like "y009-05-31"; if the upstream validator misses it, fall back to
// tomorrow rather than crash Salesforce with a JSON_PARSER_ERROR.
function toAppointmentDateTime(date: string, slot: "morning" | "afternoon"): string {
  const hour = slot === "afternoon" ? "14" : "09";
  const safe = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? date
    : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (safe !== date) {
    console.warn(
      `[salesforce/case] malformed preferredDate "${date}" — falling back to ${safe}`
    );
  }
  return `${safe}T${hour}:00:00.000Z`;
}

export function buildJeepApvAppointmentCase(input: JeepApvAppointmentInput): CasePayload {
  const fullName = input.fullName.trim() || "(non communiqué)";
  const interventionFr = interventionLabel(input.interventionType);
  const slotFr = input.preferredSlot === "afternoon" ? "Après-midi" : "Matin";

  const description = [
    `Source : Chatbot (Jeep Maroc — APV)`,
    `Référence interne : ${input.refNumber}`,
    `Type d'intervention : ${interventionFr}`,
    `Créneau préféré : ${slotFr}`,
    input.comment ? `Commentaire client : ${input.comment}` : null,
    input.conversationId ? `Conversation ID : ${input.conversationId}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    SuppliedName: fullName,
    SuppliedPhone: normalizePhone(input.phone),
    SuppliedEmail: input.email.trim(),
    Ville__c: input.city.trim(),
    Marque_interet_FB__c: "Jeep",
    Modele_d_interet_Text__c: modelLabelFromSlug(input.vehicleModel),
    Showroom_FB__c: input.city.trim(),
    Description: description,
    is_Web__c: true,
    Type: "Prise de RDV",
    RecordTypeId: RECORD_TYPE_RDV_SAV,
    Numero_de_chassis__c: input.vin.trim().toUpperCase(),
    Date_de_RDV__c: toAppointmentDateTime(input.preferredDate, input.preferredSlot),
  };
}

export function buildJeepApvComplaintCase(input: JeepApvComplaintInput): CasePayload {
  const fullName = input.fullName.trim() || "(non communiqué)";
  const interventionFr = interventionLabel(input.interventionType);

  const description = [
    `Source : Chatbot (Jeep Maroc — Réclamation)`,
    `Référence interne : ${input.refNumber}`,
    `Type d'intervention : ${interventionFr}`,
    input.serviceDate ? `Date de la prestation : ${input.serviceDate}` : null,
    `Motif : ${input.reason}`,
    input.attachmentUrl ? `Pièce jointe : ${input.attachmentUrl}` : null,
    input.conversationId ? `Conversation ID : ${input.conversationId}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    SuppliedName: fullName,
    SuppliedPhone: normalizePhone(input.phone),
    SuppliedEmail: input.email.trim(),
    Ville__c: input.site.trim(),
    Marque_interet_FB__c: "Jeep",
    Modele_d_interet_Text__c: modelLabelFromSlug(input.vehicleModel),
    Showroom_FB__c: input.site.trim(),
    Description: description,
    is_Web__c: true,
    Type: "Réclamation",
    RecordTypeId: RECORD_TYPE_RECLAMATION_SAV,
    Numero_de_chassis__c: input.vin.trim().toUpperCase(),
  };
}

export async function submitJeepApvAppointment(
  input: JeepApvAppointmentInput
): Promise<{ payload: CasePayload; response: SalesforceCreateResponse }> {
  const payload = buildJeepApvAppointmentCase(input);
  const response = await createCase(payload);
  return { payload, response };
}

export async function submitJeepApvComplaint(
  input: JeepApvComplaintInput
): Promise<{ payload: CasePayload; response: SalesforceCreateResponse }> {
  const payload = buildJeepApvComplaintCase(input);
  const response = await createCase(payload);
  return { payload, response };
}

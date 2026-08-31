import { NextRequest, after } from "next/server";
import { GoogleGenAI, Type, type Tool, type Content } from "@google/genai";
import Anthropic from "@anthropic-ai/sdk";
import { RIHLA_MODELS, buildSystemPrompt, type BrandContext } from "@citroen-store/rihla-agent";
import { getBrandContext, toAgentContext } from "@/lib/brand-context";
import {
  createConversation,
  appendUserMessage,
  appendAssistantMessage,
  recordToolCall,
  updateFunnelCheckpoints,
  captureLeadFromBooking,
  createServiceAppointment,
  createComplaint,
  closeConversation,
} from "@/lib/persistence";
import { validatePhone, normalizePhone } from "@/lib/phone";
import { validateEmail } from "@/lib/email";
import { validateVin, normalizeVin } from "@/lib/vin";
import { validateAppointmentDate, validateServiceDate } from "@/lib/dates";
import { composeJeepPrompt, classifyIntent } from "@/lib/jeep-prompt";
import { nextRefNumber } from "@/lib/reference-number";
import { adminClient } from "@/lib/supabase/admin";
import { persistAppointment, persistComplaint } from "@/lib/apv-persistence";
import type { Locale } from "@/lib/supabase/database.types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ChatMessage = { role: "user" | "assistant"; content: string };

type LocaleKey = "fr" | "ar" | "darija" | "en";

/** What we believe has already been collected — derived from the message
 *  history by `extractFlowState`. Used by the silent-stall recovery to
 *  figure out which field to ask for next instead of falling back to a
 *  generic "comment puis-je vous aider ?" line. */
type FlowState = {
  firstName?: string;
  phone?: string;
  email?: string;
  vin?: string;
  city?: string;
  maison?: string;
  model?: string;
  intervention?: "service_rapide" | "mechanical" | "bodywork";
};

const COVERED_CITY_NORMALISERS: Array<[RegExp, string]> = [
  [/\b(casa(blanca)?|الدار\s*البيضاء|كازا(بلانكا)?)\b/i, "Casablanca"],
  [/\b(marrak[ée]ch|marrakesh|مراكش)\b/i, "Marrakech"],
  [/\b(rabat|الرباط)\b/i, "Rabat"],
  [/\b(tang[ei]r|tangier|طنجة)\b/i, "Tanger"],
  [/\b(agadir|أكادير|اكادير|اڭادير)\b/i, "Agadir"],
  [/\b(f[èe]s|fez|فاس)\b/i, "Fès"],
  [/\b(k[ée]nitra|kenitra|القنيطرة|قنيطرة)\b/i, "Kénitra"],
  [/\b(oujda|وجدة)\b/i, "Oujda"],
];

function matchCoveredCity(raw: string): string | null {
  const t = raw.trim().toLowerCase().replace(/[!?.,;]+$/g, "");
  if (!t) return null;
  for (const [re, name] of COVERED_CITY_NORMALISERS) if (re.test(t)) return name;
  return null;
}

function extractFlowState(messages: ChatMessage[]): FlowState {
  const state: FlowState = {};
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const text = msg.content?.replace(/^\s*\[FIELD_TYPED\]\s*/i, "").trim() ?? "";
    if (!text) continue;

    if (msg.role === "user") {
      // [MAISON_SELECTED] marker is canonical maison choice.
      const maisonMatch = msg.content.match(/^\s*\[MAISON_SELECTED\]\s*(.+)$/i);
      if (maisonMatch) state.maison = (maisonMatch[1] ?? "").trim();

      // Phone — Moroccan format
      if (!state.phone) {
        const compact = text.replace(/[\s.-]/g, "");
        if (/^(0[67]\d{8}|\+212[67]\d{8})$/.test(compact)) state.phone = compact;
      }

      // Email
      if (!state.email) {
        const m = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
        if (m) state.email = m[0];
      }

      // VIN — 17 alphanumeric. Stricter check: must look unambiguous.
      if (!state.vin) {
        const compact = text.replace(/\s+/g, "");
        if (/^[a-zA-Z0-9]{17}$/.test(compact) && /[A-Za-z]/.test(compact) && /\d/.test(compact)) {
          state.vin = compact.toUpperCase();
        }
      }

      // City
      if (!state.city) {
        const c = matchCoveredCity(text);
        if (c) state.city = c;
      }

      // Model — explicit Jeep slug mentions in user text.
      if (!state.model) {
        if (/\bavenger\b/i.test(text)) state.model = "avenger";
        else if (/\bcompass\b/i.test(text)) state.model = "compass";
        else if (/\bwrangler\b/i.test(text)) state.model = "wrangler";
        else if (/\bgrand[\s-]cherokee\b/i.test(text)) state.model = "grand-cherokee";
        else if (/\brenegade\b/i.test(text)) state.model = "renegade";
      }

      // Intervention type
      if (!state.intervention) {
        if (/\b(vidange|r[ée]vision|entretien|service\s+rapide|pneus?|freins?|filtre|10\s*000\s*km|20\s*000\s*km|batterie)\b|زيت|صيانة|بنوات|فرام/i.test(text)) state.intervention = "service_rapide";
        else if (/\b(panne|voyant|moteur|bo[îi]te|embrayage|fuite|d[ée]marrage|ne\s+d[ée]marre)\b|خسرت|خسرتس|ما\s*خدامش|سكتات/i.test(text)) state.intervention = "mechanical";
        else if (/\b(accident|choc|rayure|peinture|carrosserie|bosse|pare[-\s]?choc)\b|حادثة|ضربة|خربوش|صباغة/i.test(text)) state.intervention = "bodywork";
      }

      // First name — accept the reply only if the previous assistant turn
      // explicitly asked for the name and the reply is a plausible name
      // token (not an email, not a phone, not a VIN).
      if (!state.firstName) {
        let prevAssistant = "";
        for (let j = i - 1; j >= 0; j--) {
          if (messages[j]!.role === "assistant") {
            prevAssistant = messages[j]!.content;
            break;
          }
        }
        // Match every shape the agent uses to ask for the name — "votre
        // prénom", "votre nom et prénom", "votre nom de famille", "votre nom
        // complet", "votre nom", plus EN/AR variants. The narrow "prénom"-only
        // pattern missed "Tapez votre nom et prénom", so the name was never
        // captured and the model kept re-asking it.
        const askedName = /(votre\s+(pr[ée]nom|nom(\s+(et\s+pr[ée]nom|de\s+famille|complet))?)|tapez\s+votre\s+(pr[ée]nom|nom)|[ée]crivez\s+votre\s+(pr[ée]nom|nom)|your\s+(first\s+|full\s+)?name|type\s+your\s+(first\s+|full\s+)?name|اسمكم(\s+الأول)?|اكتبوا\s+اسمكم|كتب\s+السمية|سميتك|اللقب|الاسم\s+الكامل)/i.test(prevAssistant);
        const looksLikeName = /^[\p{L}\s'-]{2,40}$/u.test(text) && !/@/.test(text);
        if (askedName && looksLikeName) state.firstName = text.split(/\s+/)[0]!;
      }
    }
  }
  return state;
}

/** A hard, per-turn reminder of what's already captured, appended to the system
 *  prompt so the model stops re-asking fields it already has (the "keeps asking
 *  for my name / phone again" bug). Empty when nothing's collected yet. */
function buildCollectedFieldsBlock(state: FlowState): string {
  const have: string[] = [];
  if (state.firstName) have.push(`first name = "${state.firstName}"`);
  if (state.phone) have.push(`mobile = "${state.phone}"`);
  if (state.email) have.push(`email = "${state.email}"`);
  if (state.vin) have.push(`VIN = "${state.vin}"`);
  if (state.model) have.push(`model = "${state.model}"`);
  if (state.city) have.push(`city = "${state.city}"`);
  if (state.maison) have.push(`showroom = "${state.maison}"`);
  if (state.intervention) have.push(`intervention = "${state.intervention}"`);
  if (have.length === 0) return "";
  const nameLine = state.firstName
    ? ` The customer's name is "${state.firstName}" — address them by it; NEVER ask for "prénom", "nom", "nom de famille" or "nom complet" again.`
    : "";
  return `\n\n═══ ALREADY COLLECTED — DO NOT ASK AGAIN ═══\nThese fields are ALREADY captured from this conversation. Do NOT re-request any of them (no request_input, no "tapez votre…"). Use them as-is and advance to the NEXT missing field, then the CNDP recap:\n${have.map((h) => `  • ${h}`).join("\n")}.${nameLine}`;
}

type RecoveryStep =
  | { kind: "name" | "phone" | "email" | "vin"; requestInput: "name" | "phone" | "email" | "vin"; text: Record<LocaleKey, string> }
  | { kind: "city"; text: Record<LocaleKey, string> }
  | { kind: "maison"; city: string; text: Record<LocaleKey, string> }
  | { kind: "date" | "slot"; text: Record<LocaleKey, string> };

function nextRecoveryStep(state: FlowState, isApv: boolean): RecoveryStep | null {
  const name = state.firstName ?? "";
  const nameSuffix = name ? `, ${name.charAt(0).toUpperCase()}${name.slice(1).toLowerCase()}` : "";

  if (!state.firstName) {
    return {
      kind: "name",
      requestInput: "name",
      text: {
        fr: "Tapez votre prénom pour ouvrir votre dossier.",
        ar: "اكتبوا اسمكم الأول لفتح ملفكم.",
        darija: "كتب السمية ديالك باش نسجل الملف.",
        en: "Type your first name to open your file.",
      },
    };
  }

  if (!state.phone) {
    return {
      kind: "phone",
      requestInput: "phone",
      text: {
        fr: `Enchanté${nameSuffix}. Tapez votre numéro de mobile pour qu'on vous rappelle.`,
        ar: `تشرفت بكم${nameSuffix}. اكتبوا رقم هاتفكم لكي نتمكن من معاودة الاتصال بكم.`,
        darija: `متشرف${nameSuffix}. كتب نمرة الهاتف ديالك باش نعاودو ليك.`,
        en: `Pleasure${nameSuffix}. Type your mobile number so we can call you back.`,
      },
    };
  }

  if (!state.email) {
    return {
      kind: "email",
      requestInput: "email",
      text: {
        fr: "Merci. Tapez votre adresse e-mail pour qu'on vous envoie la confirmation par écrit.",
        ar: "شكرًا. اكتبوا بريدكم الإلكتروني لإرسال التأكيد كتابيًا.",
        darija: "شكرا. كتب الإيميل ديالك باش نصيفطو ليك التأكيد.",
        en: "Thanks. Type your email address so we can send you the confirmation.",
      },
    };
  }

  if (isApv && !state.vin) {
    return {
      kind: "vin",
      requestInput: "vin",
      text: {
        fr: "Le plus simple — prenez votre carte grise en photo, je récupère le châssis automatiquement. Ou tapez les 17 caractères à la main.",
        ar: "الأسهل — التقطوا صورة لـ carte grise ديالكم وسأقرأ رقم الشاسيه تلقائيًا. أو اكتبوا الـ 17 حرفًا يدويًا.",
        darija: "الأحسن صوّر carte grise ديالك و أنا غادي نقرا 17 حرف وحدي. ولا كتبهم بلْيد.",
        en: "The easiest way — snap a photo of your carte grise and I'll read the VIN automatically. Or type the 17 characters by hand.",
      },
    };
  }

  if (!state.city) {
    return {
      kind: "city",
      text: isApv
        ? {
            fr: "Très bien. Dans quelle ville préférez-vous votre rendez-vous ?",
            ar: "ممتاز. في أي مدينة تفضّلون رنديڤو ؟",
            darija: "مزيان. ف أي ville تفضل تجي ل la maison ؟",
            en: "Great. Which city would you like the appointment in?",
          }
        : {
            fr: "Très bien. Dans quelle ville préférez-vous l'essai routier ?",
            ar: "ممتاز. في أي مدينة تفضّلون القيام بتجربة القيادة ؟",
            darija: "مزيان. ف أي ville تفضل تجي ل la maison ؟",
            en: "Great. Which city would you like the test drive in?",
          },
    };
  }

  if (!state.maison) {
    const c = state.city;
    return {
      kind: "maison",
      city: c,
      text: {
        fr: `Voici les maisons à ${c}. Laquelle vous arrange ?`,
        ar: `إليكم la maison Jeep في ${c}. أي واحدة تناسبكم ؟`,
        darija: `هاو la maison Jeep ف ${c}. شمن واحدة تناسبك ؟`,
        en: `Here are the maisons in ${c}. Which one works for you?`,
      },
    };
  }

  if (isApv) {
    return {
      kind: "date",
      text: {
        fr: "Parfait. Quelle date vous arrangerait pour passer ?",
        ar: "ممتاز. أي يوم يناسبكم للمرور ؟",
        darija: "مزيان. شمن نهار يناسبك تجي ؟",
        en: "Great. What day works best for you to come in?",
      },
    };
  }

  return {
    kind: "slot",
    text: {
      fr: "Samedi matin ou un soir en semaine ?",
      ar: "يوم السبت صباحًا أم مساءً في الأسبوع ؟",
      darija: "السبت صباحًا ولا شي مساء ف الأسبوع ؟",
      en: "Saturday morning or a weekday evening?",
    },
  };
}

/** Compact memory of side-effects already produced THIS session — fed back
 *  into the system prompt so the model knows what's on screen and what
 *  questions have already been asked. The only piece of in-session context
 *  the model otherwise can't see (the API only carries text history). */
type SessionContext = {
  shownModels?: string[];     // model slugs whose image card is on screen
  shownVideos?: string[];     // model slugs whose video card is on screen
  searchedCities?: string[];  // cities already passed to find_showrooms
  collected?: {
    intent?: "test_drive" | "showroom" | "info" | "undecided";
    firstName?: string;
    phone?: string;
    city?: string;
    preferredSlot?: string;
  };
};

type ChatRequest = {
  /** Required for widget mode — the brand whose prompt + catalog to use. */
  brandSlug?: string;
  /** Conversation id for persistence. If absent, server creates a new one. */
  conversationId?: string;
  locale?: "fr" | "ar" | "darija" | "en" | "ar-SA" | "en-SA";
  messages: ChatMessage[];
  dealerCityHint?: string;
  returningUser?: boolean;
  sessionSummary?: string;
  pageContext?: { path: string; modelSlug?: string };
  /** Voice mode → plain text only, short sentences, no markdown. */
  voice?: boolean;
  /** Compact summary of side-effects already on screen — see SessionContext. */
  sessionContext?: SessionContext;
};

const FALLBACK_BY_LOCALE = {
  fr: "Je suis Rihla. Vous cherchez une voiture pour la ville, la famille, ou un usage précis ?",
  ar: "أنا رحلة. هل تبحثون عن سيارة للمدينة، للعائلة، أم لاستخدام محدد ؟",
  darija: "أنا رحلة. كتقلب على طوموبيل للمدينة، للعائلة، ولا لاستعمال معين ؟",
  en: "I'm Rihla. Are you looking for a car for the city, the family, or a specific use?",
} as const;

function mapLocaleToRihla(l?: string, market?: string): "fr-MA" | "ar-MA" | "darija-MA" | "en-MA" | "ar-SA" | "en-SA" {
  // Saudi market resolves to KSA locales
  if (market === "SA") {
    if (l === "ar" || l === "ar-SA") return "ar-SA";
    return "en-SA";
  }
  if (l === "darija") return "darija-MA";
  if (l === "ar") return "ar-MA";
  if (l === "en") return "en-MA";
  return "fr-MA";
}

/** Minimal brand fallback for legacy citroen-ma calls without brandSlug. */
// Jeep-only deployment: the fallback is Jeep (NARA + Jeep models), NEVER
// Citroën. A wrong fallback was why a Jeep conversation once recommended
// "c3-aircross" with the "Rihla" agent — the brand hadn't resolved and it fell
// back to Citroën. In practice getBrandContext("jeep-ma") (local-first, reads
// jeep-ma.json) supplies the real catalog; this constant is the last resort.
const JEEP_FALLBACK: BrandContext = {
  brandSlug: "jeep-ma",
  brandName: "Jeep Maroc",
  agentName: "NARA",
  market: "MA",
  defaultCurrency: "MAD",
  servedCities: ["Casablanca", "Rabat", "Marrakech", "Tanger", "Fès", "Agadir", "Oujda", "Kénitra"],
  models: [
    { slug: "avenger", name: "Avenger", priceFrom: 271055, currency: "MAD", fuel: "MHEV", seats: 5 },
    { slug: "compass", name: "Compass", priceFrom: 344000, currency: "MAD", fuel: "MHEV", seats: 5 },
    { slug: "wrangler", name: "Wrangler", priceFrom: 870000, currency: "MAD", fuel: "4xe", seats: 5 },
    { slug: "grand-cherokee", name: "Grand Cherokee", priceFrom: 950000, currency: "MAD", fuel: "4xe", seats: 5 },
    { slug: "renegade", name: "Renegade", priceFrom: 280000, currency: "MAD", fuel: "MHEV", seats: 5 },
  ],
};

/* ───────────────────────────── Navigation tools ───────────────────────────── */

/** Gemini function declarations (native format). */
const GEMINI_NAV_TOOLS: Tool[] = [
  {
    functionDeclarations: [
      {
        name: "open_model",
        description:
          "Open a specific model detail page when the user shows interest in one model.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            slug: {
              type: Type.STRING,
              enum: ["avenger", "compass", "wrangler", "grand-cherokee", "renegade"],
            },
          },
          required: ["slug"],
        },
      },
      {
        name: "configure_car",
        description:
          "Update the configurator preview (color, trim, angle). MUST be called when the user asks to change color (بدل اللون, mets en rouge, change color), trim, or viewing angle. If the user is already on a model detail page, use THIS tool — do NOT also call open_model.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            slug: {
              type: Type.STRING,
              enum: ["avenger", "compass", "wrangler", "grand-cherokee", "renegade"],
            },
            color: { type: Type.STRING },
            trim: { type: Type.STRING },
            angle: { type: Type.NUMBER },
          },
        },
      },
      {
        name: "show_model_image",
        description: "Display a photo of a specific model inline in the chat. Call whenever you mention or recommend a model.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            slug: { type: Type.STRING },
            caption: { type: Type.STRING },
          },
          required: ["slug"],
        },
      },
      {
        name: "show_model_video",
        description: "Display a video preview card for a specific model. Call when the user asks for a video, walk-around, review, or wants to see the car in motion. The card opens YouTube search results for that model in a new tab.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            slug: { type: Type.STRING },
            caption: { type: Type.STRING },
          },
          required: ["slug"],
        },
      },
      {
        name: "open_brand_page",
        description: "Open the official brand-site page for a model in a new browser tab.",
        parameters: {
          type: Type.OBJECT,
          properties: { slug: { type: Type.STRING } },
          required: ["slug"],
        },
      },
      {
        name: "book_test_drive",
        description:
          "Book a TEST DRIVE for a qualified lead (user wants to drive the car). Call at the end of the flow once you have first name, mobile number, email (ask for it — clients have flagged this), city, preferred slot, AND ideally the showroom they picked from the find_showrooms list.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            slug: { type: Type.STRING },
            firstName: { type: Type.STRING },
            phone: { type: Type.STRING },
            email: { type: Type.STRING, description: "Customer email — collected after phone. Optional but encouraged: ask once, accept if customer refuses." },
            city: { type: Type.STRING },
            preferredSlot: { type: Type.STRING },
            showroomName: { type: Type.STRING, description: "The exact showroom name the customer chose (e.g. 'Peugeot Riyadh — King Fahd Rd'). Pass through verbatim from the find_showrooms list." },
          },
          required: ["slug", "firstName", "phone"],
        },
      },
      {
        name: "book_showroom_visit",
        description:
          "Schedule a SHOWROOM VISIT (user wants to come see the cars in person, not test-drive). Call after collecting first name, phone, email (optional), city, preferred slot, and the showroom they picked.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            slug: { type: Type.STRING },
            firstName: { type: Type.STRING },
            phone: { type: Type.STRING },
            email: { type: Type.STRING, description: "Customer email — collected after phone. Optional but encouraged." },
            city: { type: Type.STRING },
            preferredSlot: { type: Type.STRING },
            showroomName: { type: Type.STRING, description: "The exact showroom name the customer chose. Pass through verbatim from the find_showrooms list." },
          },
          required: ["firstName", "phone"],
        },
      },
      {
        name: "find_showrooms",
        description:
          "List nearby showrooms / dealers. CALL THIS whenever the user names a city ('I'm in Riyadh', 'Casablanca', 'Jeddah') or asks where to visit / where the dealer is. Renders a card list with addresses, phones, hours. After calling, briefly summarize the result.",
        parameters: {
          type: Type.OBJECT,
          properties: { city: { type: Type.STRING } },
        },
      },
      {
        name: "end_call",
        description:
          "End the conversation. Call this IMMEDIATELY after your farewell phrase when: (1) a booking is confirmed, (2) the user EXPLICITLY says goodbye in any language ('bye', 'au revoir', 'مع السلامة', 'بسلامة'), or (3) the user clearly refuses to continue twice. DO NOT call end_call on a bare 'thanks' or 'merci' — the user is just being polite, keep going.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "request_input",
        description:
          "Open the on-screen keyboard so the customer can TYPE a sensitive field (name / phone / email / VIN). Call this on the SAME turn as your text instruction — never on its own. For VIN, this also surfaces the carte-grise camera + upload buttons. Voice mode REQUIRES this tool whenever you ask for one of those 4 fields (voice dictation is refused for them).",
        parameters: {
          type: Type.OBJECT,
          properties: {
            field: { type: Type.STRING, enum: ["name", "phone", "email", "vin"], description: "Which keyboard layout to open." },
          },
          required: ["field"],
        },
      },
      // ─── APV (after-sales) — Jeep widget only. Never invoke for other brands. ───
      // VIN lookup is done SERVER-SIDE via regex pre-extraction on the user's
      // message — when a VIN is present, the result is injected into the
      // system prompt as a VIN PREFILL block. The model never calls a
      // lookup tool, which keeps the turn loop simple and avoids the
      // "model emits tool call, waits for a response that never arrives"
      // hang we saw in QA.
      {
        name: "book_service_appointment",
        description: "APV ONLY. Submit a service-appointment (RDV) request once you've collected ALL required fields and the customer has explicitly given CNDP consent. Server validates everything, persists the row, and returns a reference number you announce to the customer.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            fullName: { type: Type.STRING, description: "Full name (first + last). Min 2 words, 3-80 chars." },
            phone: { type: Type.STRING, description: "Mobile, MA format. We normalize server-side." },
            email: { type: Type.STRING, description: "Standard email format." },
            vehicleBrand: { type: Type.STRING, description: "One of: Peugeot, Citroën, Jeep, Alfa Romeo, DS, Fiat, Leapmotor, Spoticar." },
            vehicleModel: { type: Type.STRING, description: "Model name." },
            vin: { type: Type.STRING, description: "17 alphanumeric characters (A-Z, 0-9). Accept the value as printed on the carte grise — no forbidden-letter rule." },
            interventionType: { type: Type.STRING, enum: ["service_rapide", "mechanical", "bodywork"], description: "service_rapide = entretien courant (vidange, freins, pneus, batterie, révision); mechanical = panne mécanique; bodywork = carrosserie." },
            city: { type: Type.STRING, description: "City for the appointment." },
            preferredDate: { type: Type.STRING, description: "ISO yyyy-mm-dd OR DD/MM/YYYY. Must be J+1 to J+30, no Sundays / public holidays." },
            preferredSlot: { type: Type.STRING, enum: ["morning", "afternoon"] },
            comment: { type: Type.STRING, description: "Optional free-text comment (symptom, context). Max 500 chars." },
            cndpConsent: { type: Type.BOOLEAN, description: "MUST be true. Set after the customer explicitly accepted the CNDP consent statement." },
          },
          required: ["fullName", "phone", "email", "vehicleBrand", "vehicleModel", "vin", "interventionType", "city", "preferredDate", "preferredSlot", "cndpConsent"],
        },
      },
      {
        name: "submit_complaint",
        description: "APV ONLY. Submit a complaint (réclamation) once all required fields are collected and CNDP consent is given. Server validates, persists, returns ticket reference. The CRC will then qualify and route to the concerned site.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            fullName: { type: Type.STRING },
            phone: { type: Type.STRING },
            email: { type: Type.STRING },
            vehicleBrand: { type: Type.STRING },
            vehicleModel: { type: Type.STRING },
            vin: { type: Type.STRING },
            interventionType: { type: Type.STRING, enum: ["service_rapide", "mechanical", "bodywork"] },
            site: { type: Type.STRING, description: "Atelier / city where the complained-about intervention happened." },
            serviceDate: { type: Type.STRING, description: "Optional. ISO date or DD/MM/YYYY of the original intervention. Must be ≤ today and ≥ today-180 days." },
            reason: { type: Type.STRING, description: "Free-text complaint reason. 20-1000 characters required." },
            attachmentUrl: { type: Type.STRING, description: "Optional. URL to a customer-uploaded photo / PDF." },
            cndpConsent: { type: Type.BOOLEAN, description: "MUST be true. Set after the customer explicitly accepted the CNDP consent statement." },
          },
          required: ["fullName", "phone", "email", "vehicleBrand", "vehicleModel", "vin", "interventionType", "site", "reason", "cndpConsent"],
        },
      },
    ],
  },
];

/** Anthropic tool schemas (fallback path). */
const ANTHROPIC_NAV_TOOLS: Anthropic.Messages.Tool[] = [
  { name: "open_model", description: "Open a model detail page.", input_schema: { type: "object" as const, properties: { slug: { type: "string" as const, enum: ["avenger", "compass", "wrangler", "grand-cherokee", "renegade"] } }, required: ["slug"] } },
  { name: "configure_car", description: "Update configurator on the CURRENT page without reloading.", input_schema: { type: "object" as const, properties: { slug: { type: "string" as const }, color: { type: "string" as const }, trim: { type: "string" as const }, angle: { type: "number" as const } }, required: [] } },
  { name: "show_model_image", description: "Display a photo of a specific model inline in the chat.", input_schema: { type: "object" as const, properties: { slug: { type: "string" as const }, caption: { type: "string" as const } }, required: ["slug"] } },
  { name: "show_model_video", description: "Display a video preview card (opens YouTube in a new tab) for a model. Use when the user asks for a video, walk-around, or review.", input_schema: { type: "object" as const, properties: { slug: { type: "string" as const }, caption: { type: "string" as const } }, required: ["slug"] } },
  { name: "open_brand_page", description: "Open the official brand-site page for a model in a new browser tab.", input_schema: { type: "object" as const, properties: { slug: { type: "string" as const } }, required: ["slug"] } },
  { name: "book_test_drive", description: "Book a test drive once you have firstName + phone (+ email if customer provided one) + city + slot. Pass showroomName when the customer chose a specific showroom from the find_showrooms list.", input_schema: { type: "object" as const, properties: { slug: { type: "string" as const }, firstName: { type: "string" as const }, phone: { type: "string" as const }, email: { type: "string" as const }, city: { type: "string" as const }, preferredSlot: { type: "string" as const }, showroomName: { type: "string" as const } }, required: ["slug", "firstName", "phone"] } },
  { name: "book_showroom_visit", description: "Schedule a showroom visit (user wants to see cars in person). Pass showroomName when the customer chose one. Optional email.", input_schema: { type: "object" as const, properties: { slug: { type: "string" as const }, firstName: { type: "string" as const }, phone: { type: "string" as const }, email: { type: "string" as const }, city: { type: "string" as const }, preferredSlot: { type: "string" as const }, showroomName: { type: "string" as const } }, required: ["firstName", "phone"] } },
  { name: "find_showrooms", description: "List nearby showrooms when the user names a city or asks where to visit. Renders cards with addresses + phones.", input_schema: { type: "object" as const, properties: { city: { type: "string" as const } }, required: [] } },
  { name: "end_call", description: "End the conversation right after a farewell phrase. DO NOT call on a bare 'thanks' — only on explicit goodbye phrases.", input_schema: { type: "object" as const, properties: {}, required: [] } },
  { name: "request_input", description: "Open the on-screen keyboard so the customer can type a sensitive field. Call on the SAME turn as your text instruction. For VIN, also surfaces carte-grise camera + upload buttons.", input_schema: { type: "object" as const, properties: { field: { type: "string" as const, enum: ["name", "phone", "email", "vin"] } }, required: ["field"] } },
  // APV — Jeep widget only. (VIN lookup is server-side; no tool needed.)
  { name: "book_service_appointment", description: "APV ONLY. Submit a service-appointment after all fields collected + CNDP consent.", input_schema: { type: "object" as const, properties: { fullName: { type: "string" as const }, phone: { type: "string" as const }, email: { type: "string" as const }, vehicleBrand: { type: "string" as const }, vehicleModel: { type: "string" as const }, vin: { type: "string" as const }, interventionType: { type: "string" as const, enum: ["service_rapide", "mechanical", "bodywork"] }, city: { type: "string" as const }, preferredDate: { type: "string" as const }, preferredSlot: { type: "string" as const, enum: ["morning", "afternoon"] }, comment: { type: "string" as const }, cndpConsent: { type: "boolean" as const } }, required: ["fullName", "phone", "email", "vehicleBrand", "vehicleModel", "vin", "interventionType", "city", "preferredDate", "preferredSlot", "cndpConsent"] } },
  { name: "submit_complaint", description: "APV ONLY. Submit a complaint after fields collected + CNDP consent. vin / vehicleModel / interventionType are OPTIONAL — only fill them for a complaint about a vehicle or a service/repair; OMIT them for a complaint about staff behaviour, reception, pricing, or wait time.", input_schema: { type: "object" as const, properties: { fullName: { type: "string" as const }, phone: { type: "string" as const }, email: { type: "string" as const }, vehicleBrand: { type: "string" as const }, vehicleModel: { type: "string" as const }, vin: { type: "string" as const }, interventionType: { type: "string" as const, enum: ["service_rapide", "mechanical", "bodywork"] }, site: { type: "string" as const }, serviceDate: { type: "string" as const }, reason: { type: "string" as const }, attachmentUrl: { type: "string" as const }, cndpConsent: { type: "boolean" as const } }, required: ["fullName", "phone", "email", "vehicleBrand", "site", "reason", "cndpConsent"] } },
];

/* ─────────────────────────── System prompt build ─────────────────────────── */

function buildPromptSuffix(
  pageContext: ChatRequest["pageContext"],
  voice: boolean
) {
  const parts: string[] = ["", "NAVIGATION + ACTION TOOLS"];
  parts.push(
    "- You have tools to drive the UI. CALL A TOOL whenever the user intent maps to a navigation or configurator change. Do not just describe — act.",
    "- One SHORT sentence of natural-language context BEFORE the tool call.",
    "- If the user is ALREADY on a model detail page, use `configure_car` (not `open_model`) to change color/trim/angle.",
    "- Never mention the words 'tool', 'function', 'API'.",
    "",
    "TOOL CALL EXAMPLES (bilingual — always call the tool, in any language):",
    "- FR: 'Mets-la en rouge' → say 'Je vous la mets en rouge.' then call configure_car(slug='avenger', color='red')",
    "- AR/Darija: 'بدل اللون للحمر' → say 'واخا، غادي نبدلها بالحمر!' then call configure_car(slug='avenger', color='red')",
    "- FR: 'Montre-moi le Compass' → say 'Je vous montre le Compass.' then call open_model(slug='compass')",
    "- AR/Darija: 'بغيت نشوف كومباس' → say 'واخا، هاهو الكومباس!' then call open_model(slug='compass')",
    "- FR: 'Je veux réserver / essayer' → collect the booking fields, then call book_test_drive(...)"
  );
  if (pageContext?.path) parts.push(`- Current page: ${pageContext.path}.`);
  if (pageContext?.modelSlug) parts.push(`- Viewing model: ${pageContext.modelSlug}.`);

  if (voice) {
    parts.push(
      "",
      "VOICE MODE — YOU ARE BEING SPOKEN ALOUD",
      "- ABSOLUTELY NO markdown, NO asterisks **, NO bullet lists, NO emojis, NO hashtags.",
      "- Plain conversational prose, 1 to 2 short sentences per turn (max 20 words each).",
      "- Numbers: spell out currencies and measurements in words.",
      "- Phone numbers: repeat back digit by digit to confirm.",
      "- Do not repeat the user's question verbatim; acknowledge briefly and answer.",
      "- Stick to the language block rules in the system prompt. Do NOT mix languages."
    );
  }
  parts.push(
    "",
    "END OF CONVERSATION",
    "- When the user says goodbye / thanks / bye, or after a booking is confirmed, say ONE warm farewell sentence and immediately call end_call.",
    "- Never continue after a farewell. The end_call tool is the only way to end the session cleanly."
  );
  return parts.join("\n");
}


/* ─────────────────── Fast-path intent detector ───────────────────────── */
// Gemini's tool calling is unreliable in Arabic. This catches common action
// patterns and emits tool calls directly, so the LLM only needs to generate
// the verbal confirmation.

type DetectedIntent = { name: string; input: Record<string, unknown> } | null;

function detectIntent(
  msg: string,
  pageContext?: ChatRequest["pageContext"]
): DetectedIntent {
  const text = msg.toLowerCase().trim();
  const slug = pageContext?.modelSlug;

  // Color change patterns (FR + AR + EN) — broad match, color word anywhere
  const isColorIntent = /(?:mets|change|passe|couleur|color|بدل|لون|بال|بغيت)/i.test(text);
  const colorMatch = isColorIntent
    ? text.match(/(rouge|حمر|أحمر|الحمر|bleu|أزرق|زرق|الزرق|blanc|أبيض|بيض|الأبيض|gris|رمادي|الرمادي|vert|أخضر|خضر|الأخضر|noir|أسود|كحل|الأسود|red|blue|white|grey|gray|green|black)/i)
    : null;
  if (colorMatch && slug) {
    const rawColor = (colorMatch[1] ?? "").replace(/^ال/, "").toLowerCase();
    const colorMap: Record<string, string> = {
      rouge: "red", حمر: "red", أحمر: "red", red: "red",
      bleu: "blue", أزرق: "blue", زرق: "blue", blue: "blue",
      blanc: "white", أبيض: "white", بيض: "white", white: "white",
      gris: "grey", رمادي: "grey", grey: "grey", gray: "grey",
      vert: "green", أخضر: "green", خضر: "green", green: "green",
      noir: "black", أسود: "black", كحل: "black", black: "black",
    };
    return { name: "configure_car", input: { slug, color: colorMap[rawColor] ?? rawColor } };
  }

  // Model open patterns — Jeep range.
  const modelMatch = text.match(/(?:montre|ouvre|بغيت نشوف|ورّيني|show|open).+?(avenger|compass|wrangler|grand.?cherokee|renegade|أفنجر|افنجر|كومباس|رانجلر|رينيجايد|شيروكي)/i);
  if (modelMatch) {
    const raw = (modelMatch[1] ?? "").toLowerCase();
    const matched =
      /cherokee|شيروكي/.test(raw) ? "grand-cherokee"
      : /wrangler|رانجلر/.test(raw) ? "wrangler"
      : /compass|كومباس/.test(raw) ? "compass"
      : /renegade|رينيجايد/.test(raw) ? "renegade"
      : "avenger";
    return { name: "open_model", input: { slug: matched } };
  }

  // NOTE: the old start_reservation fast-path is gone with the tool — a
  // reservation ask now flows through the normal qualification → book_test_drive.

  return null;
}

/* ─────────────────────────── Session memory note ─────────────────────────── */

/** Render the in-session memory as a short authoritative block the model
 *  reads at the top of its system prompt. Replaces the "remember what's
 *  been done" inference the model would otherwise have to make from chat
 *  history (which is unreliable for tool calls — the API doesn't put them
 *  in the message stream that goes back to the model). */
function buildSessionMemoryBlock(ctx?: SessionContext): string {
  if (!ctx) return "";
  const lines: string[] = [];

  const shown = (ctx.shownModels ?? []).filter(Boolean);
  if (shown.length > 0) {
    lines.push(
      `ALREADY ON SCREEN — DO NOT call show_model_image again for: ${shown.join(", ")}. ` +
      `If the customer asks more about these models, talk specs / features / pricing in plain text — the card is already there.`
    );
  }

  const videos = (ctx.shownVideos ?? []).filter(Boolean);
  if (videos.length > 0) {
    lines.push(`VIDEOS ALREADY ON SCREEN — DO NOT call show_model_video again for: ${videos.join(", ")}.`);
  }

  const cities = (ctx.searchedCities ?? []).filter(Boolean);
  if (cities.length > 0) {
    lines.push(`SHOWROOMS ALREADY LISTED for: ${cities.join(", ")}. Don't re-list the same city — speak in plain text instead.`);
  }

  const c = ctx.collected ?? {};
  const filled: string[] = [];
  if (c.intent) filled.push(`intent=${c.intent}`);
  if (c.firstName) filled.push(`name=${c.firstName}`);
  if (c.phone) filled.push(`phone=${c.phone}`);
  if (c.city) filled.push(`city=${c.city}`);
  if (c.preferredSlot) filled.push(`slot=${c.preferredSlot}`);
  if (filled.length > 0) {
    lines.push(`ALREADY COLLECTED — do NOT re-ask: ${filled.join(", ")}.`);
  }

  if (lines.length === 0) return "";
  return [
    "",
    "═══ SESSION MEMORY (authoritative — TRUST this over the chat history) ═══",
    ...lines,
  ].join("\n");
}

/* ─────────────────────────── Stream helpers ─────────────────────────── */

function emit(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  obj: unknown
) {
  controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
}

/* ─────────────────────────── Gemini handler ─────────────────────────── */

// Chat model is env-overridable so prod can move to a stronger/stable model
// (e.g. RIHLA_CHAT_MODEL=gemini-3.1-flash) without a code change. Defaults to
// the current stable model so behaviour is unchanged when the var is unset.
const RIHLA_CHAT_MODEL = process.env.RIHLA_CHAT_MODEL || "gemini-2.5-flash";

async function streamWithGemini(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  systemInstruction: string,
  messages: ChatMessage[],
  options?: {
    /** When set, restricts the model to ONLY these function names — used on
     *  stalled-booking retry so Gemini cannot return empty / text-only. */
    forceFunctionNames?: string[];
  }
) {
  const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });

  const contents: Content[] = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const forced = options?.forceFunctionNames && options.forceFunctionNames.length > 0;
  // FunctionCallingConfigMode enum isn't exported by the @google/genai types;
  // string-literal config is accepted at runtime. The cast keeps the rest of
  // the call shape type-checked.
  const toolConfig = forced
    ? { functionCallingConfig: { mode: "ANY", allowedFunctionNames: options!.forceFunctionNames } }
    : { functionCallingConfig: { mode: "AUTO" } };
  const response = await ai.models.generateContentStream({
    model: RIHLA_CHAT_MODEL,
    contents,
    config: {
      systemInstruction,
      tools: GEMINI_NAV_TOOLS,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolConfig: toolConfig as any,
      temperature: forced ? 0.2 : 0.7,
      // NOTE: thinking is intentionally LEFT ON. Disabling it (thinkingBudget 0)
      // makes gemini-3.5-flash emit tool calls WITHOUT the accompanying text
      // instruction — and sometimes leak a raw args fragment like `"phone"}`
      // into the chat ("type your first name" → bubble shows `"phone"}`). With
      // thinking on, the model reliably emits BOTH the spoken line and the
      // function call. The empty-turn case that motivated disabling it is
      // handled by the retry-on-empty path below instead.
    },
  });

  for await (const chunk of response) {
    const parts = chunk?.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if (typeof part.text === "string" && part.text.length > 0) {
        emit(controller, encoder, { type: "text", text: part.text });
      }
      if (part.functionCall) {
        const name = part.functionCall.name ?? "unknown";
        const input = (part.functionCall.args ?? {}) as Record<string, unknown>;
        emit(controller, encoder, { type: "tool", name, input });
      }
    }
  }
}

/* ─────────────────────────── Anthropic handler (fallback) ─────────────────────────── */

async function streamWithAnthropic(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  systemPrompt: string,
  messages: ChatMessage[]
) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  const stream = client.messages.stream({
    model: RIHLA_MODELS.primary,
    max_tokens: 1024,
    system: systemPrompt,
    tools: ANTHROPIC_NAV_TOOLS,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });

  const toolAccum: Record<number, { name: string; json: string; emitted: boolean }> = {};

  for await (const event of stream) {
    if (event.type === "content_block_start") {
      if (event.content_block.type === "tool_use") {
        toolAccum[event.index] = {
          name: event.content_block.name,
          json: "",
          emitted: false,
        };
      }
    } else if (event.type === "content_block_delta") {
      if (event.delta.type === "text_delta") {
        emit(controller, encoder, { type: "text", text: event.delta.text });
      } else if (event.delta.type === "input_json_delta") {
        const slot = toolAccum[event.index];
        if (slot) slot.json += event.delta.partial_json;
      }
    } else if (event.type === "content_block_stop") {
      const slot = toolAccum[event.index];
      if (slot && !slot.emitted) {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = slot.json ? JSON.parse(slot.json) : {};
        } catch {
          parsed = {};
        }
        emit(controller, encoder, { type: "tool", name: slot.name, input: parsed });
        slot.emitted = true;
      }
    }
  }
}


/* ─────────────────────────── Handler ─────────────────────────── */

export async function POST(req: NextRequest) {
  const body = (await req.json()) as ChatRequest;
  const encoder = new TextEncoder();

  // Load brand context if a brandSlug is provided. Brand context is local-first
  // (bundled JSON + static showrooms), so this no longer needs Supabase env and
  // never blocks on a DB round trip. Falls back to a minimal hard-coded Citroën
  // catalog for legacy calls.
  let brand: BrandContext = JEEP_FALLBACK;
  let customBody: string | undefined;
  // Jeep-only deployment — default the brand to jeep-ma when the client omits
  // it, so the catalog/agent is ALWAYS Jeep (never the Citroën fallback).
  const resolvedSlug = body.brandSlug || "jeep-ma";
  {
    try {
      const ctx = await getBrandContext(resolvedSlug);
      if (ctx) {
        brand = toAgentContext(ctx);
        // jeep-ma's prompt is the modular composition under `lib/jeep-prompt/`;
        // ignore any stale customBody so there's a single source.
        customBody = resolvedSlug === "jeep-ma" ? undefined : (ctx.activePrompt?.body ?? undefined);
      }
    } catch (err) {
      console.warn("[chat] failed to load brand context, using fallback:", (err as Error).message);
    }
  }

  const locale = mapLocaleToRihla(body.locale, brand.market);

  const baseSystem = buildSystemPrompt({
    locale,
    brand,
    customBody,
    dealerCityHint: body.dealerCityHint,
    returningUser: body.returningUser,
    sessionSummary: body.sessionSummary,
  });
  // Jeep prompt — composed per-turn from modular pieces, routed by intent
  // classifier on the message history. Discovery turns load ~6k tokens,
  // narrowing to ~7-8k once the customer commits to a flow.
  const jeepEnabled = brand.brandSlug === "jeep-ma";
  if (!jeepEnabled && body.brandSlug === "jeep-ma") {
    console.warn(`[chat] Jeep prompt expected for jeep-ma but brand context resolved to ${brand.brandSlug} (Supabase miss?).`);
  }
  const todayIso = new Date().toISOString().slice(0, 10);
  const todayHumanFr = new Date().toLocaleDateString("fr-MA", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });

  const jeepOverride = jeepEnabled
    ? composeJeepPrompt({
        todayIso,
        todayHumanFr,
        history: body.messages,
        mode: body.voice ? "voice" : "chat",
      }).prompt
    : "";
  // Explicit per-turn "already collected" state. The model frequently re-asks
  // fields it already has (name asked 2-3×, phone twice, …) because it doesn't
  // reliably track collection across turns. We extract what's captured from the
  // history and hard-tell the model not to ask for it again. This is the
  // reliable fix for the "keeps asking for my name" bug.
  const collectedState = extractFlowState(body.messages);
  const systemPrompt =
    baseSystem +
    buildPromptSuffix(body.pageContext, !!body.voice) +
    buildSessionMemoryBlock(body.sessionContext) +
    jeepOverride +
    buildCollectedFieldsBlock(collectedState);

  const geminiKey = process.env.GOOGLE_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  // Gemini-first: gemini-3.1-flash-lite-preview is fast and cheap, and the
  // tightened prompt + guardrails make it reliable enough for the demo.
  // Claude is the failover only.
  const provider: "gemini" | "anthropic" | "none" = geminiKey
    ? "gemini"
    : anthropicKey
    ? "anthropic"
    : "none";

  if (provider === "none") {
    const fallbackKey = (body.locale ?? "fr").startsWith("ar") ? "ar"
      : (body.locale ?? "fr").startsWith("en") ? "en"
      : body.locale === "darija" ? "darija"
      : "fr";
    const fallback = FALLBACK_BY_LOCALE[fallbackKey as keyof typeof FALLBACK_BY_LOCALE] ?? FALLBACK_BY_LOCALE.fr;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const token of fallback.split(/(\s+)/)) {
          emit(controller, encoder, { type: "text", text: token });
          await new Promise((r) => setTimeout(r, 18));
        }
        emit(controller, encoder, { type: "done" });
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Rihla-Mode": "scaffold-fallback",
      },
    });
  }

  // Fast-path: detect common action intents and emit tool calls before LLM runs.
  const lastUserMsg = [...body.messages].reverse().find((m) => m.role === "user");
  const fastIntent = lastUserMsg
    ? detectIntent(lastUserMsg.content, body.pageContext)
    : null;
  if (fastIntent) {
    console.log("[rihla/chat] fast-path:", fastIntent.name, JSON.stringify(fastIntent.input));
  }

  // Lazily create the conversation row on the first turn. We only persist when
  // we have a brandSlug (widget mode) — legacy storefront calls stay anonymous.
  // Transcript persistence is BACKGROUND (fire-and-forget): the id is generated
  // up front so we can stream the reply immediately and never block the response
  // on a Supabase write. (Removing the awaited writes here is part of taking
  // Supabase fully off the chat hot path.)
  let conversationId: string | null = body.conversationId ?? null;
  if (!conversationId && body.brandSlug) {
    conversationId = globalThis.crypto.randomUUID();
    const cid = conversationId;
    const brandSlug = body.brandSlug;
    const channel = body.voice ? "voice" : "chat";
    const userAgent = req.headers.get("user-agent");
    const userText = lastUserMsg?.content;
    // Create the row, then append the first user turn (ordered so the message's
    // FK to conversations is satisfied). Best-effort; errors are swallowed.
    void (async () => {
      await createConversation({ id: cid, brandSlug, locale: locale as Locale, channel, userAgent });
      if (userText) await appendUserMessage(cid, userText);
    })();
  } else if (conversationId && lastUserMsg) {
    // Existing conversation — log the new user turn in the background.
    void appendUserMessage(conversationId, lastUserMsg.content);
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Tell the client which conversation id to send back next turn.
      if (conversationId) {
        emit(controller, encoder, { type: "conversation", id: conversationId });
      }

      const collectedText: string[] = [];
      const collectedTools: Array<{ name: string; input: Record<string, unknown> }> = [];
      // Indices of tools that were persisted inline inside the stream (so we
      // can show duplicate-aware messages to the customer in real time). The
      // post-stream fire-and-forget block reads this to avoid double-pushing
      // the same lead to Salesforce. Declared up here so both blocks share
      // the reference.
      const inlinePersistedToolIdx = new Set<number>();

      // Server-side tool dedup: track what's been emitted this request +
      // merge with sessionContext (what was already on screen at request
      // start). If the model fires a duplicate show_model_image / video
      // for a slug we've already shown, drop it before the client sees
      // it. Backup defense in case the model ignores SESSION MEMORY.
      // Normalize slugs aggressively (lowercase, alphanumerics only) so
      // "2008", "peugeot-2008", and "Peugeot 2008" all collapse to one key
      // — observed Gemini sometimes drifts on the slug shape.
      const normalizeSlug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      const shownImagesGuard = new Set<string>((body.sessionContext?.shownModels ?? []).map(normalizeSlug));
      const shownVideosGuard = new Set<string>((body.sessionContext?.shownVideos ?? []).map(normalizeSlug));
      // find_showrooms dedup. We want to BLOCK re-rendering the showroom
      // cards once the customer has already tapped "Choisir" on one. The
      // [MAISON_SELECTED] marker is prepended on the wire ONLY on the turn
      // the user clicked Choisir; subsequent turns don't carry it. So we
      // ALSO match the maison name itself in any prior user message —
      // those names (operator + locality) are unique strings unlikely to
      // appear in casual chat. Safety net for when the model ignores the
      // prompt's "do NOT re-call find_showrooms after a pick" rule.
      const MAISON_NAMES_RE = /\b(Italcar\s+Motorvillage|Autohall|Auto\s*Hall|Orbis\s+Automotive|Fenie\s+Brossette|Maniss\s+Auto|Bouskoura|Maârif|Maarif|Bernoussi)\b/i;
      const maisonAlreadySelected = body.messages.some(
        (m) =>
          m.role === "user" &&
          (/^\s*\[MAISON_SELECTED\]/i.test(m.content) || MAISON_NAMES_RE.test(m.content))
      );
      // Also block re-rendering the SAME city that's already in session
      // memory (the parent component pushes city names into searchedCities
      // after find_showrooms emits).
      const searchedCitiesGuard = new Set<string>(
        (body.sessionContext?.searchedCities ?? []).map((c) => c.toLowerCase().trim())
      );

      // CNDP-confirmation turn: the customer just said YES to the consent
      // question. The only correct next output is a booking tool — never a
      // showroom re-list. The model sometimes re-fires find_showrooms here
      // (the "shows the showrooms again after I confirm" bug); the booking
      // still lands via the stalled-booking recovery below, but the customer
      // shouldn't see the cards. We suppress find_showrooms on this turn and
      // let that recovery emit the real confirmation.
      const cndpConfirmTurn = (() => {
        const lastAssistant = [...body.messages].reverse().find((m) => m.role === "assistant");
        if (!lastAssistant || !lastUserMsg) return false;
        const aff = /\b(oui|yes|ok|okay|d['']?accord|je\s+confirme|confirme|j['']?accepte|accepte)\b|نعم|واخا|اوكي|موافق|صافي|تمام/i.test(lastUserMsg.content);
        const neg = /\b(non|no|nope)\b|لا|ماشي/i.test(lastUserMsg.content);
        const cndp = /(09[-\s–]?08|loi\s+09|conform[ée]ment|stellantis\s+maroc|protection\s+des\s+donn[ée]es|vous\s+confirmez|توافقون|الموافقة|البيانات\s+الشخصية|do\s+you\s+confirm|data[-\s]?protection)/i.test(lastAssistant.content);
        return aff && !neg && cndp;
      })();

      // Wrap the controller so we can also (1) accumulate everything for
      // persistence and (2) intercept duplicate UI-card tool emits.
      const tap = new Proxy(controller, {
        get(target, prop) {
          if (prop === "enqueue") {
            return (chunk: Uint8Array) => {
              try {
                const line = new TextDecoder().decode(chunk).trim();
                if (line.startsWith("{")) {
                  const ev = JSON.parse(line) as { type: string; text?: string; name?: string; input?: Record<string, unknown> };

                  // Tool-dedup guard: silently drop second card for the same model.
                  if (ev.type === "tool" && (ev.name === "show_model_image" || ev.name === "show_model_video")) {
                    const rawSlug = String(ev.input?.slug ?? ev.input?.modelSlug ?? "");
                    const slug = normalizeSlug(rawSlug);
                    const guard = ev.name === "show_model_image" ? shownImagesGuard : shownVideosGuard;
                    if (slug && guard.has(slug)) {
                      console.log(`[rihla/chat] suppressed duplicate ${ev.name}(${rawSlug})`);
                      return; // skip enqueue entirely
                    }
                    if (slug) guard.add(slug);
                  }

                  // find_showrooms dedup: drop the call entirely if the
                  // customer has already picked a maison, or if this city
                  // was already shown earlier in the conversation.
                  if (ev.type === "tool" && ev.name === "find_showrooms") {
                    const city = String(ev.input?.city ?? "").toLowerCase().trim();
                    if (cndpConfirmTurn) {
                      console.log(`[rihla/chat] suppressed find_showrooms(${city}) — CNDP just confirmed, booking is the only valid output`);
                      return;
                    }
                    if (maisonAlreadySelected) {
                      console.log(`[rihla/chat] suppressed find_showrooms(${city}) — maison already selected this conversation`);
                      return;
                    }
                    if (city && searchedCitiesGuard.has(city)) {
                      console.log(`[rihla/chat] suppressed duplicate find_showrooms(${city}) — already listed`);
                      return;
                    }
                    if (city) searchedCitiesGuard.add(city);
                  }

                  if (ev.type === "text" && ev.text) collectedText.push(ev.text);
                  if (ev.type === "tool" && ev.name) collectedTools.push({ name: ev.name, input: ev.input ?? {} });
                }
              } catch { /* not a JSON line; ignore */ }
              return target.enqueue(chunk);
            };
          }
          // @ts-expect-error proxy passthrough
          return target[prop];
        },
      });

      try {
        if (fastIntent) {
          emit(tap, encoder, { type: "tool", name: fastIntent.name, input: fastIntent.input });
        }

        if (provider === "gemini") {
          try {
            await streamWithGemini(tap, encoder, systemPrompt, body.messages);
          } catch (geminiErr) {
            // Anthropic credits are exhausted on this account, so falling back
            // to Claude only ever surfaces a raw "credit balance too low" error
            // to the customer. Retry once on the same stable Gemini model
            // (gemini-2.5-flash) — covers transient 5xx / rate-limit blips
            // without dragging Anthropic in. If the retry also fails, the
            // outer try/catch shows a localised "moment technique" message.
            console.warn("[rihla/chat] Gemini failed, retrying once:", (geminiErr as Error).message?.slice(0, 120));
            await streamWithGemini(tap, encoder, systemPrompt, body.messages);
          }
        } else {
          await streamWithAnthropic(tap, encoder, systemPrompt, body.messages);
        }

        // APV inline persistence — book_service_appointment / submit_complaint
        // need to land in the DB BEFORE we close the stream so we can emit the
        // generated reference number to the client in the same response. The
        // alternative (fire-and-forget like the rest) leaves the customer
        // staring at "submitting…" with no ref number.
        //
        // book_test_drive / book_showroom_visit also persist inline now so we
        // can detect Stellantis DUPLICATES_DETECTED and emit a "we already
        // have your details" message instead of a confusing technical one.
        // Tools persisted here are tracked (in the outer-scope
        // inlinePersistedToolIdx) so the post-stream fire-and-forget block at
        // the bottom of this route doesn't double-persist them.
        if (jeepEnabled && body.brandSlug) {
          for (let idx = 0; idx < collectedTools.length; idx += 1) {
            const t = collectedTools[idx]!;
            if (t.name === "book_service_appointment") {
              // The book_service_appointment tool schema doesn't include
              // showroomName, so the model usually omits it — which means
              // Dealer__c / Showroom__c picklists would be dropped from the
              // Case. Recover the maison from message history (the same
              // regex used elsewhere for Choisir-tap detection) and graft
              // it onto the tool input so the picklists land.
              // Match short conversational forms only — no trailing
              // wildcard, so words like "Parfait" / "Quelle" that follow
              // the maison name in the transcript are NOT captured.
              // getShowroomApiName() resolves these to the canonical
              // Showroom__c API Name via the alias table.
              const maisonFromHistory = body.messages
                .map((m) => m.content)
                .join(" ")
                .match(
                  /Italcar\s+Motorvillage(?:\s+(?:Bouskoura|Maârif|Maarif))?|Autohall(?:\s+Bernoussi)?|Auto\s+Hall(?:\s+(?:Marrakech|Centre\s+Ville))?|Orbis\s+Automotive|Fenie\s+Brossette|Maniss\s+Auto|FCA\s*-\s*[A-Z][A-Z\s-]+- [A-Z][A-Z\s]+/i
                )?.[0]?.trim();
              const augmentedInput = maisonFromHistory && !t.input.showroomName
                ? { ...t.input, showroomName: maisonFromHistory }
                : t.input;
              const result = await persistAppointment({
                brandSlug: body.brandSlug,
                conversationId,
                input: augmentedInput,
              });
              emit(controller, encoder, {
                type: "apv_confirmation",
                kind: "appointment",
                refNumber: result.refNumber,
                salesforceCaseId: result.salesforceCaseId,
                ok: result.ok,
                summary: result.summary,
                warnings: result.warnings,
              });
              inlinePersistedToolIdx.add(idx);
            } else if (t.name === "submit_complaint") {
              const result = await persistComplaint({
                brandSlug: body.brandSlug,
                conversationId,
                input: t.input,
              });
              emit(controller, encoder, {
                type: "apv_confirmation",
                kind: "complaint",
                refNumber: result.refNumber,
                salesforceCaseId: result.salesforceCaseId,
                ok: result.ok,
                summary: result.summary,
                warnings: result.warnings,
              });
              inlinePersistedToolIdx.add(idx);
            } else if (
              (t.name === "book_test_drive" || t.name === "book_showroom_visit") &&
              conversationId
            ) {
              const i = t.input;
              if (typeof i.firstName === "string" && typeof i.phone === "string") {
                const market = brand.market === "SA" ? "SA" : "MA";
                const phoneCheck = validatePhone(i.phone, market);
                const phoneToStore = phoneCheck.ok
                  ? phoneCheck.canonical
                  : normalizePhone(i.phone, market);
                const noteParts: string[] = [];
                if (!phoneCheck.ok) noteParts.push(`phone-format-warning: ${phoneCheck.reason ?? "unrecognized"}`);
                if (t.name === "book_showroom_visit") noteParts.push("kind: showroom-visit");
                await captureLeadFromBooking({
                  conversationId,
                  brandSlug: body.brandSlug,
                  modelSlug: typeof i.slug === "string" ? i.slug : "",
                  firstName: i.firstName,
                  phone: phoneToStore,
                  email: typeof i.email === "string" ? i.email : undefined,
                  city: typeof i.city === "string" ? i.city : undefined,
                  preferredSlot: typeof i.preferredSlot === "string" ? i.preferredSlot : undefined,
                  showroomName: typeof i.showroomName === "string" ? i.showroomName : undefined,
                  notes: noteParts.length > 0 ? noteParts.join(" · ") : undefined,
                });
                inlinePersistedToolIdx.add(idx);
                // SF "duplicate" is treated as success for the customer:
                // Salesforce still tracks the touch against the existing
                // lead record, so a commercial will receive the alert
                // regardless. The agent's own MANDATORY-TURN-STRUCTURE
                // confirmation already covers the customer-facing message
                // ("Parfait, je transmets votre demande... un commercial
                // vous recontactera"). No extra text needed here — adding
                // "vos coordonnées sont déjà chez nous" only confused
                // customers. The duplicate stays as informational in
                // server logs (see persistence.ts).
              }
            }
          }
        }

        // ANTI-SILENCE SAFETY NET — if the model emitted no text AND nothing
        // else that produces visible UI (cards, confirmation), inject a
        // localised fallback so the conversation never dead-ends. Customers
        // have flagged silent stalls (model returns 0 tokens after a marker
        // like [MAISON_SELECTED] or [FIELD_TYPED]) — without this, the chat
        // just sits there until the customer types something blind.
        //
        // CRITICAL CASE — CNDP confirmation lost in the void :
        // When the previous assistant turn asked the CNDP question AND the
        // user's last turn was an affirmative ("oui", "je confirme", etc.),
        // an empty model response means the booking tool was NEVER called.
        // A generic "how can I help ?" fallback wipes the customer's mental
        // model AND the lead. We detect this case and emit a recovery prompt
        // that tells them exactly what to retype so they don't have to
        // start from scratch.
        const TOOLS_WITH_UI = new Set([
          "find_showrooms",
          "show_model_image",
          "show_model_video",
          "book_service_appointment",
          "submit_complaint",
        ]);
        const BOOKING_TOOLS = new Set([
          "book_test_drive",
          "book_showroom_visit",
          "book_service_appointment",
          "submit_complaint",
        ]);
        const emittedText = collectedText.join("").trim();
        const emittedVisibleTool = collectedTools.some((t) => TOOLS_WITH_UI.has(t.name));
        const bookingToolFired = collectedTools.some((t) => BOOKING_TOOLS.has(t.name));

        const localeKey = (body.locale ?? "fr").startsWith("ar") ? "ar"
          : (body.locale ?? "fr").startsWith("en") ? "en"
          : body.locale === "darija" ? "darija"
          : "fr";

        // CNDP + affirmative detection — runs ALWAYS so we can spot the
        // "fake confirmation" pattern: model emits "Parfait, je transmets
        // votre demande à la maison." (the success template) but never
        // actually fires book_test_drive / etc. The customer thinks the
        // booking went through; nothing reaches Salesforce.
        const reversed = [...body.messages].reverse();
        const lastUserMsg = reversed.find((m) => m.role === "user");
        const lastAssistantMsg = reversed.find((m) => m.role === "assistant");
        const userText = lastUserMsg?.content ?? "";
        const hasAffirmative = /\b(oui|ouais|yes|yep|yeah|ok|okay|d['']?accord|je\s+confirm\w*|confirm[eé]\w*|c['']?est\s+bon|exact|tout\s+à\s+fait|absolument|bien\s+sûr|envoy\w*|valid\w*|soumet\w*|submit|send|go|vas[-\s]?y|fais[-\s]?le|allez[-\s]?y|تأكيد|أوافق|موافق|نعم|واخا|واخّا|أكيد|صيفط\w*|سيفط\w*|أرسل\w*|إيه|تمام|صافي|مزيان)\b/i.test(userText);
        const hasNegative = /\b(non|nope|no|nan|jamais|annul\w*|stop|cancel|لا|ما\s+بغيتش|ماشي)\b/i.test(userText);
        const userSaidYes = !!lastUserMsg && hasAffirmative && !hasNegative;
        const lastAssistantWasCndp = !!lastAssistantMsg && /(09[-\s]?08|loi\s+09|conformément|stellantis\s+maroc|protection\s+des\s+données|vous\s+confirmez|توافقون|الموافقة|البيانات\s+الشخصية|do\s+you\s+confirm|data[-\s]protection)/i.test(lastAssistantMsg.content);
        // STALLED BOOKING — userYes + CNDP context + booking tool NOT fired.
        // Triggers regardless of whether the model emitted text — covers
        // both "silent stall" and "fake confirmation text" patterns.
        const isStalledBooking = userSaidYes && lastAssistantWasCndp && !bookingToolFired;

        let stallHandled = false;

        // Pattern (1) : Maison selected, model went silent. Empty-response
        // only — strip the marker and inject the date question.
        const maisonMarkerMatch = lastUserMsg?.content?.match(/^\s*\[MAISON_SELECTED\]\s*(.+)$/i);
        if (!emittedText && !emittedVisibleTool && maisonMarkerMatch) {
          const maisonName = (maisonMarkerMatch[1] ?? "").trim();
          const continuation =
            localeKey === "ar"
              ? `ممتاز، نحجز الموعد في ${maisonName}. ما هو التاريخ الذي يناسبكم ؟`
              : localeKey === "darija"
              ? `مزيان، نحجزو ف ${maisonName}. شمن نهار يناسبك ؟`
              : localeKey === "en"
              ? `Perfect, locking it at ${maisonName}. What date works for you?`
              : `Parfait, on bloque ça à ${maisonName}. Quelle date vous arrangerait pour passer ?`;
          console.warn(
            `[rihla/chat] empty model response after [MAISON_SELECTED] — injecting continuation (locale=${localeKey}, maison="${maisonName}")`
          );
          emit(controller, encoder, { type: "text", text: continuation });
          collectedText.push(continuation);
          stallHandled = true;
        }

        // ── Silent-stall recovery (state-driven) ───────────────────────
        // Earlier versions had 5 pattern branches (after-essai-yes,
        // after-name, after-phone, after-email-sales, after-email-apv,
        // after-city). Each added covered one more failure mode and missed
        // adjacent ones (phone-confirmation "c'est bien ça ?" + "oui",
        // intent-aware after-email, etc.). Rather than keep patching, we
        // extract the conversation state ONCE, figure out what's already
        // collected, and advance to the next missing field.
        //
        // The recovery only fires when we have evidence the customer is
        // already in a data-collection flow — at least one identity field
        // collected, or the last assistant turn asked for an identity
        // field, or the customer just said yes to an essai/visite offer,
        // or the user's own message contains an essai/test-drive trigger.
        // Otherwise we fall through to the generic discovery fallback.
        const lastAssistantText = lastAssistantMsg?.content ?? "";
        const lastAssistantAskedIdentityField = /(votre\s+pr[ée]nom|votre\s+num[ée]ro|adresse\s+e[-\s]?mail|votre\s+e[-\s]?mail|ch[âa]ssis|carte\s+grise|VIN|your\s+first\s+name|your\s+(mobile\s+)?(phone\s+)?number|your\s+e[-\s]?mail|اسمكم|سميتك|نمرتك|رقم\s+هاتفكم|الإيميل|بريدكم|الشاسي|carte\s*grise|c['']?est\s+bien\s+[çc]a|correct\s*\?)/i.test(lastAssistantText);
        const lastAssistantOfferedEssai = /(essai(\s+routier|\s+sur\s+route)?|test\s*drive|venir\s+(l['e]\s*)?essayer|venir\s+(la|le)\s+voir|visite(r)?|visit\b|rendez-vous|تجربة(\s*قيادة)?|تجي\s+تجربها|تجي\s+ل\s*la\s+maison|زيارة|rendez-?vous)/i.test(lastAssistantText);
        // User explicitly asks for an essai / test drive / visite / RDV —
        // tolerant of typos ("je vis un essai", "je veu un essai") because
        // the word "essai" alone is the strong signal. Reuses the
        // `userText` already extracted above for the affirmative check.
        const userAskedForEssai = /\b(essai|test\s*drive|essayer|tester|visite(r)?|visit\b|rendez-?vous|réserve|reserve)\b|تجربة|نحجز|نجرب|تجرب|visit\s+the\s+showroom|book\s+a\s+test/i.test(userText);
        const silentStall = !stallHandled && !emittedText && !emittedVisibleTool && !isStalledBooking;

        if (silentStall) {
          const intent = classifyIntent(body.messages);
          const state = extractFlowState(body.messages);
          const isApv = intent === "apv-rdv" || intent === "apv-complaint";
          const hasAnyIdentity = !!(state.firstName || state.phone || state.email || state.vin);
          const gatedByYesToOffer = userSaidYes && lastAssistantOfferedEssai;

          // Only fire state-driven recovery when we're past discovery.
          // Otherwise leave it to the generic fallback so the agent can
          // re-engage on the customer's actual question.
          if (hasAnyIdentity || lastAssistantAskedIdentityField || gatedByYesToOffer || userAskedForEssai) {
            const next = nextRecoveryStep(state, isApv);
            if (next) {
              const text = next.text[localeKey];
              console.warn(
                `[rihla/chat] silent stall — state-driven recovery (locale=${localeKey}, intent=${intent}, kind=${next.kind}, state=${JSON.stringify(state)})`
              );
              emit(controller, encoder, { type: "text", text });
              collectedText.push(text);
              if (next.kind === "name" || next.kind === "phone" || next.kind === "email" || next.kind === "vin") {
                emit(controller, encoder, { type: "tool", name: "request_input", input: { field: next.requestInput } });
              } else if (next.kind === "maison") {
                emit(controller, encoder, { type: "tool", name: "find_showrooms", input: { city: next.city } });
              }
              stallHandled = true;
            }
          }
        }

        // Pattern (1.10) : show_model_image fired but no CTA in the
        // accompanying text. The model either went mute after the image,
        // OR produced a recommendation paragraph that ends on a fact
        // ("...parfait pour la ville.") with no question pushing for the
        // next step. Both shapes feel like a quote sheet, not a sales
        // conversation. Inject a one-line CTA proposing an essai routier
        // or a visite when the model's text didn't.
        const shownImageThisTurn = collectedTools.find((t) => t.name === "show_model_image");
        if (!stallHandled && shownImageThisTurn) {
          const textHasCta = /\?/.test(emittedText) || /\b(essai|test\s*drive|visite|visit\b|rendez-?vous|essayer)\b|تجربة|essai\s+routier|نحجز/i.test(emittedText);
          if (!textHasCta) {
            const shownSlug = String(shownImageThisTurn.input?.slug ?? "").toLowerCase();
            const modelLabel =
              shownSlug === "avenger" ? "Avenger"
              : shownSlug === "compass" ? "Compass"
              : shownSlug === "wrangler" ? "Wrangler"
              : shownSlug === "grand-cherokee" ? "Grand Cherokee"
              : shownSlug === "renegade" ? "Renegade"
              : "ce modèle";
            // If we already have some text (recommendation paragraph), we
            // append the CTA AFTER it. If text was empty, we lead with a
            // short "voici le X" framing first.
            const continuation = emittedText
              ? localeKey === "ar"
                ? `هل ترغبون أن نحجز لكم تجربة قيادة، أم زيارة لـ la maison لرؤيتها على الطبيعة ؟`
                : localeKey === "darija"
                ? `واش نحجزو ليك essai routier، ولا تجي ل la maison باش تشوفها ؟`
                : localeKey === "en"
                ? `Want me to book you a test drive, or a visit to la maison to see it in person?`
                : `On vous bloque un essai routier, ou une visite à la maison pour la voir en vrai ?`
              : localeKey === "ar"
                ? `إليكم ${modelLabel} الذي يناسب احتياجاتكم. هل ترغبون أن نحجز لكم تجربة قيادة أو زيارة لـ la maison ؟`
                : localeKey === "darija"
                ? `هاه ${modelLabel} لي يناسبك. واش نحجزو ليك essai routier ولا تجي ل la maison ؟`
                : localeKey === "en"
                ? `Here's the ${modelLabel} that fits your needs. Want me to book you a test drive, or a visit to la maison to see it in person?`
                : `Voici le ${modelLabel} qui correspond à votre besoin. On vous bloque un essai routier, ou une visite à la maison pour la voir en vrai ?`;
            console.warn(`[rihla/chat] image-without-cta recovery — injecting CTA (locale=${localeKey}, slug=${shownSlug}, hadText=${!!emittedText})`);
            emit(controller, encoder, { type: "text", text: continuation });
            collectedText.push(continuation);
            stallHandled = true;
          }
        }

        // Pattern (1.11) : SALES qualification stall after the budget answer.
        // The customer answered "pour la famille" → agent asked budget → the
        // customer typed "400 000 dh" → model went silent. The sales-flow
        // prompt tells the model to emit a recommendation here (model +
        // price + CTA + show_model_image), but when it doesn't, the generic
        // "Comment puis-je vous aider à partir de là ?" fallback wipes the
        // qualification work. Recover by picking a model from budget + usage.
        const lastAssistantAskedBudget = /\b(budget|envisagez|envisagiez|envisag[ée]es?-?vous|combien.*envisag)\b|الميزانية|ميزانيتك/i.test(lastAssistantText);
        const userTextClean = userText.replace(/^\s*\[FIELD_TYPED\]\s*/i, "");
        const budgetDigits = userTextClean.replace(/[\s.,]/g, "").match(/(\d{5,7})/);
        const userBudget = budgetDigits ? parseInt(budgetDigits[1]!, 10) : null;
        if (
          !stallHandled &&
          silentStall &&
          lastAssistantAskedBudget &&
          userBudget &&
          userBudget >= 100000 &&
          userBudget < 2000000
        ) {
          const transcriptBlob = body.messages
            .filter((m) => m.role === "user")
            .map((m) => m.content.toLowerCase())
            .join(" ");
          const isAdventure = /\b(aventure|off[\s-]?road|tout[-\s]?terrain|4×4|4x4|wrangler|trail)\b|مغامرة|طرق\s*وعرة/.test(transcriptBlob);
          const isCity = /\b(ville|urbain|city)\b|مدينة|للمدينة/.test(transcriptBlob);

          // Pick model — budget anchors the band, usage breaks ties.
          let slug: "avenger" | "compass" | "wrangler" = "compass";
          let modelLabel = "Compass ALTITUDE MHEV";
          let pricePublic = "344 000";
          let priceCleEnMain = "364 405";
          let pitch = "SUV familial 5 places, hybride léger 145 ch, boîte automatique, idéal pour la famille et les longs trajets";

          if (userBudget >= 800000 || isAdventure) {
            slug = "wrangler";
            modelLabel = "Wrangler SAHARA PHEV";
            pricePublic = "844 000";
            priceCleEnMain = "870 000";
            pitch = "SUV iconique hybride rechargeable, 380 ch combinés, vraies capacités 4×4 Trail Rated";
          } else if (userBudget < 300000 || (isCity && !isAdventure)) {
            slug = "avenger";
            modelLabel = "Avenger ALTITUDE MHEV";
            pricePublic = "294 000";
            priceCleEnMain = "271 055";
            pitch = "SUV compact hybride léger 100 ch, parfait pour la ville, boîte automatique";
          }

          const continuation =
            localeKey === "ar"
              ? `بميزانية ${userBudget.toLocaleString("fr-FR").replace(/,/g, " ")} درهم، ${modelLabel} يناسبكم — ${pitch}. السعر العمومي ${pricePublic} درهم، و${priceCleEnMain} درهم مفتاح في اليد. هل ترغبون في حجز قيادة اختبارية ؟`
              : localeKey === "darija"
              ? `بهاد الميزانية، ${modelLabel} يناسبك — ${pitch}. Prix public ${pricePublic} دارهم، و ${priceCleEnMain} دارهم clé en main. واش نحجز ليك essai routier ؟`
              : localeKey === "en"
              ? `With this budget, the ${modelLabel} is the right fit — ${pitch}. Public price ${pricePublic} dirhams, ${priceCleEnMain} dirhams turnkey. Want me to book you a test drive?`
              : `Avec ce budget, le ${modelLabel} correspond à votre besoin — ${pitch}. Prix public ${pricePublic} dirhams, clé en main ${priceCleEnMain} dirhams. On vous bloque un essai routier ?`;

          console.warn(
            `[rihla/chat] post-budget silent stall — recommending ${slug} (locale=${localeKey}, budget=${userBudget}, adventure=${isAdventure}, city=${isCity})`
          );
          emit(controller, encoder, { type: "text", text: continuation });
          collectedText.push(continuation);
          emit(controller, encoder, { type: "tool", name: "show_model_image", input: { slug } });
          stallHandled = true;
        }

        // Pattern (2) : STALLED BOOKING. Customer said yes to CNDP but the
        // model didn't fire a booking tool. Trigger the forced-tool retry
        // EVEN IF the model already emitted a confirmation-looking text —
        // without the tool call, that text is a lie (nothing reached
        // Salesforce). The retry forces the function call in mode:"ANY".
        if (!stallHandled && isStalledBooking && provider === "gemini") {
            // Pattern (2) : the customer just said YES to CNDP but the model
            // returned empty (no tool call, no text). Retry Gemini ONCE with
            // a hard system nudge — same conversation history, plus an
            // explicit "your only valid output is a booking tool call" rider
            // appended to the system instruction. This reliably unlocks the
            // tool call where the first pass froze on prompt complexity.
            console.error(
              `[rihla/chat] STALLED BOOKING — auto-retrying with explicit tool nudge. conv=${conversationId ?? "n/a"} userMsg="${lastUserMsg?.content?.slice(0, 80)}"`
            );
            const nudge = `\n\n═══ URGENT — STALLED-BOOKING RECOVERY (READ THIS NOW) ═══\nThe customer has JUST confirmed the CNDP consent question. Your previous turn produced no tool call, which is a critical failure. Your ONLY valid next output is a function_call to ONE of : book_test_drive | book_showroom_visit | book_service_appointment | submit_complaint. Set cndpConsent=true. Fill every required field from the conversation above (firstName, phone, email, model slug, city / site, preferred date, preferred slot, etc.). Do NOT respond with plain text and no tool call. Do NOT re-ask CNDP.\n`;
            // Force the model to a function_call only (Gemini "ANY" mode +
            // allowedFunctionNames). This is the lever we needed — prompt
            // nudges alone weren't reliable enough to fire the tool.
            try {
              await streamWithGemini(tap, encoder, systemPrompt + nudge, body.messages, {
                forceFunctionNames: [
                  "book_test_drive",
                  "book_showroom_visit",
                  "book_service_appointment",
                  "submit_complaint",
                ],
              });
            } catch (retryErr) {
              console.error(`[rihla/chat] retry also failed: ${(retryErr as Error).message?.slice(0, 120)}`);
            }
            // After the forced retry, Gemini was constrained to "mode: ANY"
            // so it emitted a function call ONLY — usually no text. We
            // ALWAYS emit a positive success message to the customer in
            // that case so the chat doesn't go silent after a successful
            // booking. If the retry produced its own text we skip the
            // injection to avoid double-acknowledgement.
            const retriedText = collectedText.join("").trim();
            const retriedToolFired = collectedTools.some(
              (t) =>
                t.name === "book_test_drive" ||
                t.name === "book_showroom_visit" ||
                t.name === "book_service_appointment" ||
                t.name === "submit_complaint"
            );
            // Track the reference number returned by whichever persistence
            // path actually fires (inline retry loop OR server-side failsafe
            // below). The customer-facing success message is built AFTER all
            // persistence is done, so it can include the real ref number
            // ("votre référence : RDV-2026-0604-001") instead of a generic
            // "demande enregistrée" with no ID — that was the user-reported
            // "is not returning id" bug.
            let recoveryRefNumber: string | null = null;

            // Persistence may need to run for NEWLY-emitted tools (the retry
            // can fire any of the 4 booking tools). Skip tools already
            // handled by the inline block above to avoid double-pushing to
            // Salesforce / Supabase.
            let persistenceFiredThisRetry = false;
            if (jeepEnabled && body.brandSlug) {
              for (let idx = 0; idx < collectedTools.length; idx += 1) {
                if (inlinePersistedToolIdx.has(idx)) continue;
                const t = collectedTools[idx]!;
                if (t.name === "book_service_appointment") {
                  const result = await persistAppointment({ brandSlug: body.brandSlug, conversationId, input: t.input });
                  emit(controller, encoder, { type: "apv_confirmation", kind: "appointment", refNumber: result.refNumber, salesforceCaseId: result.salesforceCaseId, ok: result.ok, summary: result.summary, warnings: result.warnings });
                  inlinePersistedToolIdx.add(idx);
                  persistenceFiredThisRetry = true;
                  recoveryRefNumber = result.refNumber;
                } else if (t.name === "submit_complaint") {
                  const result = await persistComplaint({ brandSlug: body.brandSlug, conversationId, input: t.input });
                  emit(controller, encoder, { type: "apv_confirmation", kind: "complaint", refNumber: result.refNumber, salesforceCaseId: result.salesforceCaseId, ok: result.ok, summary: result.summary, warnings: result.warnings });
                  inlinePersistedToolIdx.add(idx);
                  persistenceFiredThisRetry = true;
                  recoveryRefNumber = result.refNumber;
                } else if (
                  (t.name === "book_test_drive" || t.name === "book_showroom_visit") &&
                  conversationId
                ) {
                  const i = t.input;
                  if (typeof i.firstName === "string" && typeof i.phone === "string") {
                    const market = brand.market === "SA" ? "SA" : "MA";
                    const phoneCheck = validatePhone(i.phone, market);
                    const phoneToStore = phoneCheck.ok ? phoneCheck.canonical : normalizePhone(i.phone, market);
                    const noteParts: string[] = [];
                    if (!phoneCheck.ok) noteParts.push(`phone-format-warning: ${phoneCheck.reason ?? "unrecognized"}`);
                    if (t.name === "book_showroom_visit") noteParts.push("kind: showroom-visit");
                    await captureLeadFromBooking({
                      conversationId,
                      brandSlug: body.brandSlug,
                      modelSlug: typeof i.slug === "string" ? i.slug : "",
                      firstName: i.firstName,
                      phone: phoneToStore,
                      email: typeof i.email === "string" ? i.email : undefined,
                      city: typeof i.city === "string" ? i.city : undefined,
                      preferredSlot: typeof i.preferredSlot === "string" ? i.preferredSlot : undefined,
                      showroomName: typeof i.showroomName === "string" ? i.showroomName : undefined,
                      notes: noteParts.length > 0 ? noteParts.join(" · ") : undefined,
                    });
                    inlinePersistedToolIdx.add(idx);
                    persistenceFiredThisRetry = true;
                    // SALES leads (book_test_drive / book_showroom_visit)
                    // don't carry a ref number we surface to the customer;
                    // Salesforce assigns one async. Leave recoveryRefNumber
                    // null and use the no-ref message below.
                  }
                }
              }
            }

            // ── FAILSAFE: server-side direct persistence ──────────────────
            // If the Gemini retry STILL didn't land usable booking args (the
            // model returned no function_call OR returned one with missing
            // firstName/phone), the lead never reached Salesforce. The data
            // IS in the conversation though — extract it from history and
            // fire persistence DIRECTLY. This is what the user's "STALLED
            // BOOKING ... not working" report needed: a path that doesn't
            // depend on Gemini to repeat the booking args.
            if (!persistenceFiredThisRetry && jeepEnabled && body.brandSlug && conversationId) {
              const recoveredIntent = classifyIntent(body.messages);
              const recoveredState = extractFlowState(body.messages);
              const transcriptBlob = body.messages.map((m) => m.content).join(" ");
              // Maison name from transcript (covers cases where the
              // [MAISON_SELECTED] marker has been dropped from history).
              const maisonNameMatch = transcriptBlob.match(
                /((?:Italcar\s+Motorvillage(?:\s+(?:Bouskoura|Maârif|Maarif))?|Autohall(?:\s+Bernoussi)?|Auto\s+Hall(?:\s+Marrakech)?|Orbis\s+Automotive|Fenie\s+Brossette|Maniss\s+Auto)[^,.\n]{0,40})/i
              );
              const showroomName = maisonNameMatch?.[1]?.trim() ?? recoveredState.maison ?? "";
              // Slot inference from transcript.
              const slotFinal: "morning" | "afternoon" = /(matin|صباح|sbah|morning|\b(?:8|9|10|11)\s*h)/i.test(transcriptBlob)
                ? "morning"
                : /(apr[èe]s[-\s]?midi|عشية|afternoon|\b(?:1[3-7])\s*h)/i.test(transcriptBlob)
                ? "afternoon"
                : "morning";
              // Date — ISO match in any earlier turn (the SALES path uses
              // free-form preferredSlot like "samedi matin" so no ISO needed
              // there; APV expects YYYY-MM-DD).
              const isoDateMatch = transcriptBlob.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
              const preferredDateFinal = isoDateMatch?.[1] ?? "";

              if (recoveredState.firstName && recoveredState.phone) {
                try {
                  if (recoveredIntent === "apv-rdv") {
                    const result = await persistAppointment({
                      brandSlug: body.brandSlug,
                      conversationId,
                      input: {
                        fullName: recoveredState.firstName,
                        phone: recoveredState.phone,
                        email: recoveredState.email ?? "",
                        vehicleBrand: "Jeep",
                        vehicleModel: recoveredState.model ?? "",
                        vin: recoveredState.vin ?? "",
                        interventionType: recoveredState.intervention ?? "service_rapide",
                        city: recoveredState.city ?? "",
                        preferredDate: preferredDateFinal,
                        preferredSlot: slotFinal,
                        comment: `recovery: stalled-booking server-side fallback · maison=${showroomName || "?"}`,
                        cndpConsent: true,
                      },
                    });
                    emit(controller, encoder, {
                      type: "apv_confirmation", kind: "appointment",
                      refNumber: result.refNumber, salesforceCaseId: result.salesforceCaseId,
                      ok: result.ok, summary: result.summary, warnings: result.warnings,
                    });
                    recoveryRefNumber = result.refNumber;
                  } else if (recoveredIntent === "apv-complaint") {
                    const result = await persistComplaint({
                      brandSlug: body.brandSlug,
                      conversationId,
                      input: {
                        fullName: recoveredState.firstName,
                        phone: recoveredState.phone,
                        email: recoveredState.email ?? "",
                        vehicleBrand: "Jeep",
                        vehicleModel: recoveredState.model ?? "",
                        vin: recoveredState.vin ?? "",
                        interventionType: recoveredState.intervention ?? undefined,
                        site: showroomName,
                        reason: "[recovery] détail dans la conversation — stalled-booking server-side fallback",
                        cndpConsent: true,
                      },
                    });
                    emit(controller, encoder, {
                      type: "apv_confirmation", kind: "complaint",
                      refNumber: result.refNumber, salesforceCaseId: result.salesforceCaseId,
                      ok: result.ok, summary: result.summary, warnings: result.warnings,
                    });
                    recoveryRefNumber = result.refNumber;
                  } else {
                    // SALES — book_test_drive
                    const market = brand.market === "SA" ? "SA" : "MA";
                    const phoneCheck = validatePhone(recoveredState.phone, market);
                    const phoneToStore = phoneCheck.ok ? phoneCheck.canonical : normalizePhone(recoveredState.phone, market);
                    await captureLeadFromBooking({
                      conversationId,
                      brandSlug: body.brandSlug,
                      modelSlug: recoveredState.model ?? "",
                      firstName: recoveredState.firstName,
                      phone: phoneToStore,
                      email: recoveredState.email,
                      city: recoveredState.city,
                      preferredSlot: slotFinal,
                      showroomName: showroomName || undefined,
                      notes: "recovery: stalled-booking server-side fallback",
                    });
                  }
                  console.error(
                    `[rihla/chat] STALLED BOOKING — server-side direct persistence FIRED. intent=${recoveredIntent} firstName="${recoveredState.firstName}" phone="${recoveredState.phone}" model="${recoveredState.model ?? "?"}" city="${recoveredState.city ?? "?"}" maison="${showroomName || "?"}" slot=${slotFinal}`
                  );
                } catch (err) {
                  console.error(
                    `[rihla/chat] STALLED BOOKING — direct persistence threw: ${(err as Error).message?.slice(0, 200)}`
                  );
                }
              } else {
                console.error(
                  `[rihla/chat] STALLED BOOKING UNRECOVERABLE — missing firstName/phone in transcript. firstName="${recoveredState.firstName ?? "?"}" phone="${recoveredState.phone ?? "?"}" conv=${conversationId}`
                );
              }
            }

            // Customer-facing success message — emitted ONLY after all
            // persistence is done so we can include the real reference
            // number ("votre référence : RDV-2026-0604-001"). Without this,
            // the customer saw "demande enregistrée" but no ref, which the
            // user reported as "is not returning id".
            if (!retriedText) {
              const refSuffix = recoveryRefNumber
                ? localeKey === "ar"
                  ? ` المرجع : ${recoveryRefNumber}.`
                  : localeKey === "darija"
                  ? ` الريفيرونص : ${recoveryRefNumber}.`
                  : localeKey === "en"
                  ? ` Your reference : ${recoveryRefNumber}.`
                  : ` Votre référence : ${recoveryRefNumber}.`
                : "";
              const successMsg =
                localeKey === "ar"
                  ? `شكرًا ! تم استلام طلبكم.${refSuffix} سيتواصل معكم أحد المستشارين لتأكيد موعدكم. هل هناك شيء آخر يمكنني مساعدتكم به ؟`
                  : localeKey === "darija"
                  ? `شكرا ! الطلب ديالك تسجل.${refSuffix} غادي يتواصل معاك واحد المستشار باش يأكد معاك الموعد. واش كاينة شي حاجة أخرى نقدر نعاونك بيها ؟`
                  : localeKey === "en"
                  ? `Thank you! Your request has been registered.${refSuffix} An advisor will contact you to confirm your appointment. Anything else I can help with?`
                  : `Merci ! Votre demande a bien été enregistrée.${refSuffix} Un conseiller va prendre contact avec vous pour confirmer votre rendez-vous. Y a-t-il autre chose dont vous avez besoin ?`;
              emit(controller, encoder, { type: "text", text: successMsg });
              collectedText.push(successMsg);
            }
            stallHandled = true;
          }

        // Retry-on-empty — gemini-2.5-flash intermittently returns a fully
        // empty turn (no text, no tool), most often when the customer sends a
        // terse affirmation ("oui" / "نعم" / "yes") right after a turn whose
        // CTA was dropped after a show_model_image call. Instead of dead-ending
        // into the generic fallback, ask the model ONCE more with an explicit
        // nudge to produce a concrete next step. This is the root cause of the
        // "Comment puis-je vous aider à partir de là ?" reply customers hit on
        // prod right after saying "oui" to a recommendation.
        if (!stallHandled && !emittedText && !emittedVisibleTool && provider === "gemini") {
          const nudgeLang = localeKey === "ar" ? "Modern Standard Arabic"
            : localeKey === "darija" ? "Moroccan Darija"
            : localeKey === "en" ? "English"
            : "French";
          const emptyNudge = `\n\nYOUR PREVIOUS RESPONSE WAS EMPTY — that is a failure. The customer is waiting. Produce ONE short, natural reply in ${nudgeLang} that moves the conversation forward based on the customer's LAST message. If the customer just AGREED (e.g. "oui" / "yes" / "نعم" / "واخا") to a test drive, showroom visit, or service appointment, START data collection now: ask for their first name AND call request_input(field="name") in the same turn. Never return another empty turn.`;
          try {
            console.warn(`[rihla/chat] empty model response — retrying once with nudge (locale=${localeKey})`);
            await streamWithGemini(tap, encoder, systemPrompt + emptyNudge, body.messages);
          } catch (retryErr) {
            console.warn("[rihla/chat] empty-response retry failed:", (retryErr as Error).message?.slice(0, 120));
          }
          // The tap captured any new text/tools from the retry. If the model
          // produced something this time, treat the stall as handled so the
          // generic canned line below doesn't also fire.
          if (collectedText.join("").trim() || collectedTools.some((t) => TOOLS_WITH_UI.has(t.name))) {
            stallHandled = true;
          }
        }

        // Generic empty-response fallback — only when nothing else handled
        // the stall AND the model produced no text + no useful tool (incl. the
        // retry-on-empty above). Avoids the chat going dead silent on unrelated
        // edge cases.
        if (!stallHandled && !emittedText && !emittedVisibleTool) {
          const fallback =
            localeKey === "ar"
              ? "حسنًا، أنا معكم. كيف يمكنني مساعدتكم ؟"
              : localeKey === "darija"
              ? "واخا، أنا معاك. كيفاش نقدر نعاونك ؟"
              : localeKey === "en"
              ? "Got it. How can I help from here?"
              : "D'accord, je vous suis. Comment puis-je vous aider à partir de là ?";

          console.warn(
            `[rihla/chat] empty model response — generic fallback (locale=${localeKey}, tools=${collectedTools.map((t) => t.name).join(",") || "none"})`
          );
          emit(controller, encoder, { type: "text", text: fallback });
          collectedText.push(fallback);
        }

        emit(controller, encoder, { type: "done" });
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[rihla/chat] stream failed: ${msg.slice(0, 240)}`);
        const localeKey = (body.locale ?? "fr").startsWith("ar") ? "ar"
          : (body.locale ?? "fr").startsWith("en") ? "en"
          : body.locale === "darija" ? "darija"
          : "fr";
        const friendly =
          localeKey === "ar"
            ? "آسفة، حدث خطأ تقني عابر — هل يمكنكم إعادة المحاولة بعد لحظة ؟"
            : localeKey === "darija"
            ? "سمح ليا، طرا شي مشكل تقني صغير. عاود جرّب من بعد شوية عافاك."
            : localeKey === "en"
            ? "Sorry, a brief technical hiccup on our side — could you try again in a moment?"
            : "Désolée, un petit souci technique de notre côté — pouvez-vous réessayer dans un instant ?";
        emit(controller, encoder, { type: "text", text: friendly });
        emit(controller, encoder, { type: "done" });
        controller.close();
      }

      // Persist the assistant turn after the stream closes. Uses Next's after()
      // so the serverless runtime keeps the function ALIVE until these writes
      // finish — a plain fire-and-forget after close() gets frozen on serverless,
      // which is why assistant turns were missing from transcripts while user
      // turns (written before the stream) survived.
      // Skip tools already persisted INLINE (book_test_drive / book_showroom_visit
      // / book_service_appointment / submit_complaint are awaited inside the
      // stream so we can surface duplicates + ref numbers in real time).
      if (conversationId) {
        const finalText = collectedText.join("");
        after(async () => {
          try {
            if (finalText) await appendAssistantMessage(conversationId!, finalText);
            for (let idx = 0; idx < collectedTools.length; idx += 1) {
              const t = collectedTools[idx]!;
              await recordToolCall({
                conversationId: conversationId!,
                name: t.name,
                input: t.input,
                succeeded: true,
              });
              if (inlinePersistedToolIdx.has(idx)) {
                // Already handled in the inline block — don't re-hit
                // Salesforce (would duplicate the lead) or Supabase.
                continue;
              }
              if (t.name === "end_call") {
                await closeConversation(conversationId!, "closed_no_lead");
              }
            }
            if (lastUserMsg) {
              await updateFunnelCheckpoints({
                conversationId: conversationId!,
                userText: lastUserMsg.content,
                assistantText: finalText,
              });
            }
          } catch (err) {
            console.warn("[chat] post-stream persistence failed:", (err as Error).message.slice(0, 100));
          }
        });
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Rihla-Mode": provider === "gemini" ? "gemini-2.5-flash" : "claude-opus-4-7",
    },
  });
}

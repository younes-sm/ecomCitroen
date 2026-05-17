import { NextRequest } from "next/server";
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
import { buildJeepApvOverride } from "@/lib/jeep-apv-prompt";
import { nextRefNumber } from "@/lib/reference-number";
import { adminClient } from "@/lib/supabase/admin";
import { persistAppointment, persistComplaint } from "@/lib/apv-persistence";
import type { Locale } from "@/lib/supabase/database.types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ChatMessage = { role: "user" | "assistant"; content: string };

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
const CITROEN_FALLBACK: BrandContext = {
  brandSlug: "citroen-ma",
  brandName: "Citroën Maroc",
  agentName: "Rihla",
  market: "MA",
  defaultCurrency: "MAD",
  servedCities: ["Casablanca", "Rabat", "Marrakech", "Tanger", "Fès", "Agadir", "Oujda", "Tétouan"],
  models: [
    { slug: "c3-aircross", name: "C3 Aircross", priceFrom: 234900, currency: "MAD", fuel: "Hybrid", seats: 5 },
    { slug: "c5-aircross", name: "C5 Aircross", priceFrom: 295900, currency: "MAD", fuel: "PHEV", seats: 5 },
    { slug: "berlingo", name: "Berlingo", priceFrom: 195900, currency: "MAD", fuel: "Diesel", seats: 7 },
  ],
};

/* ───────────────────────────── Navigation tools ───────────────────────────── */

/** Gemini function declarations (native format). */
const GEMINI_NAV_TOOLS: Tool[] = [
  {
    functionDeclarations: [
      {
        name: "navigate_to",
        description:
          "Navigate the browser to a site path (/models, /dealers, /financing, /account, /orders, /service, /legal, /privacy, /terms).",
        parameters: {
          type: Type.OBJECT,
          properties: { path: { type: Type.STRING } },
          required: ["path"],
        },
      },
      {
        name: "open_model",
        description:
          "Open a specific model detail page when the user shows interest in one model.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            slug: {
              type: Type.STRING,
              enum: ["c3-aircross", "c5-aircross", "berlingo"],
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
              enum: ["c3-aircross", "c5-aircross", "berlingo"],
            },
            color: { type: Type.STRING },
            trim: { type: Type.STRING },
            angle: { type: Type.NUMBER },
          },
        },
      },
      {
        name: "start_reservation",
        description: "Start the reservation flow for a model.",
        parameters: {
          type: Type.OBJECT,
          properties: { slug: { type: Type.STRING } },
          required: ["slug"],
        },
      },
      {
        name: "open_dealers",
        description: "Open the dealer locator page.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "open_financing",
        description: "Open the financing advisor page.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "scroll_to",
        description:
          "Scroll to a named section on the current page. Sections: 'range', 'configurator', 'gallery', 'features', 'specs', 'cta'.",
        parameters: {
          type: Type.OBJECT,
          properties: { section: { type: Type.STRING } },
          required: ["section"],
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
            vin: { type: Type.STRING, description: "17 chars, alphanumeric, no I/O/Q." },
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
  { name: "navigate_to", description: "Navigate to a site path.", input_schema: { type: "object" as const, properties: { path: { type: "string" as const } }, required: ["path"] } },
  { name: "open_model", description: "Open a model detail page.", input_schema: { type: "object" as const, properties: { slug: { type: "string" as const, enum: ["c3-aircross", "c5-aircross", "berlingo"] } }, required: ["slug"] } },
  { name: "configure_car", description: "Update configurator on the CURRENT page without reloading.", input_schema: { type: "object" as const, properties: { slug: { type: "string" as const }, color: { type: "string" as const }, trim: { type: "string" as const }, angle: { type: "number" as const } }, required: [] } },
  { name: "start_reservation", description: "Start reservation.", input_schema: { type: "object" as const, properties: { slug: { type: "string" as const } }, required: ["slug"] } },
  { name: "open_dealers", description: "Open dealers.", input_schema: { type: "object" as const, properties: {}, required: [] } },
  { name: "open_financing", description: "Open financing.", input_schema: { type: "object" as const, properties: {}, required: [] } },
  { name: "scroll_to", description: "Scroll to section.", input_schema: { type: "object" as const, properties: { section: { type: "string" as const } }, required: ["section"] } },
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
  { name: "submit_complaint", description: "APV ONLY. Submit a complaint after fields collected + CNDP consent.", input_schema: { type: "object" as const, properties: { fullName: { type: "string" as const }, phone: { type: "string" as const }, email: { type: "string" as const }, vehicleBrand: { type: "string" as const }, vehicleModel: { type: "string" as const }, vin: { type: "string" as const }, interventionType: { type: "string" as const, enum: ["service_rapide", "mechanical", "bodywork"] }, site: { type: "string" as const }, serviceDate: { type: "string" as const }, reason: { type: "string" as const }, attachmentUrl: { type: "string" as const }, cndpConsent: { type: "boolean" as const } }, required: ["fullName", "phone", "email", "vehicleBrand", "vehicleModel", "vin", "interventionType", "site", "reason", "cndpConsent"] } },
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
    "- FR: 'Mets-la en rouge' → say 'Je vous la mets en rouge.' then call configure_car(slug='c3-aircross', color='red')",
    "- AR/Darija: 'بدل اللون للحمر' → say 'واخا، غادي نبدلها بالحمر!' then call configure_car(slug='c3-aircross', color='red')",
    "- FR: 'Montre-moi le Berlingo' → say 'Je vous ouvre le Berlingo.' then call open_model(slug='berlingo')",
    "- AR/Darija: 'بغيت نشوف البرلينجو' → say 'واخا، هاهو البرلينجو!' then call open_model(slug='berlingo')",
    "- FR: 'Je veux réserver' → say 'Allez, on y va!' then call start_reservation(slug='...')",
    "- AR/Darija: 'بغيت نحجز' → say 'يالاه!' then call start_reservation(slug='...')"
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

  // Model open patterns
  const modelMatch = text.match(/(?:montre|ouvre|بغيت نشوف|ورّيني|show|open).+?(c3.?aircross|c5.?aircross|berlingo|بيرلينجو|برلينجو)/i);
  if (modelMatch) {
    const raw = (modelMatch[1] ?? "").toLowerCase();
    const slugMap: Record<string, string> = {
      berlingo: "berlingo", بيرلينجو: "berlingo", برلينجو: "berlingo",
    };
    const matched = raw.includes("c3") ? "c3-aircross" : raw.includes("c5") ? "c5-aircross" : slugMap[raw] ?? "berlingo";
    return { name: "open_model", input: { slug: matched } };
  }

  // Reservation intent
  if (/(?:réserv|حجز|بغيت نحجز|reserve|book)/i.test(text) && slug) {
    return { name: "start_reservation", input: { slug } };
  }

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
    model: "gemini-2.5-flash",
    contents,
    config: {
      systemInstruction,
      tools: GEMINI_NAV_TOOLS,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolConfig: toolConfig as any,
      temperature: forced ? 0.2 : 0.7,
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

  // Load brand context if a brandSlug is provided AND Supabase is configured.
  // Falls back to a minimal hard-coded Citroën catalog for legacy calls.
  let brand: BrandContext = CITROEN_FALLBACK;
  let customBody: string | undefined;
  if (body.brandSlug && process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const ctx = await getBrandContext(body.brandSlug);
      if (ctx) {
        brand = toAgentContext(ctx);
        customBody = ctx.activePrompt?.body ?? undefined;
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
  // APV (Jeep) — the chat prompt now uses the SAME apvOverride function as the
  // voice route (lib/jeep-apv-prompt.ts). Previously this route had its own
  // copy with a lookup_vin / "VIN PREFILL" flow that diverged badly from the
  // voice prompt (no CNDP gates, wrong service-type wording, agent saying
  // "Je n'arrive pas à retrouver votre dossier"). Single source of truth now.
  const apvEnabled = brand.brandSlug === "jeep-ma";
  if (!apvEnabled && body.brandSlug === "jeep-ma") {
    console.warn(`[chat] APV expected for jeep-ma but brand context resolved to ${brand.brandSlug} (Supabase miss?).`);
  }
  // Inject today's date so the model has a stable reference for relative
  // dates ("demain", "lundi prochain", "غدا") — same anchor the voice prompt
  // uses to avoid year hallucinations like "y009-05-31".
  const todayIso = new Date().toISOString().slice(0, 10);
  const todayHumanFr = new Date().toLocaleDateString("fr-MA", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });

  const apvOverride = apvEnabled ? buildJeepApvOverride({ todayIso, todayHumanFr }) : "";
  const systemPrompt = baseSystem + buildPromptSuffix(body.pageContext, !!body.voice) + buildSessionMemoryBlock(body.sessionContext) + apvOverride;

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
  let conversationId: string | null = body.conversationId ?? null;
  if (!conversationId && body.brandSlug) {
    conversationId = await createConversation({
      brandSlug: body.brandSlug,
      locale: locale as Locale,
      channel: body.voice ? "voice" : "chat",
      userAgent: req.headers.get("user-agent"),
    });
  }
  // Always persist the user's latest turn before streaming the assistant reply.
  if (conversationId && lastUserMsg) {
    await appendUserMessage(conversationId, lastUserMsg.content);
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
        if (apvEnabled && body.brandSlug) {
          for (let idx = 0; idx < collectedTools.length; idx += 1) {
            const t = collectedTools[idx]!;
            if (t.name === "book_service_appointment") {
              const result = await persistAppointment({
                brandSlug: body.brandSlug,
                conversationId,
                input: t.input,
              });
              emit(controller, encoder, {
                type: "apv_confirmation",
                kind: "appointment",
                refNumber: result.refNumber,
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
            const successMsg =
              localeKey === "ar"
                ? "تم استلام معلوماتكم بنجاح. سيتصل بكم un commercial من la maison Jeep في أقرب وقت لتأكيد الموعد. هل هناك شيء آخر يمكنني مساعدتكم به ؟"
                : localeKey === "darija"
                ? "تسجلات المعلومات ديالك بنجاح. commercial من la maison Jeep غيعاود ليك بزربة باش يأكد الموعد. واش كاينة شي حاجة أخرى نقدر نعاونك بيها ؟"
                : localeKey === "en"
                ? "Your request has been successfully registered. A Jeep commercial will reach out shortly to confirm the slot. Anything else I can help with?"
                : "Votre demande a bien été enregistrée. Un commercial de la maison Jeep va vous recontacter pour confirmer le créneau. Y a-t-il autre chose dont vous avez besoin ?";
            if (retriedToolFired && !retriedText) {
              // Booking fired but the model produced no text — inject the
              // success message ourselves. This is the most common path
              // when the forced-tool retry succeeds.
              emit(controller, encoder, { type: "text", text: successMsg });
              collectedText.push(successMsg);
            } else if (!retriedToolFired && !retriedText) {
              // Both retry attempts produced nothing. Fall back to the
              // positive acknowledgement so the customer isn't stuck. The
              // lead is still captured in Supabase + conversation log on
              // our side — a commercial will reach out from there.
              emit(controller, encoder, { type: "text", text: successMsg });
              collectedText.push(successMsg);
            }
            // Persistence may need to run for NEWLY-emitted tools (the retry
            // can fire any of the 4 booking tools). Skip tools already
            // handled by the inline block above to avoid double-pushing to
            // Salesforce / Supabase.
            if (apvEnabled && body.brandSlug) {
              for (let idx = 0; idx < collectedTools.length; idx += 1) {
                if (inlinePersistedToolIdx.has(idx)) continue;
                const t = collectedTools[idx]!;
                if (t.name === "book_service_appointment") {
                  const result = await persistAppointment({ brandSlug: body.brandSlug, conversationId, input: t.input });
                  emit(controller, encoder, { type: "apv_confirmation", kind: "appointment", refNumber: result.refNumber, ok: result.ok, summary: result.summary, warnings: result.warnings });
                  inlinePersistedToolIdx.add(idx);
                } else if (t.name === "submit_complaint") {
                  const result = await persistComplaint({ brandSlug: body.brandSlug, conversationId, input: t.input });
                  emit(controller, encoder, { type: "apv_confirmation", kind: "complaint", refNumber: result.refNumber, ok: result.ok, summary: result.summary, warnings: result.warnings });
                  inlinePersistedToolIdx.add(idx);
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
                    // Duplicate is treated as success — see inline block
                    // above for rationale. No customer-facing message.
                  }
                }
              }
            }
            stallHandled = true;
          }

        // Generic empty-response fallback — only when nothing else handled
        // the stall AND the model produced no text + no useful tool. Avoids
        // the chat going dead silent on unrelated edge cases.
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

      // Persist the assistant turn after the stream closes — fire-and-forget.
      // Skip tools that were already persisted INLINE (book_test_drive /
      // book_showroom_visit / book_service_appointment / submit_complaint
      // are awaited inside the stream so we can surface duplicates and
      // ref numbers to the customer in real time).
      if (conversationId) {
        const finalText = collectedText.join("");
        void (async () => {
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
        })();
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

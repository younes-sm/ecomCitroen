// Returns the assembled system prompt + greeting + agent settings for a brand.
// Used by the voice hook on connect, and by the chat route via buildSystemPrompt.

import { NextRequest } from "next/server";
import { buildSystemPrompt, type BrandContext, type Locale } from "@citroen-store/rihla-agent";
import { getBrandContext, toAgentContext } from "@/lib/brand-context";
import { composeJeepPrompt } from "@/lib/jeep-prompt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CITROEN_FALLBACK: BrandContext = {
  brandSlug: "citroen-ma",
  brandName: "Citroën Maroc",
  agentName: "Rihla",
  market: "MA",
  defaultCurrency: "MAD",
  models: [
    { slug: "c3-aircross", name: "C3 Aircross", priceFrom: 234900, currency: "MAD", fuel: "Hybrid", seats: 5 },
    { slug: "c5-aircross", name: "C5 Aircross", priceFrom: 295900, currency: "MAD", fuel: "PHEV", seats: 5 },
    { slug: "berlingo", name: "Berlingo", priceFrom: 195900, currency: "MAD", fuel: "Diesel", seats: 7 },
  ],
};

function mapLocale(l: string | null, market: string): Locale {
  if (market === "SA") {
    if (l === "ar" || l === "ar-SA") return "ar-SA";
    return "en-SA";
  }
  if (l === "darija") return "darija-MA";
  if (l === "ar") return "ar-MA";
  if (l === "en") return "en-MA";
  return "fr-MA";
}

// Welcome message — three short paragraphs: greet, list scope, invite. Lists
// the agent's scope so the customer knows what to ask. Ends with a direct
// "how can I help" so the customer feels invited to speak.
const OPENING_BY_LOCALE: Record<Locale, (brandName: string, agentName: string) => string> = {
  "fr-MA": (b) => `Bienvenue chez ${b}.

Je suis votre assistant virtuel, à votre disposition pour tout ce qui touche à l'univers Jeep au Maroc : découverte de la gamme, essais, configuration, financement, entretien et service après-vente.

Comment puis-je vous aider aujourd'hui ?`,
  "darija-MA": (b) => `مرحبا بيك ف ${b}.

أنا الـ assistant virtuel ديالك، رهن إشارتك ف كل ما يخص عالم Jeep فالمغرب : اكتشاف الـ gamme، essais، configuration، financement، entretien و service après-vente.

كيفاش نقدر نعاونك اليوم ؟`,
  "ar-MA": (b) => `أهلاً بكم في ${b}.

أنا مساعدكم الافتراضي، في خدمتكم لكل ما يتعلق بعالم Jeep في المغرب : اكتشاف المجموعة، تجارب القيادة، التهيئة، التمويل، الصيانة وخدمة ما بعد البيع.

كيف يمكنني مساعدتكم اليوم ؟`,
  "en-MA": (b) => `Welcome to ${b}.

I'm your virtual assistant, here for everything Jeep in Morocco: exploring the range, test drives, configuration, financing, maintenance and after-sales service.

How can I help you today?`,
  "ar-SA": (b) => `أهلاً بكم في ${b}.

أنا مساعدكم الافتراضي، في خدمتكم لكل ما يتعلق بعالم Jeep : اكتشاف المجموعة، تجارب القيادة، التهيئة، التمويل، الصيانة وخدمة ما بعد البيع.

كيف يمكنني مساعدتكم اليوم ؟`,
  "en-SA": (b) => `Welcome to ${b}.

I'm your virtual assistant, here for everything Jeep: exploring the range, test drives, configuration, financing, maintenance and after-sales service.

How can I help you today?`,
};

const LANG_REMINDER: Record<Locale, string> = {
  "fr-MA": "LANGUAGE: Speak in CLEAN STANDARD FRENCH only. No Moroccan accent. No darija words. No 'Merhba', no 'Hamdulillah', no 'Inshallah'.",
  "darija-MA": "LANGUAGE: Speak in Moroccan Darija only. Arabic script in transcripts.",
  "ar-MA": "LANGUAGE: Speak in Modern Standard Arabic (fus'ha). No Moroccan dialect words.",
  "en-MA": "LANGUAGE: Speak in clean neutral English only. No Moroccan/Arabic greetings mixed in.",
  "ar-SA": "LANGUAGE: Speak in formal Modern Standard Arabic or polite Saudi dialect. No Moroccan or Egyptian dialect.",
  "en-SA": "LANGUAGE: Speak in clean professional English with a warm Gulf-friendly tone. No darija, no 'Inshallah'.",
};

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const brandSlug = url.searchParams.get("brand") ?? "citroen-ma";
  const localeParam = url.searchParams.get("locale");
  const voice = url.searchParams.get("voice") === "1";

  let brand: BrandContext = CITROEN_FALLBACK;
  let customBody: string | undefined;
  let voiceName = "Zephyr";

  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const ctx = await getBrandContext(brandSlug);
      if (ctx) {
        brand = toAgentContext(ctx);
        // jeep-ma's prompt is the modular composition under `lib/jeep-prompt/`;
        // ignore any stale Supabase customBody so there's a single source.
        customBody = brandSlug === "jeep-ma" ? undefined : (ctx.activePrompt?.body ?? undefined);
        voiceName = ctx.brand.voice_name;
      }
    } catch (err) {
      console.warn("[system-prompt] brand load failed:", (err as Error).message.slice(0, 100));
    }
  }

  const locale = mapLocale(localeParam, brand.market);
  const baseSystem = buildSystemPrompt({ locale, brand, customBody });

  // APV chassis-first override (Jeep voice + chat). Lives in code so it always
  // takes precedence over whatever prompt version is in Supabase. Voice can't
  // use the server-side VIN PREFILL injection trick the chat route uses (the
  // system prompt is sent ONCE at session start), so the model is told here
  // to call lookup_vin(vin) the moment the customer dictates the chassis
  // number; the dispatcher returns the prefilled record as the tool result.
  // Inject today's date so the model has a stable reference when the customer
  // says "demain" / "lundi prochain" / "غدا". Without this the model
  // hallucinates years (e.g. "y009-05-31") and the booking fails downstream.
  const todayIso = new Date().toISOString().slice(0, 10);
  const todayHumanFr = new Date().toLocaleDateString("fr-MA", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });

  // Voice path: the WebSocket sends the system prompt ONCE at session
  // start with no history. We can't re-classify intent mid-call, so we
  // pass mode:"voice" and load ALL flow modules (sales + apv-rdv + apv-
  // complaint) plus a top-of-prompt intent router that tells the model
  // how to pick. Without this, an APV customer ("je veux une vidange")
  // gets walked through the SALES field list with no VIN ask.
  const apvOverride = brand.brandSlug === "jeep-ma"
    ? composeJeepPrompt({ todayIso, todayHumanFr, mode: voice ? "voice" : "chat" }).prompt
    : "";

  const voiceSuffix = voice
    ? `

VOICE MODE — YOU ARE ON A LIVE PHONE CALL:
${LANG_REMINDER[locale]}

SPEECH RULES:
- NO markdown, asterisks, emojis, bullet lists. Plain spoken words only.
- 1 to 2 short sentences per turn. Like a real phone call.
- Say one natural sentence BEFORE each tool call. Never expose parameter names.
- Repeat phone numbers back digit by digit to confirm before booking.
- Spell numbers and prices in words.

CALL BEHAVIOR:
- YOU speak FIRST. Open with: "${OPENING_BY_LOCALE[locale](brand.brandName, brand.agentName)}"
- Follow the qualification flow strictly. One question per turn.
- Never invent prices, specs, availability, financing rates, or discounts. Only use the catalog above.

SHOW THE CAR ON SCREEN — IMPORTANT:
- The voice widget has a small image overlay on top of the call view. The customer is staring at it the whole call.
- Whenever you mention or recommend a SPECIFIC model by name, IMMEDIATELY call show_model_image(slug="<canonical-slug>") so the picture appears next to your face.
- Use the EXACT lowercase hyphenated slug from the CATALOG block above — e.g. show_model_image(slug="wrangler"), show_model_image(slug="grand-cherokee"), show_model_image(slug="compass"). NEVER pass the brand prefix ("jeep-wrangler"), NEVER capitalize, NEVER add the year.
- One image per model per call. The widget de-dupes silently — don't worry about repeating, the dispatcher drops duplicates.
- If the customer asks "show me X" / "ورّيني X" / "montre-moi X" — call show_model_image FIRST, then verbalize one short sentence about the car. The visual lands while you start talking — that's the experience we want.

ENDING THE CALL — ABSOLUTE RULE:
You MUST call end_call() the moment the user signals they're done — or right after a successful booking + farewell. Trigger words (case-insensitive, partial match):
  • EN: "bye", "goodbye", "thanks", "thank you", "i'm done", "that's all", "talk later", "no thanks"
  • FR: "au revoir", "merci", "à bientôt", "salut", "bonne journée", "non merci", "c'est bon"
  • AR/Darija: "شكرا", "شكراً", "بسلامة", "في أمان الله", "مع السلامة", "يالله", "يالاه", "صافي", "خلاص", "تمام", "بزاف", "مع السلامة"
  • Saudi: "تسلم", "الله يعطيك العافية", "وداعاً"

When ending: ONE short farewell sentence in the user's language, then IMMEDIATELY call end_call(). DO NOT continue. DO NOT ask another question after a farewell. DO NOT say "anything else?" — just end.`
    : "";

  return Response.json({
    systemPrompt: baseSystem + apvOverride + voiceSuffix,
    opening: OPENING_BY_LOCALE[locale](brand.brandName, brand.agentName),
    voiceName,
    brand: { slug: brand.brandSlug, name: brand.brandName, agentName: brand.agentName },
    locale,
  });
}

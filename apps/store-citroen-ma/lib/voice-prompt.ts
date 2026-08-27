// Shared assembly of the Rihla system prompt + agent settings.
//
// Extracted out of app/api/rihla/system-prompt/route.ts so the voice TOKEN
// route can build the exact same prompt. In constrained Live mode the browser's
// `setup` message is discarded by Google, so the system instruction has to be
// baked into the ephemeral token server-side — and it must match what the chat
// path uses, or voice and chat drift apart.

import { buildSystemPrompt, type BrandContext, type Locale } from "@citroen-store/rihla-agent";
import { getBrandContext, toAgentContext } from "@/lib/brand-context";
import { composeJeepPrompt } from "@/lib/jeep-prompt";

// Jeep-only deployment: fallback is Jeep (NARA + Jeep models), never Citroën.
export const JEEP_FALLBACK: BrandContext = {
  brandSlug: "jeep-ma",
  brandName: "Jeep Maroc",
  agentName: "NARA",
  market: "MA",
  defaultCurrency: "MAD",
  models: [
    { slug: "avenger", name: "Avenger", priceFrom: 271055, currency: "MAD", fuel: "MHEV", seats: 5 },
    { slug: "compass", name: "Compass", priceFrom: 344000, currency: "MAD", fuel: "MHEV", seats: 5 },
    { slug: "wrangler", name: "Wrangler", priceFrom: 870000, currency: "MAD", fuel: "4xe", seats: 5 },
    { slug: "grand-cherokee", name: "Grand Cherokee", priceFrom: 950000, currency: "MAD", fuel: "4xe", seats: 5 },
    { slug: "renegade", name: "Renegade", priceFrom: 280000, currency: "MAD", fuel: "MHEV", seats: 5 },
  ],
};

export function mapLocale(l: string | null, market: string): Locale {
  if (market === "SA") {
    if (l === "ar" || l === "ar-SA") return "ar-SA";
    return "en-SA";
  }
  if (l === "darija") return "darija-MA";
  if (l === "ar") return "ar-MA";
  if (l === "en") return "en-MA";
  return "fr-MA";
}

// Welcome message — three short paragraphs: greet, list scope, invite.
export const OPENING_BY_LOCALE: Record<Locale, (brandName: string, agentName: string) => string> = {
  "fr-MA": (b) => `Bienvenue chez ${b}.

Je suis votre assistante virtuelle, à votre disposition pour tout ce qui touche à l'univers Jeep au Maroc : découverte de la gamme, essais, configuration, financement, entretien et service après-vente.

Comment puis-je vous aider aujourd'hui ?`,
  "darija-MA": (b) => `مرحبا بيك ف ${b}.

أنا الـ assistante virtuelle ديالك، رهن إشارتك ف كل ما يخص عالم Jeep فالمغرب : اكتشاف الـ gamme، essais، configuration، financement، entretien و service après-vente.

كيفاش نقدر نعاونك اليوم ؟`,
  "ar-MA": (b) => `أهلاً بكم في ${b}.

أنا مساعدتكم الافتراضية، في خدمتكم لكل ما يتعلق بعالم Jeep في المغرب : اكتشاف المجموعة، تجارب القيادة، التهيئة، التمويل، الصيانة وخدمة ما بعد البيع.

كيف يمكنني مساعدتكم اليوم ؟`,
  "en-MA": (b) => `Welcome to ${b}.

I'm your virtual assistant, here for everything Jeep in Morocco: exploring the range, test drives, configuration, financing, maintenance and after-sales service.

How can I help you today?`,
  "ar-SA": (b) => `أهلاً بكم في ${b}.

أنا مساعدتكم الافتراضية، في خدمتكم لكل ما يتعلق بعالم Jeep : اكتشاف المجموعة، تجارب القيادة، التهيئة، التمويل، الصيانة وخدمة ما بعد البيع.

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

export type AssembledPrompt = {
  systemPrompt: string;
  opening: string;
  voiceName: string;
  locale: Locale;
  brand: BrandContext;
};

/** Assemble the full system prompt for a brand. `voice: true` appends the
 *  live-call rules and loads all flow modules (sales + APV) since the voice
 *  session can't re-classify intent mid-call. */
export async function assemblePrompt(args: {
  brandSlug: string;
  localeParam: string | null;
  voice: boolean;
}): Promise<AssembledPrompt> {
  let brand: BrandContext = JEEP_FALLBACK;
  let customBody: string | undefined;
  let voiceName = "Aoede";

  try {
    const ctx = await getBrandContext(args.brandSlug);
    if (ctx) {
      brand = toAgentContext(ctx);
      // jeep-ma's prompt is the modular composition under `lib/jeep-prompt/`;
      // ignore any stale customBody so there's a single source.
      customBody = args.brandSlug === "jeep-ma" ? undefined : (ctx.activePrompt?.body ?? undefined);
      voiceName = ctx.brand.voice_name;
    }
  } catch (err) {
    console.warn("[voice-prompt] brand load failed:", (err as Error).message.slice(0, 100));
  }

  const locale = mapLocale(args.localeParam, brand.market);
  const baseSystem = buildSystemPrompt({ locale, brand, customBody });

  const todayIso = new Date().toISOString().slice(0, 10);
  const todayHumanFr = new Date().toLocaleDateString("fr-MA", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });

  const apvOverride =
    brand.brandSlug === "jeep-ma"
      ? composeJeepPrompt({ todayIso, todayHumanFr, mode: args.voice ? "voice" : "chat" }).prompt
      : "";

  const opening = OPENING_BY_LOCALE[locale](brand.brandName, brand.agentName);

  const voiceSuffix = args.voice
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
- YOU speak FIRST. Open with: "${opening}"
- Follow the qualification flow strictly. One question per turn.
- Never invent prices, specs, availability, financing rates, or discounts. Only use the catalog above.

SCOPE — YOU ARE JEEP MAROC, NOTHING ELSE:
- You represent ${brand.brandName} ONLY. Every vehicle name the customer says refers to a JEEP model from the catalog above.
- "Avenger" ALWAYS means the Jeep Avenger. NEVER the Marvel films, NEVER a Dodge. "Compass" is the Jeep Compass, never a navigation instrument. Never ask the customer to disambiguate a model name against something outside Jeep.
- If asked about anything unrelated to Jeep Maroc, briefly say it's outside your scope and steer back to the Jeep range, a test drive, or after-sales.

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

  return {
    systemPrompt: baseSystem + apvOverride + voiceSuffix,
    opening,
    voiceName,
    locale,
    brand,
  };
}

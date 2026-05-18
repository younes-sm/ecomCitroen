"use client";

import Image from "next/image";
import { motion } from "framer-motion";

export type VoiceLang = "fr" | "ar" | "en" | "darija";

export type LangConfig = {
  id: VoiceLang;
  label: string;
  native: string;
  sttTag: string;
  greeting: string;
  flag: string;
  hint: string;
};

const LANGS: LangConfig[] = [
  {
    id: "fr",
    label: "Français",
    native: "Français",
    sttTag: "fr-FR",
    // Capability-aware welcome: tells the customer what the agent can do for
    // them (explore models, compare specs, find dealers, book a test drive)
    // and ends with an open invitation. Sets a Phase-1 tone — discovery and
    // information first, qualification later when they signal readiness.
    greeting: "Bonjour ! Je suis Rihla, conseillère automobile. Je peux vous présenter les modèles, comparer les caractéristiques, trouver le concessionnaire le plus proche et organiser un essai quand vous serez prêt(e). Par quoi commençons-nous ?",
    flag: "🇫🇷",
    hint: "Bonjour",
  },
  {
    id: "darija",
    label: "Darija",
    native: "الدارجة المغربية",
    sttTag: "ar-MA",
    greeting: "السلام ! أنا رحلة، المستشارة ديالك. كنقدر نوريك الموديلات، نقارن المواصفات، نلقى ليك الوكالة القريبة، و نحجز ليك تجربة قيادة فاش تكون مستعد. منين نبداو ؟",
    flag: "🇲🇦",
    hint: "مرحبا",
  },
  {
    id: "ar",
    label: "العربية",
    native: "العربية الفصحى",
    sttTag: "ar-SA",
    greeting: "أهلاً وسهلاً ! أنا رحلة، مستشارتك. أقدر أعرض لك الموديلات، أقارن المواصفات، ألاقي لك أقرب معرض، وأرتّب لك قيادة اختبارية لما تكون جاهز. من وين نبدأ ؟",
    flag: "🇸🇦",
    hint: "أهلاً",
  },
  {
    id: "en",
    label: "English",
    native: "English",
    sttTag: "en-US",
    greeting: "Hi! I'm Rihla, your advisor. I can walk you through the models, compare specs and pricing, find the nearest dealer, and book a test drive when you're ready. Where would you like to start?",
    flag: "🇬🇧",
    hint: "Hello",
  },
];

export function getLangConfig(id: VoiceLang) {
  return LANGS.find((l) => l.id === id) ?? LANGS[0]!;
}

/** APV-aware welcomes — used by widgets that ALSO handle after-sales (RDV /
 *  Info / Réclamation), currently jeep-ma only. The default sales-only
 *  greetings live in the LANGS table above. Three-paragraph welcome: greet,
 *  list scope, invite. Mirrors the server-side OPENING_BY_LOCALE in
 *  /api/rihla/system-prompt — keep the two in sync. */
const APV_GREETINGS: Record<VoiceLang, string> = {
  fr: `Bienvenue chez Jeep Maroc.

Je suis votre assistant virtuel, à votre disposition pour tout ce qui touche à l'univers Jeep au Maroc : découverte de la gamme, essais, configuration, financement, entretien et service après-vente.

Comment puis-je vous aider aujourd'hui ?`,
  darija: `مرحبا بيك ف Jeep Maroc.

أنا الـ assistant virtuel ديالك، رهن إشارتك ف كل ما يخص عالم Jeep فالمغرب : اكتشاف الـ gamme، essais، configuration، financement، entretien و service après-vente.

كيفاش نقدر نعاونك اليوم ؟`,
  ar: `أهلاً بكم في Jeep Maroc.

أنا مساعدكم الافتراضي، في خدمتكم لكل ما يتعلق بعالم Jeep في المغرب : اكتشاف المجموعة، تجارب القيادة، التهيئة، التمويل، الصيانة وخدمة ما بعد البيع.

كيف يمكنني مساعدتكم اليوم ؟`,
  en: `Welcome to Jeep Maroc.

I'm your virtual assistant, here for everything Jeep in Morocco: exploring the range, test drives, configuration, financing, maintenance and after-sales service.

How can I help you today?`,
};

/** Returns the greeting to use as the chat opener — falls back to the
 *  sales-only LANGS greeting for any brand that doesn't enable APV. */
export function getOpeningGreeting(lang: VoiceLang, brandSlug: string): string {
  if (brandSlug === "jeep-ma") return APV_GREETINGS[lang];
  return getLangConfig(lang).greeting;
}

const HEADER_LINES = ["Bonjour", "مرحبا", "Hello"];

export function LanguagePicker({
  onSelect,
  available,
  accent = "#0c0c10",
  agentName = "Rihla",
}: {
  onSelect: (lang: VoiceLang) => void;
  available?: VoiceLang[];
  accent?: string;
  /** Persona name shown in the "Powered by …" footer. */
  agentName?: string;
}) {
  const langs = available && available.length > 0 ? LANGS.filter((l) => available.includes(l.id)) : LANGS;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
      className="relative flex h-full flex-col overflow-hidden bg-gradient-to-b from-[#fafafa] to-white px-5 pt-7 pb-5"
    >
      {/* Soft accent halo behind avatar */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[260px]"
        style={{
          background: `radial-gradient(60% 100% at 50% 0%, ${accent}1A 0%, transparent 70%)`,
        }}
      />

      <div className="text-center">
        <motion.div
          initial={{ scale: 0.85, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.05, duration: 0.45, ease: [0.22, 0.68, 0, 1] }}
          className="relative mx-auto h-[88px] w-[88px]"
        >
          {/* Pulsing ring */}
          <motion.div
            aria-hidden
            className="absolute inset-0 rounded-full"
            style={{ boxShadow: `0 0 0 0 ${accent}55` }}
            animate={{
              boxShadow: [
                `0 0 0 0 ${accent}55`,
                `0 0 0 14px ${accent}00`,
              ],
            }}
            transition={{ duration: 2.4, repeat: Infinity, ease: "easeOut" }}
          />
          <div className="relative h-full w-full overflow-hidden rounded-full ring-4 ring-white shadow-[0_12px_32px_-10px_rgba(0,0,0,0.35)]">
            <Image
              src="/brand/rihla-avatar.jpg"
              alt="Rihla"
              fill
              priority
              sizes="88px"
              className="object-cover"
            />
          </div>
          {/* Online dot */}
          <span className="absolute bottom-1 end-1 inline-block h-3.5 w-3.5 rounded-full border-2 border-white bg-emerald-400" />
        </motion.div>

        <motion.div
          initial={{ y: 8, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.18, duration: 0.4 }}
          className="mt-5 flex items-center justify-center gap-2 text-[14px] font-medium text-[#0c0c10]"
        >
          {HEADER_LINES.map((w, i) => (
            <span key={w} className="inline-flex items-center gap-2">
              {i > 0 && <span className="h-1 w-1 rounded-full bg-black/15" />}
              <span>{w}</span>
            </span>
          ))}
        </motion.div>

        <motion.p
          initial={{ y: 8, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.24, duration: 0.4 }}
          className="mt-1.5 text-[12px] text-black/45"
        >
          Choisissez votre langue · اختر لغتك · Select your language
        </motion.p>
      </div>

      <div className="mt-7 grid flex-1 grid-cols-2 content-center gap-2.5">
        {langs.map((lang, i) => (
          <motion.button
            key={lang.id}
            type="button"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 + i * 0.06, duration: 0.35, ease: [0.22, 0.68, 0, 1] }}
            whileHover={{ y: -2 }}
            whileTap={{ scale: 0.97 }}
            onClick={() => onSelect(lang.id)}
            className="group relative flex flex-col items-start gap-2 overflow-hidden rounded-2xl bg-white p-4 text-start shadow-[0_1px_3px_rgba(0,0,0,0.05),0_0_0_1px_rgba(0,0,0,0.05)] transition hover:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.18),0_0_0_1px_rgba(0,0,0,0.08)]"
          >
            <span
              className="absolute inset-x-0 top-0 h-[2px] origin-left scale-x-0 transition-transform duration-300 group-hover:scale-x-100"
              style={{ background: accent }}
            />
            <div className="flex w-full items-center justify-between">
              <span className="text-2xl leading-none">{lang.flag}</span>
              <span className="text-[10px] uppercase tracking-[0.16em] text-black/30">
                {lang.id.toUpperCase()}
              </span>
            </div>
            <div>
              <div className="text-[13px] font-semibold text-[#0c0c10]">{lang.label}</div>
              <div className="mt-0.5 truncate text-[11px] text-black/40">
                {lang.hint}
              </div>
            </div>
          </motion.button>
        ))}
      </div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.55 }}
        className="mt-4 flex items-center justify-center gap-1.5 text-[10px] uppercase tracking-[0.2em] text-black/30"
      >
        Powered by {agentName}
      </motion.div>
    </motion.div>
  );
}

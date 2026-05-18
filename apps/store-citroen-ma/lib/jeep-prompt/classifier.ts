// Intent classifier — picks one of four prompt assembly modes:
// "sales" (test drive / showroom visit), "apv-rdv" (service appointment),
// "apv-complaint" (réclamation), "discovery" (default — agent asks before
// committing to a flow).
//
// Conservative by design: when ambiguous, returns "discovery" so the agent
// asks the customer rather than guessing wrong. Only commits to a flow when
// the customer's own words clearly signal intent.

export type Intent = "sales" | "apv-rdv" | "apv-complaint" | "discovery";

export type ClassifierMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

const SALES_PATTERNS = [
  // FR
  /\b(test\s*drive|essai(\s+routier)?|tester|essayer)\b/i,
  /\b(j['e]\s*veux|je\s+voudrais|je\s+souhaite)\s+(acheter|achat|essayer|tester)/i,
  /\b(j['e]\s*ai\s+besoin\s+d['e]?\s*acheter)\b/i,
  /\b(visiter|visite)\s+(la\s+maison|le\s+showroom)/i,
  /\b(réserver|reserver|bloquer|caler)\s+(un|le|mon)\s+(essai|rendez-vous)/i,
  /\b(combien|prix|tarif|clé\s*en\s*main).*(jeep|avenger|compass|wrangler|grand\s*cherokee|renegade)/i,
  // EN
  /\b(i\s+want\s+to\s+(buy|test|try)|i'?d\s+like\s+to\s+(buy|test))/i,
  /\b(test\s*drive|showroom\s+visit|book\s+a\s+(test|visit))/i,
  // Arabic / Darija
  /(بغيت|نبغي|عاوز).*(نشري|نشاري|essai|تجربة)/,
  /تجربة\s*قيادة/,
  /زيارة\s*(المعرض|la\s*maison|الشوروم)/,
  /تيبريوا/,
];

const APV_RDV_PATTERNS = [
  // FR
  /\b(rendez-?vous|RDV)\s*(atelier|sav|service|d['e]?\s*entretien)?/i,
  /\b(service\s+rapide|vidange|révision|revision|entretien|filtre|freins?|pneus?|batterie)\b/i,
  /\b(panne|tombée?\s+en\s+panne|voyant\s+allumé|moteur|boîte\s+de\s+vitesse|embrayage|fuite|démarrage\s+difficile)\b/i,
  /\b(accident|choc|rayure|carrosserie|peinture|bosse|pare-?choc)\b/i,
  /\b(ma\s+voiture|mon\s+véhicule).*(panne|problème|ne\s+marche|ne\s+démarre)/i,
  // EN
  /\b(service\s+appointment|workshop\s+appointment|oil\s+change|brake\s+check)/i,
  /\b(my\s+car).*(broken|not\s+working|warning\s+light|won'?t\s+start)/i,
  /\b(quick\s+service|maintenance|breakdown)\b/i,
  // Arabic / Darija
  /(rendez-?vous|rdv).*(atelier|service|صيانة)/i,
  /(خسرت|خسرتس|سكتات|ما\s*خدامش|ما\s*كتخدمش|panne|voyant)/,
  /(الطوموبيل|السيارة|الموتور)\s+(ديالي|ما\s+خدماش|خسرات|عندها\s+مشكل)/,
  /(صيانة|vidange|révision|بنوات|فرام)/,
];

const APV_COMPLAINT_PATTERNS = [
  // FR
  /\b(réclamation|reclamation|porter\s+plainte|déposer\s+une\s+plainte)\b/i,
  /\b(je\s+suis\s+mécontent|pas\s+satisfait|insatisfait|déçu)\b/i,
  /\b(le\s+service\s+a\s+été\s+mauvais|mal\s+passé|j['e]\s*ai\s+un\s+problème\s+avec\s+le\s+service)\b/i,
  // EN
  /\b(file\s+a\s+complaint|formal\s+complaint|i'?m\s+(unhappy|dissatisfied|disappointed))\b/i,
  // Arabic / Darija
  /(شكوى|كنشكي|réclamation|reclamation)/i,
  /(ما\s+عجبنيش|غير\s+راضي|ماشي\s+مزيان|عندي\s+مشكل\s+مع\s+الخدمة)/,
];

function matches(patterns: RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text));
}

export function classifyIntent(messages: ClassifierMessage[] | undefined): Intent {
  if (!messages || messages.length === 0) return "discovery";

  // Walk user messages from most recent backwards. The most recent intent
  // wins — a context switch ("aussi je veux un RDV atelier") flips the flow.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "user") continue;
    const text = m.content ?? "";
    if (!text) continue;

    if (matches(APV_COMPLAINT_PATTERNS, text)) return "apv-complaint";
    if (matches(APV_RDV_PATTERNS, text)) return "apv-rdv";
    if (matches(SALES_PATTERNS, text)) return "sales";
  }

  return "discovery";
}

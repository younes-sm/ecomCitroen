// Brand-aware system prompt builder.
//
// Two ways to use this:
//   1. Pass `customBody` from the database — admins edit the prompt live, we
//      just substitute brand variables and append it.
//   2. No customBody → use the default template below (keyed off brand info).

export type Locale = "fr-MA" | "ar-MA" | "darija-MA" | "en-MA" | "ar-SA" | "en-SA";

export type BrandContext = {
  brandSlug: string;
  brandName: string;          // "Jeep Maroc"
  agentName: string;          // "Rihla"
  market: string;             // "MA" / "SA"
  defaultCurrency: string;    // "MAD" / "SAR"
  /** Cities where this brand has at least one active showroom. Empty when no
   *  data — the prompt will skip the coverage section in that case. */
  servedCities?: string[];
  models: Array<{
    slug: string;
    name: string;
    tagline?: string | null;
    priceFrom?: number | null;
    currency?: string | null;
    fuel?: string | null;
    seats?: number | null;
    bodyType?: string | null;
    keyFeatures?: string[];
  }>;
};

export type SystemPromptInput = {
  locale: Locale;
  brand: BrandContext;
  dealerCityHint?: string;
  returningUser?: boolean;
  sessionSummary?: string;
  /** If provided, this is used verbatim as the brand-specific body of the prompt. */
  customBody?: string;
};

function languageBlock(locale: Locale): string {
  if (locale === "fr-MA") {
    return `═══ LANGUE — FRANÇAIS STANDARD ═══

Tu parles un français STANDARD, neutre, professionnel et chaleureux. Comme une conseillère commerciale à Paris ou Lyon.

RÈGLES STRICTES :
- JAMAIS de mots en darija ou en arabe. Pas de "Merhba", pas de "Hamdulillah", pas de "Inshallah", pas de "Wakha".
- JAMAIS d'accent marocain ni de formulations marocaines. Accent et intonation français standard.
- Accueil : "Bonjour" — PAS "Merhba".
- Affirmation : "D'accord", "Très bien" — PAS "Wakha".
- Français clair, fluide, bien articulé. Comme à la radio française.`;
  }
  if (locale === "darija-MA") {
    return `═══ اللغة — الدارجة المغربية ═══

تهضر فقط بالدارجة المغربية، مكتوبة بالحروف العربية.

قواعد صارمة :
- ما تستعملش حروف لاتينية أبداً.
- ما تبدلش للهجة المصرية أو الخليجية أو الشامية. دارجة مغربية صافية فقط.
- استعمل المذكر المفرد دائماً : "شنو كتقلب عليه" ماشي "كتقلبي".
- ترحيب : "مرحبا بيك". تأكيد : "واخا".`;
  }
  if (locale === "ar-MA") {
    return `═══ اللغة — العربية الفصحى ═══

تحدث بالعربية الفصحى، رسمياً ودافئاً. بدون لهجة مغربية.
- الترحيب : "أهلاً وسهلاً". الموافقة : "حسناً".`;
  }
  if (locale === "ar-SA") {
    return `═══ اللغة — العربية الفصحى ═══

تحدث بالعربية الفصحى أو اللهجة السعودية الراقية. مهنية ودافئة.
- لا تستعمل اللهجة المغربية أو المصرية.
- الترحيب : "أهلاً وسهلاً" أو "حياك الله". الموافقة : "حاضر"، "تمام".`;
  }
  if (locale === "en-SA") {
    return `═══ LANGUAGE — CLEAN ENGLISH ═══

You speak clean, professional English with a warm Gulf-friendly tone. Polite, courteous.
- No Arabic / French words mixed in. No "Inshallah" or "Hamdulillah" in the English greeting.
- Greeting: "Hello" / "Welcome". Confirmation: "Of course", "Certainly".`;
  }
  // en-MA
  return `═══ LANGUAGE — CLEAN ENGLISH ═══

You speak clean, neutral, warm English. Professional but friendly.
- No darija / Arabic words mixed in. No "Merhba", "Inshallah", "Hamdulillah".
- Greeting: "Hello" or "Hi". Confirmation: "Alright", "Got it", "Perfect".`;
}

function modelCatalog(brand: BrandContext): string {
  if (brand.models.length === 0) {
    return "═══ CATALOG ═══\n\n(no models configured for this brand yet.)";
  }
  const lines = brand.models.map((m) => {
    const price = m.priceFrom != null ? ` — from ${m.priceFrom.toLocaleString()} ${m.currency ?? brand.defaultCurrency}` : "";
    const meta = [m.bodyType, m.fuel, m.seats ? `${m.seats} seats` : null].filter(Boolean).join(" · ");
    const features = (m.keyFeatures ?? []).slice(0, 3).join(" · ");
    return `${m.name} (slug: ${m.slug})${price}\n  ${meta}\n  ${features}`;
  });
  return `═══ CATALOG — ${brand.brandName.toUpperCase()} ═══\n\n(Use ONLY these models. Never invent. Pass the slug to tools.)\n\n${lines.join("\n\n")}`;
}

function coverageBlock(brand: BrandContext): string {
  const cities = brand.servedCities ?? [];
  if (cities.length === 0) return "";
  const list = cities.join(", ");
  return [
    `═══ SHOWROOM COVERAGE — ${brand.brandName.toUpperCase()} ═══`,
    "",
    `${brand.brandName} currently operates showrooms ONLY in these cities: ${list}.`,
    "",
    "If the customer names a city NOT in this list (e.g. they say Dubai when we only serve KSA cities, or a small Moroccan town we don't cover):",
    "  1. Acknowledge briefly and warmly — never get stuck or silent.",
    "  2. Tell them the cities you DO serve, in their language.",
    "  3. Ask which of those is closest to them, OR offer to take their details so a dealer can call.",
    "",
    "Never invent a showroom. Never promise coverage outside the listed cities. Never repeat a city the user already gave you as if it were your suggestion.",
  ].join("\n");
}

export function buildSystemPrompt(input: SystemPromptInput): string {
  const { locale, brand, dealerCityHint, returningUser, sessionSummary, customBody } = input;

  // Persona description in English so the prompt instructions never leak into
  // the customer-facing language. The LANGUAGE block below tells the model
  // what to actually say to users.
  const head = `You are ${brand.agentName}, a senior sales advisor for ${brand.brandName}. Always respond to the customer in the language defined by the LANGUAGE block below.`;

  // If the admin has provided a custom prompt body, render it verbatim with
  // brand-aware language + catalog + coverage blocks appended for safety.
  if (customBody && customBody.trim().length > 0) {
    const coverage = coverageBlock(brand);
    return [
      head,
      "",
      languageBlock(locale),
      "",
      customBody.trim(),
      "",
      modelCatalog(brand),
      coverage ? "\n" + coverage : "",
      "",
      contextBlock({ locale, dealerCityHint, returningUser, sessionSummary }),
    ].filter(Boolean).join("\n");
  }

  // Default flow — same skeleton as before but brand-driven.
  return [
    head,
    "",
    "═══ MISSION ═══",
    "",
    "Ton SEUL objectif : qualifier le client et booker un essai en 3 à 6 tours. Chaleureuse mais directe. Pas de bavardage.",
    "",
    "Le lead est capturé quand tu as : usage + budget + prénom + numéro mobile + ville + créneau d'essai.",
    "",
    languageBlock(locale),
    "",
    "═══ STYLE ═══",
    "- 1 à 2 phrases par tour. Jamais plus.",
    "- UNE SEULE question par tour. Jamais deux en même temps.",
    "- Dès que le client donne son prénom, utilise-le à chaque tour.",
    "- JAMAIS de noms techniques (slug, color id, etc).",
    "",
    "═══ FLOW OBLIGATOIRE ═══",
    "TOUR 1 — Accueil + question d'usage (UNE seule question).",
    "TOUR 2 — Budget TOTAL (montant global à l'achat, jamais mensuel — ne pas mentionner « budget mensuel » ni « mensualité »).",
    "TOUR 3 — UNE recommandation ciblée + appel à open_model() + show_model_image().",
    "TOUR 4 — Demander le PRÉNOM uniquement.",
    "TOUR 5 — Demander le NUMÉRO MOBILE / WhatsApp uniquement (et le répéter pour confirmation).",
    "TOUR 6 — Demander la VILLE uniquement.",
    "TOUR 7 — Demander le CRÉNEAU PRÉFÉRÉ uniquement.",
    "TOUR 8 — Récap + appel à book_test_drive() + end_call().",
    "",
    "═══ FIN D'APPEL ═══",
    "Tu DOIS appeler end_call() après toute phrase d'au revoir, après un booking réussi, ou après deux refus. Jamais relancer après end_call().",
    "",
    modelCatalog(brand),
    "",
    coverageBlock(brand),
    "",
    "═══ OUTILS ═══",
    "- open_model(slug) → Ouvrir la page du modèle (côté brand-site, nouvel onglet).",
    "- show_model_image(slug, angle?) → Afficher une image du modèle inline dans la conversation.",
    "- open_brand_page(slug) → Ouvrir la page officielle du modèle sur le site de la marque (nouvel onglet).",
    "- calculate_financing(price, downPayment, term) → Calculer la mensualité.",
    "- book_test_drive(slug, firstName, phone, city, slot) → Réserver l'essai.",
    "- end_call() → Terminer l'appel après l'au revoir.",
    "",
    contextBlock({ locale, dealerCityHint, returningUser, sessionSummary }),
  ].join("\n");
}

function contextBlock(args: {
  locale: Locale;
  dealerCityHint?: string;
  returningUser?: boolean;
  sessionSummary?: string;
}) {
  const { locale, dealerCityHint, returningUser, sessionSummary } = args;
  return [
    "═══ CONTEXTE ═══",
    `Locale : ${locale}`,
    dealerCityHint ? `Ville détectée : ${dealerCityHint}.` : "Ville inconnue — demande au tour 6.",
    returningUser ? "Client de retour." : "Nouveau visiteur.",
    sessionSummary ? `Session : ${sessionSummary}` : "Session fraîche.",
  ].join("\n");
}

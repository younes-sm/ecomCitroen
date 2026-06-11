// Salesforce picklist API names for the four dependent fields on the Lead
// payload (Stellantis PROD spec — values exported by NBS via CSV).
//
// CRITICAL: the Lead create call rejects with INVALID_OR_NULL_FOR_RESTRICTED_-
// PICKLIST when an unknown value is sent for any of these fields. Always
// send the API Name (the right column in the CSV), NOT the Label.
//
// Dependencies:
//   - Marque_d_interet__c   ⇨ Serie_Modele__c   (each model belongs to ONE brand)
//   - Dealer__c             ⇨ Showroom__c       (each showroom belongs to ONE dealer)
//
// Showroom__c is NOT in this file — the chatbot already passes the canonical
// "FCA - CASABLANCA - ITALCAR MOTORVILLAGE" style string as the showroom
// identifier (see lib/jeep-prompt/05-data.ts). Those existing strings are
// the API Names for Showroom__c, so they flow through unchanged.

/* ─────────────────── Marque_d_interet__c ─────────────────── */

/** Full picklist export from Salesforce. Label on the left, API Name on
 *  the right. Send the right-hand side in the request body. */
export const MARQUE_API_NAMES = {
  Jeep: "57",
  Fiat: "0",
  "Alfa Romeo": "83",
  ABARTH: "66",
  Peugeot: "AP",
  "DS Automobile": "DS",
  Citroen: "AC",
  VO: "VO",
  Leapmotor: "82",
  Other: "Other",
  Opel: "Opel",
} as const;

export type MarqueLabel = keyof typeof MARQUE_API_NAMES;

/* ─────────────────── Serie_Modele__c ─────────────────── */

/** Full picklist export from Salesforce. Values that look like numeric
 *  codes (e.g. "57-609") use those codes as the API Name; values that
 *  match their Label use the Label itself. Send whatever is on the right. */
export const SERIE_MODELE_API_NAMES = {
  // Jeep
  "Grand Cherokee": "Grand Cherokee",
  Wrangler: "Wrangler",
  Compass: "Compass",
  Avenger: "Avenger",
  "Renegade MHEV": "Renegade MHEV",
  "Compass Hybrid": "Compass Hybrid",
  Renegade: "57-609",
  "Renagde Hybrid": "Renagde Hybrid", // sic — typo on Stellantis side, kept verbatim
  // Fiat
  "500x": "00-334",
  "500": "500",
  "Tipo Sedan": "Tipo Sedan",
  "Tipo HB": "Tipo HB",
  "Tipo Street Edition": "Tipo Street Edition",
  "Fiorino Combi": "Fiorino Combi",
  "Doblo Combi": "Doblo Combi",
  "Fiorino Cargo": "Fiorino Cargo",
  "Doblo Cargo": "Doblo Cargo",
  "Ducato Vitré": "Ducato Vitré",
  "Ducato tolé": "Ducato tolé",
  Topolino: "Topolino",
  "600": "600",
  Fiorino: "00-225",
  Ducato: "00-290",
  "Doblo V": "Doblo V",
  "FIAT 500 MY24": "FIAT 500 MY24",
  "500 cabriolet": "500 cabriolet",
  "Topolino Dolcevita": "Topolino Dolcevita",
  Panda: "Panda",
  talento: "talento",
  fullback: "fullback",
  Scudo: "Scudo",
  Titano: "Titano",
  Albea: "Albea",
  Punto: "Punto",
  Palio: "Palio",
  // Alfa Romeo
  Giulia: "83-620",
  Stelvio: "83-630",
  "Tonale Diesel": "Tonale Diesel",
  "Tonale Hybrid": "Tonale Hybrid",
  "Stelvio Quadrifoglio": "Stelvio Quadrifoglio",
  "Giulia Quadrifoglio": "Giulia Quadrifoglio",
  Junior: "Junior",
  "147": "147",
  Giulietta: "Giulietta",
  // Abarth
  "695": "695",
  "595": "595",
  "595C": "595C",
  "695C": "695C",
  // Citroën
  AMI: "AMI",
  "CITROEN AMI": "CITROEN AMI",
  "CITROEN AMI BUGGY": "CITROEN AMI BUGGY",
  "NEW BERLINGO": "NEW BERLINGO",
  "Nouveau Berlingo": "Nouveau Berlingo",
  "C-ELYSÉE": "C-ELYSÉE",
  "C5 AIRCROSS": "C5 AIRCROSS",
  "C3 AIRCROSS": "C3 AIRCROSS",
  "SUV C3 AIRCROSS": "SUV C3 AIRCROSS",
  "C3 AIRCROSS Essence": "C3 AIRCROSS Essence",
  C3: "C3",
  C4: "C4",
  "C4 X": "C4 X",
  JUMPY: "JUMPY",
  JUMPER: "JUMPER",
  "BERLINGO VU": "BERLINGO VU",
  // Peugeot
  "208": "208",
  "2008": "2008",
  "308": "308",
  "3008": "3008",
  "508": "508",
  "5008": "5008",
  "408": "408",
  "301": "301",
  Rifter: "Rifter",
  Boxer: "Boxer",
  LANDTREK: "LANDTREK",
  "PARTNER VAN": "2PK9",
  "New 3008": "New 3008",
  "New 208": "New 208",
  // DS
  "DS 4": "DS 4",
  "DS 7": "DS 7",
  "DS 5": "DS 5",
  // Leapmotor
  T03: "T03",
  C10: "B11",
  Tris: "Tris",
  // Opel
  Astra: "Astra",
  Corsa: "Corsa",
  Grandland: "Grandland",
  Mokka: "Mokka",
  // Misc
  VO: "VO",
  Bipper: "Bipper",
  Master: "Master",
  Other: "Other",
  ashnooShowroomTest: "ashnooShowroomTest",
} as const;

export type SerieModeleLabel = keyof typeof SERIE_MODELE_API_NAMES;

/* ─────────────────── Dealer__c ─────────────────── */

/** Full picklist export — these are themselves the API Names (no separate
 *  label column in the CSV). Send the exact string. */
export const DEALER_API_NAMES = [
  "AutoHall",
  "La CONTINENTALE SERVICES",
  "STELLANTIS AND YOU",
  "FENIE BROSSETTE",
  "GENIAL AUTO",
  "MANISS AUTO",
  "ORBIS AUTOMOTIVE",
  "SOPRIAM",
  "AshnooDealer",
  "MBA",
  "KMG AUTO",
  "KADI AUTO",
  "NABAM AUTO",
  "MAJDA AUTO",
  "LIXUS AUTO",
  "LIMASUD AUTO",
  "NADOR AUTO",
  "SGA",
  "SUPERDAK AUTO",
  "Flotte NSC",
  "Others PCD",
  "RESEAU",
  "Jaber Auto",
  "SANDI STAR AUTO",
] as const;

export type DealerApiName = (typeof DEALER_API_NAMES)[number];

/* ─────────────────── Showroom__c ─────────────────── */

/** Full Showroom__c picklist export. Label (left) → API Name (right).
 *  CAUTION: for most entries Label === API Name, but a handful of
 *  Peugeot/Citroën rows DIFFER (e.g. "Sopriam MOHAMMADIA" → API
 *  "MOHAMMADIA Siége"). Always use the API Name (right column) in the
 *  request body. */
export const SHOWROOM_API_NAMES = {
  // ── Jeep / FIAT / Alfa Romeo network (FCA prefix) ──────────────────
  "FCA - AGADIR - FENIE BROSSETTE": "FCA - AGADIR - FENIE BROSSETTE",
  "FCA - BENI MELLAL - AUTO HALL": "FCA - BENI MELLAL - AUTO HALL",
  "FCA - CASABLANCA - AUTOHALL BERNOUSSI": "FCA - CASABLANCA - AUTOHALL BERNOUSSI",
  "FCA - CASABLANCA - ITALCAR MOTORVILLAGE": "FCA - CASABLANCA - ITALCAR MOTORVILLAGE",
  "FCA - CASABLANCA MAARIF - ITALCAR MOTORVILLAGE": "FCA - CASABLANCA MAARIF - ITALCAR MOTORVILLAGE",
  "FCA - CASABLANCA - AUTOHALL MLY ISMAIL": "FCA - CASABLANCA - AUTOHALL MLY ISMAIL",
  "FCA - CASABLANCA MASSIRA - ITALCAR MOTORVILLAGE": "FCA - CASABLANCA MASSIRA - ITALCAR MOTORVILLAGE",
  "FCA - KHOURIBGA - AUTO HALL": "FCA - KHOURIBGA - AUTO HALL",
  "FCA - LARACHE - GENIAL AUTO": "FCA - LARACHE - GENIAL AUTO",
  "FCA - MARRAKECH - AUTOHALL CENTRE VILLE": "FCA - MARRAKECH - AUTOHALL CENTRE VILLE",
  "FCA - MARRAKECH - MANISS AUTO ROUTE CASABLANCA": "FCA - MARRAKECH - MANISS AUTO ROUTE CASABLANCA",
  "FCA - OUJDA - AUTO HALL": "FCA - OUJDA - AUTO HALL",
  "FCA - RABAT - ORBIS AUTOMOTIVE": "FCA - RABAT - ORBIS AUTOMOTIVE",
  "FCA - SETTAT - AUTO HALL": "FCA - SETTAT - AUTO HALL",
  "FCA - TANGER - ORBIS AUTOMOTIVE": "FCA - TANGER - ORBIS AUTOMOTIVE",
  "FCA - TETOUAN - AUTO HALL": "FCA - TETOUAN - AUTO HALL",
  "FCA - FES - AUTO HALL": "FCA - FES - AUTO HALL",
  "FCA - KENITRA - AUTO HALL": "FCA - KENITRA - AUTO HALL",
  "FCA - BERKANE - AUTO HALL": "FCA - BERKANE - AUTO HALL",
  "FCA - MEKNES - AUTO HALL": "FCA - MEKNES - AUTO HALL",
  "FCA - NADOR - AUTO HALL": "FCA - NADOR - AUTO HALL",
  "FCA - SAFI - AUTO HALL": "FCA - SAFI - AUTO HALL",
  "Alfa Romeo Massira": "Alfa Romeo Massia", // sic — "Massia" in the API Name
  "VO - CASABLANCA MAARIF - ITALCAR MOTORVILLAGE": "VO - CASABLANCA MAARIF - ITALCAR MOTORVILLAGE",

  // ── Peugeot / Citroën / DS / Leapmotor network ─────────────────────
  // Many entries have a DIFFERENT API Name from their Label here.
  "PEUGEOT SOPRIAM CASA LONGCHAMPS": "PEUGEOT SOPRIAM CASA LONGCHAMPS",
  "PEUGEOT MAJDA AUTO SAFI": "PEUGEOT MAJDA AUTO SAFI",
  "Sopriam MOHAMMADIA": "MOHAMMADIA Siége",
  "BENI MELLAL - KADI AUTO": "Citroën BENI MELLAL - KADI AUTO",
  "CITROEN LARACHE - LIXUS AUTO": "CITROEN LARACHE - LIXUS AUTO",
  "CITROEN ERRACHIDIA - LIMASUD AUTO": "CITROEN ERRACHIDIA - LIMASUD AUTO",
  "CITROËN NADOR - ETS NADOR AUTO": "CITROËN NADOR - ETS NADOR AUTO",
  "Sopriam_Massira": "Sopriam_CasaMK_Siége",
  "SOPRIAM AIN SBAA": "SOPRIAM AIN SBAA - Siège",
  "Sopriam Rabat Ennakhil": "Sopriam Rabat Siège",
  "Sopriam_Kenitra": "Kenitra siège",
  "SOPRIAM Tanger": "SOPRIAM Tanger - Siège",
  "Sopriam EL JADIDA - KMG AUTO": "Sopriam EL JADIDA - KMG AUTO",
  "SOPRIAM MARRAKECH": "SOPRIAM MARRAKECH-Siége",
  "SOPRIAM AGADIR": "SOPRIAM AGADIR_Siége",
  "Sopriam_Fes_Siége": "Sopriam_Fes_Siége",
  "SOPRIAM MEKNES": "SOPRIAM MEKNES_Siége",
  "Sopriam Oujda": "Sopriam Oujda",
  "Sopriam Tetouan": "Citroen tetouan",
  "Sopriam Moulay Slimane": "Sopriam MS siége",
  "MBA Nouaceur": "MBA Nouaceur Citroen",
  "Jaber auto siege": "Jaber auto siege",
  "Nabam Auto": "Nabam Auto siége",
  "Superdak - peugeot dakhla": "Superdak - peugeot dakhla",
  "Superdak dakhla": "Superdak dakhla siége",
  "Sopriam Bouskoura": "Sopriam Bouskoura siége",
  "sandi star Citroen": "sandi star Citroen",
  "Sopriam Rabat Hassan 2": "Sopriam Rabat Hassan 2",
  "Sopriam ROARSHOW": "Sopriam ROARSHOW",
  "MBA BERRECHID": "MBA BERRECHID",
  "Sopriam Marjane Ain Sbaa - KMG AUTO": "Sopriam Marjane Ain Sbaa - KMG AUTO",
} as const;

export type ShowroomLabel = keyof typeof SHOWROOM_API_NAMES;

/** Which brand picklist values each Showroom__c entry serves. Used to
 *  filter the showroom list when a customer asks "where can I see a Jeep
 *  in Marrakech?" — we don't want to show Peugeot-only sites for that
 *  question. Comes verbatim from the "Brands" column of the CSV. */
export const SHOWROOM_BRANDS: Record<ShowroomLabel, MarqueLabel[]> = {
  "FCA - AGADIR - FENIE BROSSETTE": ["Jeep", "Fiat", "Alfa Romeo"],
  "FCA - BENI MELLAL - AUTO HALL": ["Fiat"],
  "FCA - CASABLANCA - AUTOHALL BERNOUSSI": ["Jeep", "Fiat", "Alfa Romeo"],
  "FCA - CASABLANCA - ITALCAR MOTORVILLAGE": ["Jeep", "Fiat", "Alfa Romeo"],
  "FCA - CASABLANCA MAARIF - ITALCAR MOTORVILLAGE": ["Jeep", "Fiat"],
  "FCA - CASABLANCA - AUTOHALL MLY ISMAIL": ["Fiat"],
  "FCA - CASABLANCA MASSIRA - ITALCAR MOTORVILLAGE": ["Alfa Romeo"],
  "FCA - KHOURIBGA - AUTO HALL": ["Fiat"],
  "FCA - LARACHE - GENIAL AUTO": ["Fiat"],
  "FCA - MARRAKECH - AUTOHALL CENTRE VILLE": ["Jeep", "Fiat", "Alfa Romeo"],
  "FCA - MARRAKECH - MANISS AUTO ROUTE CASABLANCA": ["Jeep", "Fiat", "Alfa Romeo"],
  "FCA - OUJDA - AUTO HALL": ["Jeep", "Fiat"],
  "FCA - RABAT - ORBIS AUTOMOTIVE": ["Jeep", "Fiat", "Alfa Romeo"],
  "FCA - SETTAT - AUTO HALL": ["Fiat"],
  "FCA - TANGER - ORBIS AUTOMOTIVE": ["Jeep", "Fiat", "Alfa Romeo"],
  "FCA - TETOUAN - AUTO HALL": ["Fiat"],
  "FCA - FES - AUTO HALL": ["Jeep", "Fiat", "Alfa Romeo"],
  "FCA - KENITRA - AUTO HALL": ["Jeep", "Fiat"],
  "FCA - BERKANE - AUTO HALL": ["Fiat"],
  "FCA - MEKNES - AUTO HALL": ["Fiat"],
  "FCA - NADOR - AUTO HALL": ["Fiat"],
  "FCA - SAFI - AUTO HALL": ["Fiat"],
  "Alfa Romeo Massira": ["Alfa Romeo"],
  "VO - CASABLANCA MAARIF - ITALCAR MOTORVILLAGE": ["VO"],
  "PEUGEOT SOPRIAM CASA LONGCHAMPS": ["Peugeot", "Citroen"],
  "PEUGEOT MAJDA AUTO SAFI": ["Peugeot", "Citroen"],
  "Sopriam MOHAMMADIA": ["Peugeot", "Citroen"],
  "BENI MELLAL - KADI AUTO": ["Peugeot", "Citroen"],
  "CITROEN LARACHE - LIXUS AUTO": ["Peugeot", "Citroen"],
  "CITROEN ERRACHIDIA - LIMASUD AUTO": ["Peugeot", "Citroen"],
  "CITROËN NADOR - ETS NADOR AUTO": ["Peugeot", "Citroen"],
  "Sopriam_Massira": ["Peugeot", "DS Automobile", "Leapmotor"],
  "SOPRIAM AIN SBAA": ["Peugeot", "Citroen"],
  "Sopriam Rabat Ennakhil": ["Peugeot", "Citroen", "DS Automobile"],
  "Sopriam_Kenitra": ["Peugeot", "Citroen"],
  "SOPRIAM Tanger": ["Peugeot", "Citroen", "DS Automobile"],
  "Sopriam EL JADIDA - KMG AUTO": ["Peugeot", "Citroen"],
  "SOPRIAM MARRAKECH": ["Peugeot", "Citroen", "DS Automobile"],
  "SOPRIAM AGADIR": ["Peugeot", "Citroen", "DS Automobile"],
  "Sopriam_Fes_Siége": ["Peugeot", "Citroen"],
  "SOPRIAM MEKNES": ["Peugeot", "Citroen"],
  "Sopriam Oujda": ["Peugeot", "Citroen"],
  "Sopriam Tetouan": ["Peugeot", "Citroen"],
  "Sopriam Moulay Slimane": ["Peugeot", "Citroen", "DS Automobile", "Leapmotor"],
  "MBA Nouaceur": ["Peugeot", "Citroen"],
  "Jaber auto siege": ["Peugeot", "Citroen"],
  "Nabam Auto": ["Peugeot", "Citroen"],
  "Superdak - peugeot dakhla": ["Peugeot", "Citroen"],
  "Superdak dakhla": ["Peugeot", "Citroen"],
  "Sopriam Bouskoura": ["Peugeot", "Citroen", "Leapmotor"],
  "sandi star Citroen": ["Peugeot", "Citroen"],
  "Sopriam Rabat Hassan 2": ["Peugeot", "Citroen", "Leapmotor"],
  "Sopriam ROARSHOW": ["Peugeot", "Citroen"],
  "MBA BERRECHID": ["Peugeot", "Citroen"],
  "Sopriam Marjane Ain Sbaa - KMG AUTO": ["Peugeot", "Citroen"],
};

/** Short, conversational forms of maison names that the chatbot extracts
 *  from transcripts ("Italcar Motorvillage Bouskoura", "Autohall Bernoussi")
 *  mapped to the canonical Showroom__c API Name. The chat prompt and the
 *  customer's natural speech use these short forms; the SF picklist requires
 *  the long "FCA - CITY - OPERATOR" form. This is the bridge. */
const SHOWROOM_SHORT_FORM_ALIASES: Record<string, ShowroomLabel> = {
  // Casablanca
  "italcar motorvillage bouskoura":    "FCA - CASABLANCA - ITALCAR MOTORVILLAGE",
  "italcar motorvillage":              "FCA - CASABLANCA - ITALCAR MOTORVILLAGE",
  "bouskoura":                         "FCA - CASABLANCA - ITALCAR MOTORVILLAGE",
  "italcar motorvillage maârif":       "FCA - CASABLANCA MAARIF - ITALCAR MOTORVILLAGE",
  "italcar motorvillage maarif":       "FCA - CASABLANCA MAARIF - ITALCAR MOTORVILLAGE",
  "maârif":                            "FCA - CASABLANCA MAARIF - ITALCAR MOTORVILLAGE",
  "maarif":                            "FCA - CASABLANCA MAARIF - ITALCAR MOTORVILLAGE",
  "autohall bernoussi":                "FCA - CASABLANCA - AUTOHALL BERNOUSSI",
  "bernoussi":                         "FCA - CASABLANCA - AUTOHALL BERNOUSSI",
  // Marrakech
  "auto hall marrakech":               "FCA - MARRAKECH - AUTOHALL CENTRE VILLE",
  "autohall centre ville":             "FCA - MARRAKECH - AUTOHALL CENTRE VILLE",
  "centre ville":                      "FCA - MARRAKECH - AUTOHALL CENTRE VILLE",
  "maniss auto":                       "FCA - MARRAKECH - MANISS AUTO ROUTE CASABLANCA",
  "maniss auto route casablanca":      "FCA - MARRAKECH - MANISS AUTO ROUTE CASABLANCA",
  // Single-maison cities
  "fenie brossette":                   "FCA - AGADIR - FENIE BROSSETTE",
  "auto hall fes":                     "FCA - FES - AUTO HALL",
  "auto hall kenitra":                 "FCA - KENITRA - AUTO HALL",
  "auto hall oujda":                   "FCA - OUJDA - AUTO HALL",
  "orbis automotive rabat":            "FCA - RABAT - ORBIS AUTOMOTIVE",
  "orbis automotive tanger":           "FCA - TANGER - ORBIS AUTOMOTIVE",
};

/** Lookup helper: take a showroom Label, an API Name, OR a conversational
 *  short form ("Autohall Bernoussi", "Italcar Motorvillage Bouskoura") and
 *  return the canonical Showroom__c API Name. Returns undefined when no
 *  match — caller should omit Showroom__c / Dealer__c rather than send a
 *  bad picklist value. */
export function getShowroomApiName(labelOrApiName: string): string | undefined {
  const trimmed = labelOrApiName.trim();
  // 1. Direct label match.
  if (trimmed in SHOWROOM_API_NAMES) {
    return SHOWROOM_API_NAMES[trimmed as ShowroomLabel];
  }
  // 2. Direct API-name match (covers upstream code that passes the long form).
  for (const apiName of Object.values(SHOWROOM_API_NAMES)) {
    if (apiName === trimmed) return apiName;
  }
  // 3. Short conversational form ("Autohall Bernoussi" → "FCA - … - AUTOHALL BERNOUSSI").
  const aliasKey = trimmed.toLowerCase();
  const aliased = SHOWROOM_SHORT_FORM_ALIASES[aliasKey];
  if (aliased) return SHOWROOM_API_NAMES[aliased];
  // 4. Loose fuzzy match — if the input CONTAINS one of the short-form keys
  //    as a substring, use it. Catches "Autohall Bernoussi Parfait" leftovers
  //    even when the regex over-captures.
  for (const [key, label] of Object.entries(SHOWROOM_SHORT_FORM_ALIASES)) {
    if (aliasKey.includes(key)) return SHOWROOM_API_NAMES[label];
  }
  return undefined;
}

/** Filter showrooms by which brand they serve. Useful for "show me Jeep
 *  maisons in Marrakech" type queries. */
export function getShowroomsForBrand(brand: MarqueLabel): ShowroomLabel[] {
  return (Object.entries(SHOWROOM_BRANDS) as [ShowroomLabel, MarqueLabel[]][])
    .filter(([, brands]) => brands.includes(brand))
    .map(([label]) => label);
}

/* ─────────────────── App-specific resolvers ─────────────────── */

/** Map our internal Jeep model slug → the Serie_Modele__c API Name to
 *  send. Marque_d_interet__c is always "57" (Jeep) for this brand. */
const JEEP_MODEL_SLUG_TO_SF: Record<string, SerieModeleLabel> = {
  avenger: "Avenger",
  compass: "Compass",
  "compass-hybrid": "Compass Hybrid",
  wrangler: "Wrangler",
  "grand-cherokee": "Grand Cherokee",
  // The "Renegade" picklist value (API "57-609") is the legacy entry; the
  // current Moroccan catalogue is Renegade MHEV. Both slugs route there.
  renegade: "Renegade MHEV",
  "renegade-hybrid": "Renegade MHEV",
};

/** Map the canonical showroom string (the one the chatbot already passes
 *  to find_showrooms / book_service_appointment) → the parent Dealer__c
 *  API Name. Note Showroom__c itself takes the SAME canonical string
 *  (Stellantis exposes the long "FCA - CITY - OPERATOR" form as the API
 *  Name for that picklist), so no extra mapping is needed for Showroom__c. */
const SHOWROOM_TO_DEALER: Record<string, DealerApiName> = {
  "FCA - CASABLANCA - AUTOHALL BERNOUSSI": "AutoHall",
  "FCA - CASABLANCA - ITALCAR MOTORVILLAGE": "STELLANTIS AND YOU",
  "FCA - CASABLANCA MAARIF - ITALCAR MOTORVILLAGE": "STELLANTIS AND YOU",
  "FCA - FES - AUTO HALL": "AutoHall",
  "FCA - KENITRA - AUTO HALL": "AutoHall",
  "FCA - MARRAKECH - AUTOHALL CENTRE VILLE": "AutoHall",
  "FCA - MARRAKECH - MANISS AUTO ROUTE CASABLANCA": "MANISS AUTO",
  "FCA - OUJDA - AUTO HALL": "AutoHall",
  "FCA - RABAT - ORBIS AUTOMOTIVE": "ORBIS AUTOMOTIVE",
  "FCA - TANGER - ORBIS AUTOMOTIVE": "ORBIS AUTOMOTIVE",
  "FCA - AGADIR - FENIE BROSSETTE": "FENIE BROSSETTE",
};

/** Resolve the four Lead-payload picklist fields from what the chatbot
 *  already collects. Any value the mapping can't resolve is returned as
 *  `undefined` so the caller can omit the field from the JSON — that's
 *  safer than sending an unknown picklist value (Salesforce 400). */
export function resolveJeepLeadPicklists(args: {
  modelSlug: string;
  /** Either the canonical "FCA - CITY - OPERATOR" API name OR the same
   *  string used as a label — getShowroomApiName accepts both. */
  showroomApiName: string | undefined;
}): {
  Marque_d_interet__c: string | undefined;
  Serie_Modele__c: string | undefined;
  Dealer__c: string | undefined;
  Showroom__c: string | undefined;
} {
  const modelLabel = JEEP_MODEL_SLUG_TO_SF[args.modelSlug.toLowerCase()];
  const showroomApi = args.showroomApiName
    ? getShowroomApiName(args.showroomApiName)
    : undefined;
  // Find the dealer for this showroom (Jeep-only mapping — these strings
  // ARE the API names since Label === API Name for every FCA entry).
  const dealer = showroomApi ? SHOWROOM_TO_DEALER[showroomApi] : undefined;
  return {
    Marque_d_interet__c: MARQUE_API_NAMES.Jeep, // always "57" for this app
    Serie_Modele__c: modelLabel
      ? SERIE_MODELE_API_NAMES[modelLabel]
      : undefined,
    Dealer__c: dealer,
    Showroom__c: showroomApi,
  };
}

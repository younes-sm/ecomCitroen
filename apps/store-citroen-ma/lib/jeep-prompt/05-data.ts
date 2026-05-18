// Authoritative data tables: tarifs, fiches techniques, motorisations,
// réseau des maisons. Data only — no behavioural rules. Behaviours that
// reference these tables live in the relevant flow / discovery module.

export const DATA = `
## Tarifs Jeep Maroc (autoritatif)

Source : grille tarifaire constructeur. Toutes les valeurs en MAD. Ne jamais inventer un prix, une remise ou une finition. Si la version demandée est absente, dire qu'elle n'est pas disponible et proposer la plus proche.

Définitions :
- Prix public      = catalogue TTC hors options (PRIX DE BASE).
- Remise           = remise commerciale active.
- Prix remisé      = Prix public − Remise.
- F.I.             = Frais d'Immatriculation.
- P.M.             = Plaque Minéralogique.
- Clé en main      = Prix remisé + F.I. + P.M. (total à payer pour rouler).

JEEP AVENGER · ALTITUDE MHEV — 1.2 l 100 TURBO Essence/MHEV
  Prix public 294 000 · Options 0 · Remise 35 000 · Prix remisé 259 000 · F.I. 6 055 · P.M. 6 000 · Clé en main 271 055

JEEP AVENGER · ALTITUDE MHEV MY25 — 1.2 l 100 TURBO Essence/MHEV
  Prix public 304 000 · Options 0 · Remise 35 000 · Prix remisé 269 000 · F.I. 6 055 · P.M. 6 000 · Clé en main 281 055

JEEP AVENGER · SUMMIT MHEV + CUIR + TOIT OUVRANT — 1.2 l 100 TURBO Essence/MHEV
  Prix public 339 400 · Options 18 500 · Remise 47 400 · Prix remisé 310 500 · F.I. 6 055 · P.M. 7 500 · Clé en main 324 055

JEEP AVENGER · SUMMIT MHEV + PACKS + TOIT OUVRANT — 1.2 l 100 TURBO Essence/MHEV
  Prix public 339 400 · Options 23 500 · Remise 47 400 · Prix remisé 315 500 · F.I. 6 055 · P.M. 7 500 · Clé en main 329 055

NEW JEEP AVENGER 4xe · OVERLAND MHEV — 1.2 l 136 TURBO Essence/MHEV
  Prix public 391 500 · Options 23 500 · Remise 42 000 · Prix remisé 373 000 · F.I. 6 055 · P.M. 7 500 · Clé en main 383 555

JEEP NEW COMPASS · ALTITUDE MHEV — 1.2 l 145 TURBO Essence/MHEV
  Prix public 344 000 · Options 25 000 · Remise 20 000 · Prix remisé 349 000 · F.I. 8 805 · P.M. 6 600 · Clé en main 364 405

JEEP NEW COMPASS · SUMMIT MHEV — 1.2 l 145 TURBO Essence/MHEV
  Prix public 409 000 · Options 0 · Remise 20 000 · Prix remisé 389 000 · F.I. 8 805 · P.M. 8 800 · Clé en main 406 605

JEEP WRANGLER · SAHARA — 2.0 l PHEV Essence/Hybride rechargeable
  Prix public 844 000 · Options 0 · Remise 0 (aucune remise — ne jamais en inventer) · Prix remisé 844 000 · F.I. 14 000 · P.M. 12 000 · Clé en main 870 000

JEEP WRANGLER · RUBICON — 2.0 l PHEV Essence/Hybride rechargeable
  Prix public 884 000 · Options 0 · Remise 0 (aucune remise) · Prix remisé 884 000 · F.I. 14 000 · P.M. 12 000 · Clé en main 910 000

### Ordre de communication du prix

Default order when the customer asks "combien coûte X ?":
  1. **Prix public** (catalogue connu de tous).
  2. **Clé en main** (total réel à payer, incluant F.I. + P.M.).
  3. **Remise active + Prix remisé** ONLY if remise non zero — phrased as good news: "actuellement on a une remise de X qui ramène le prix à Y avant immatriculation."

Cases:
  • "Tout compris / clé en main / كل شي مدخول" → lead with Clé en main, then composition.
  • "Promo / remise / réduction" → Remise + Prix remisé first.
  • Remise = 0 (Wrangler SAHARA / RUBICON) → never mention a remise.
  • Always cite the finition (ALTITUDE / SUMMIT / OVERLAND / SAHARA / RUBICON) with each price.
  • Always use "MAD" or "dirhams" — never a raw number.
  • Peinture métallisée is NOT included in "Options TTC" — mention it as a supplement if the customer picks a specific colour.

Banned: inventing a price · mixing two finitions · annoncing Prix remisé before Prix public · rounding any figure.

## Motorisations disponibles au Maroc (autoritatif)

Restricted vs international. Don't propose a motorisation absent from this list — recurring source of customer misunderstanding.

  • JEEP AVENGER       → UNIQUEMENT MHEV (1.2 l 100 ch). Pas de version thermique pure, pas d'électrique, pas de PHEV.
  • JEEP AVENGER 4xe   → UNIQUEMENT MHEV (1.2 l 136 ch) — finition OVERLAND. Pas de PHEV malgré l'appellation "4xe".
  • JEEP COMPASS       → UNIQUEMENT MHEV (1.2 l 145 ch). Pas de diesel, pas de PHEV.
  • JEEP WRANGLER      → UNIQUEMENT PHEV (2.0 l). Pas de thermique, pas de diesel.
  • JEEP GRAND CHEROKEE → UNIQUEMENT V6 essence 293 ch. Pas d'hybridation.

If the customer mentions "Avenger électrique" / "Wrangler thermique" / "Compass diesel" → clarify warmly that the version isn't on the Moroccan catalogue.

## Fiches techniques (autoritatif)

Source officielle constructeur. Référence unique pour toute question équipement / puissance / consommation. Si l'info n'y est pas, dire "je vérifie avec la maison Jeep et je reviens vers vous".

### Avenger MHEV (ALTITUDE / SUMMIT)

Caractéristiques (identiques sur les deux finitions) :
  1.2L E-DCT 6 vitesses P2 48V · moteur électrique 21 kW / 55 Nm
  100 ch / 205 Nm · 7 CV fiscaux · boîte auto 6 rapports
  Coffre 380 L · Poids 1567 kg · CO2 114 g/km · Conso WLTP 4,9–5,1 L/100 · Réservoir 44 L
  Note : MHEV n'est PAS exonérée des vignettes.

ALTITUDE de série :
  Sécurité : aide démarrage côte · régulateur + limiteur · reconnaissance panneaux · airbags front/lat/rideaux AV · freinage d'urgence autonome · frein parking électrique · détection somnolence · aide au maintien sur voie active · kit Fix & Go.
  Intérieur : clim auto bi-zone · volant cuir multifonctions · sellerie tissu-vinyle · plancher coffre réglable · écran radio 10,25" · accoudoir central AV · palettes au volant · déverrouillage électrique coffre · TFT 10,25" · caméra recul · radar recul · lève-vitres électriques séquentiels · dossier 60/40 · rétros chauffants électriques · démarrage sans clé.
  Extérieur : jantes 17" · poignées couleur carrosserie · plaques protection argent · LED antibrouillard · phares Full LED · écran tactile 10".

SUMMIT = tout ALTITUDE + détecteur angles morts · régulateur adaptatif · feux route auto · détecteur pluie · éclairage ambiance LED multicolor · chargeur sans fil · keyless · caméra recul 180° vue drône · hayon mains libres · capteurs parking AV/AR · rétros rabattables élec · projecteurs/feux LED · vitres AR surteintées · jantes 17".

Options ALTITUDE : peinture métallisée · LED PACK · jantes 18" · ADAS PACK.
Options SUMMIT : peinture métallisée uni/bi-color · toit panoramique · sellerie cuir haut de gamme · siège conducteur massant élec lombaire.

### Compass MHEV (ALTITUDE / SUMMIT)

Caractéristiques :
  1.2 MHEV essence · 1199 cm³ · Euro 6 · ICE 136 ch · combinée 145 ch · couple 230 Nm à 1750 tr/min · DCT6
  0-100 10 s · vitesse max 195 km/h · conso WLTP 5,5 L/100 · CO2 125-135 g/km · coffre 550 L (2 niveaux).

ALTITUDE de série :
  Sécurité : aide démarrage côte · maintien voie active · détecteur somnolence · reconnaissance panneaux · régulateur adaptatif · limiteur actif · adaptation rétros marche AR · ISA · radar parking AV/AR · frein parking électrique · airbags lat AV + rideaux + frontaux · détecteur pluie · Stop & Go · allumage auto projecteurs · freinage d'urgence piétons/cyclistes · Select Terrain (Sport/Auto/Neige/Sable/Boue) · Fix & Go.
  Confort : volant cuir palettes · accoudoirs AV/AR porte-gobelets · clim auto bi-zone · keyless · déverrouillage élec coffre · miroirs LED · rétro photochromatique · rétros rabattables élec · caméra AR 180° · dossier AR 40/20/40 · lombaire élec conducteur.
  Tech : TFT 10" configurable · keyless + démarrage sans clé · écran central 16" Android Auto + Apple CarPlay · audio Bluetooth · 2 USB-C.
  Design : jantes 18" · tableau de bord/portes cuir surpiqûres · sièges tissu bi-color haut de gamme · logos extérieurs noir mat.

SUMMIT = tout ALTITUDE + angles morts · alerte trafic AR · capteurs parking AV/AR · prévention erreur pédale · antibrouillard · projecteurs LED Matrix · caméra 360° · lombaire élec sièges AV · mémoire sièges · sièges massants enveloppants · chauffants/ventilés · ambiance LED tableau de bord + plafond · hayon mains libres · chargeur sans fil · GPS · vitres surteintées · calandre 7 fentes lumineuses · signature lumineuse AR · cuir bi-color · barres toit chromées · noir piano · toit panoramique double (ouvrant AV).

Convenience Pack (option ALTITUDE) : caméra 360° · antibrouillard · angles morts · alerte trafic AR · prévention pédale · chargeur sans fil · hayon mains libres.

### Wrangler 4xe PHEV (SAHARA / RUBICON)

Caractéristiques (identiques) :
  2.0 4xe PHEV essence · 1995 cm³ · Euro 6 · ICE 272 ch / combinée 380 ch · 8-speed ATX 4WD
  0-100 6,5 s · vitesse max 174 km/h · conso WLTP SAHARA 3,5 / RUBICON 4,3 L/100 · CO2 SAHARA 79 / RUBICON 96 g/km
  Moteur électrique tension nominale 107 kW · Autonomie level 2 · Coffre 548 L.

SAHARA de série :
  Sécurité : régulateur adaptatif avec arrêt · collision avant pleine vitesse · détection conducteur somnolent · Full LED · informations panneaux · angles morts + trafic croisé AR · sortie de voie · alarme sécurité.
  Confort : keyless + entrée passive · sièges AV chauffants + volant chauffant · power box + câble de recharge · caméra recul · sièges AV élec 8 directions · clim auto bi-zone · lombaire élec 4 directions.
  Tech : audio Alpine 9 HP · GPS écran tactile 12,3" · TFT 7".
  Design : jantes 18" · vitres surteintées · Gorilla Glass · toit rigide couleur carrosserie.

RUBICON = tout SAHARA + caméras AV/AR · jantes 17" · toit rigide noir amovible 3 compartiments · marchepieds · tapis acoustique zone AV · élargisseurs ailes noirs · cuir Nappa.

Options RUBICON : pneus LT255/75R17C tout-terrain · tapis sol toutes conditions.

### Grand Cherokee (LIMITED / OVERLAND)

Caractéristiques (identiques) :
  GSE 3L V6 essence · 3604 cm³ · 293 ch nominal · couple 352 Nm · boîte auto 8 rapports · transmission intégrale · 4 portes · 5 places.

LIMITED de série :
  Sécurité : aide démarrage côte · maintien voie active · airbags genoux AV + lat AV + rideaux AV/AR · alarme · alerte pression pneus sélectionnable · collision avant Plus · ESC · angles morts · antibrouillard AV/AR LED · frein parking élec · freinage piétons/cyclistes · régulateur adaptatif Stop-Go · roue secours · démarrage sans clé à distance.
  Confort : allumage auto projecteurs · caméra tout-terrain · clim auto bi-zone · détecteur pluie · dossier AR 60/40 · entrée passive AV/AR + hayon · hayon élec · lave-caméra · pack fumeurs · radars ParkSense AV/AR · rétro G commutation jour/nuit · rétros élec mémoire · siège + colonne direction mémoire · sièges AV élec 8 positions chauffants/ventilés · caméra surround view · volant chauffant.
  Tech : TFT 10,25" couleur · écran central 10,1" · GPS · Apple CarPlay/Android Auto · chargeur sans fil · 115V/12V · 9 HP amplifiés + subwoofer · USB AR.
  Design : cuir Capri · éclairage ambiant LED · porte-gobelets lumineux · toit panoramique double · jantes alu 20".

OVERLAND = tout LIMITED + freinage avancé · reconnaissance panneaux · vision nocturne (animaux/piétons) · clim auto 4 zones · stop/start · hayon mains libres · massage dossiers AV · pare-soleil miroirs illuminés · sièges 12 positions · mémoire colonne direction · stores AR manuels · affichage tête haute · démarrage à distance · 12V coffre · cuir Nappa · éclairage LED multicolore · volant cuir · barres toit chromées · doubles sorties échappement · marchepieds chromés.

### Règles fiche technique

- Toujours préciser la finition concernée (ex : "angles morts de série sur SUMMIT, en option ADAS PACK sur ALTITUDE").
- Avenger / Compass : entrée ALTITUDE, haute SUMMIT.
- Wrangler : entrée SAHARA, haute RUBICON. Les deux PHEV.
- Grand Cherokee : entrée LIMITED, haute OVERLAND. V6 essence 293 ch, pas d'hybridation.
- Équipement non listé → "cet équipement n'est pas annoncé sur cette finition, je vérifie avec la maison Jeep".

## Réseau des maisons Jeep Maroc (autoritatif)

11 maisons, 8 villes. Source unique de vérité. Si la ville citée n'est pas couverte, proposer la maison la plus proche géographiquement.

Format : <Ville> — <Opérateur> · \`API name\` = valeur à passer aux outils comme \`preferred_site\` / \`site\` / \`showroomName\`.

AGADIR
  • Fenie Brossette · Tassila Rp. 40 Dchira El Jihadia · +212 528 32 25 82
    API: "FCA - AGADIR - FENIE BROSSETTE"

CASABLANCA (3 maisons — disambiguer avant de fixer)
  • Autohall Bernoussi · Km 12 Autoroute Casa-Rabat, Sortie Al Qods · 05 22 76 13 96 · centrale Auto Hall 0800 09 28 28
    API: "FCA - CASABLANCA - AUTOHALL BERNOUSSI"
  • Italcar Motorvillage (Stellantis &You Casablanca, Bouskoura) · Ouled Benameur, RP 3011 Km 6 Bouskoura sortie Ville Verte · +212 522 01 70 00 · WhatsApp +212 667 77 66 54
    API: "FCA - CASABLANCA - ITALCAR MOTORVILLAGE"
  • Italcar Motorvillage Maârif · Angle Bd Brahim Roudani, Bd Zerktouni et Rue Zurich · 05 22 25 48 99
    API: "FCA - CASABLANCA MAARIF - ITALCAR MOTORVILLAGE"

FÈS
  • Auto Hall · Rue de Libye · 05 35 62 59 51
    API: "FCA - FES - AUTO HALL"

KENITRA
  • Auto Hall · 383 Bd Mohammed V · 05 37 37 99 66 / 05 37 37 31 26
    API: "FCA - KENITRA - AUTO HALL"

MARRAKECH (2 maisons — disambiguer)
  • Auto Hall Marrakech (étiqueté "Centre Ville" en interne, en réalité Route de Casablanca) · Km 13 Route de Casablanca, 13000 · 05 24 35 47 96 / 05 24 35 42 12
    API: "FCA - MARRAKECH - AUTOHALL CENTRE VILLE"
  • Maniss Auto Route de Casablanca · Lieu-dit Jnane Sidi Abbad, 40000 · +212 524 30 91 01
    API: "FCA - MARRAKECH - MANISS AUTO ROUTE CASABLANCA"

OUJDA
  • Auto Hall · Km 6 Route d'Ahfir, Technopole · 05 36 52 40 20 / 21 · mobile 05 36 52 40 23 · autohall.oujda2@autohall.ma
    API: "FCA - OUJDA - AUTO HALL"

RABAT
  • Orbis Automotive · 32 Avenue Hassan II, Lotissement Vita · +212 537 28 35 50 · commercial@orbisautomotive.ma
    API: "FCA - RABAT - ORBIS AUTOMOTIVE"

TANGER
  • Orbis Automotive · Avenue des FAR, Route de Rabat · +212 539 42 47 66 · commercial@orbisautomotive.ma
    API: "FCA - TANGER - ORBIS AUTOMOTIVE"

### Villes non couvertes — proposer la plus proche

Beni Mellal · Khouribga · Larache · Settat · Tétouan · Berkane · Meknès · Nador · Safi · El Jadida · Errachidia · Dakhla · Bouskoura · Berrechid · Mohammedia.

Suggérer : Tétouan → Tanger · Meknès → Fès · Beni Mellal / El Jadida → Casablanca · Safi → Marrakech · Nador / Berkane → Oujda.

### Communication réseau

- Always say "la maison" (Latin script, even in AR/Darija) — never concession / showroom / agence / wakala / المعرض. (See persona module for the full brand-vocabulary rule.)
- Customer asks "where is the closest maison ?" → first ask their city, then give the operator name.
- When the customer picks a maison, pass the API name VERBATIM to the tool (preferredSite / site / showroomName). Never invent a variant.
- Casablanca → ask Bernoussi / Bouskoura / Maârif.
- Marrakech → ask Centre Ville (Route de Casablanca) / Maniss Auto.
- Uncovered city → never call find_showrooms (empty list); propose the nearest covered one.
`;

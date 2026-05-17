/**
 * Seed showrooms for the 3 demo brands. Realistic city distribution and dealer
 * names; phone/email are placeholder. Idempotent — clears + reinserts per brand.
 *
 * Usage: pnpm tsx scripts/seed-showrooms.ts
 */

import path from "node:path";
import { config as loadEnv } from "dotenv";
loadEnv({ path: path.resolve(__dirname, "..", ".env.local") });

import { createClient } from "@supabase/supabase-js";

type Showroom = {
  name: string;
  city: string;
  address: string;
  phone: string;
  whatsapp?: string;
  email?: string;
  hours: string;
  service_centre?: boolean;
  primary_dealer?: boolean;
};

const DATA: Record<string, Showroom[]> = {
  "citroen-ma": [
    // Casablanca — flagship + ring-road locations
    { name: "Citroën Casablanca Centre", city: "Casablanca", address: "Bd. Zerktouni, Casablanca 20100", phone: "+212 522 22 11 33", whatsapp: "+212 661 11 22 33", email: "casa.centre@citroen.ma", hours: "Mon–Sat · 9am–7pm", primary_dealer: true, service_centre: true },
    { name: "Citroën Casablanca Ain Sebaâ", city: "Casablanca", address: "Route de Rabat, Ain Sebaâ, Casablanca", phone: "+212 522 35 14 90", whatsapp: "+212 661 22 33 44", email: "ainsebaa@citroen.ma", hours: "Mon–Sat · 9am–6:30pm", service_centre: true },
    { name: "Citroën Casablanca Sidi Maârouf", city: "Casablanca", address: "Av. Sidi Maârouf, Casablanca", phone: "+212 522 78 33 55", whatsapp: "+212 661 33 44 60", hours: "Mon–Sat · 9am–7pm" },
    // Rabat – Salé
    { name: "Citroën Rabat Hassan", city: "Rabat", address: "Av. Mohammed V, Rabat 10000", phone: "+212 537 70 41 22", whatsapp: "+212 661 33 44 55", email: "rabat@citroen.ma", hours: "Mon–Sat · 9am–7pm", primary_dealer: true },
    { name: "Citroën Rabat Hay Riad", city: "Rabat", address: "Av. Annakhil, Hay Riad, Rabat", phone: "+212 537 71 22 60", whatsapp: "+212 661 35 50 70", hours: "Mon–Sat · 9am–6:30pm", service_centre: true },
    { name: "Citroën Salé", city: "Salé", address: "Route de Kenitra, Salé", phone: "+212 537 88 14 99", hours: "Mon–Sat · 9am–6:30pm" },
    // Marrakech
    { name: "Citroën Marrakech Sidi Ghanem", city: "Marrakech", address: "Zone Industrielle Sidi Ghanem", phone: "+212 524 33 64 78", whatsapp: "+212 661 44 55 66", email: "marrakech@citroen.ma", hours: "Mon–Sat · 9am–6:30pm", primary_dealer: true, service_centre: true },
    { name: "Citroën Marrakech Guéliz", city: "Marrakech", address: "Av. Mohammed VI, Guéliz, Marrakech", phone: "+212 524 43 12 88", whatsapp: "+212 661 45 60 70", hours: "Mon–Sat · 9am–7pm" },
    // North
    { name: "Citroën Tanger", city: "Tanger", address: "Bd. Mohammed VI, Tanger", phone: "+212 539 32 50 11", whatsapp: "+212 661 55 66 77", email: "tanger@citroen.ma", hours: "Mon–Sat · 9am–7pm", service_centre: true },
    { name: "Citroën Tétouan", city: "Tétouan", address: "Av. Mohammed V, Tétouan", phone: "+212 539 71 40 22", hours: "Mon–Sat · 9am–6:30pm" },
    // Atlantic / South
    { name: "Citroën Agadir", city: "Agadir", address: "Av. Hassan II, Agadir", phone: "+212 528 84 22 99", whatsapp: "+212 661 66 77 88", email: "agadir@citroen.ma", hours: "Mon–Sat · 9am–6:30pm", service_centre: true },
    { name: "Citroën Laâyoune", city: "Laâyoune", address: "Av. Mekka, Laâyoune", phone: "+212 528 99 14 22", hours: "Mon–Sat · 9am–6pm" },
    // Centre / East
    { name: "Citroën Fès", city: "Fès", address: "Route de Sefrou, Fès", phone: "+212 535 65 80 22", whatsapp: "+212 661 77 88 99", email: "fes@citroen.ma", hours: "Mon–Sat · 9am–7pm", service_centre: true },
    { name: "Citroën Meknès", city: "Meknès", address: "Av. des FAR, Meknès", phone: "+212 535 51 88 14", hours: "Mon–Sat · 9am–6:30pm" },
    { name: "Citroën Oujda", city: "Oujda", address: "Bd. Mohammed V, Oujda", phone: "+212 536 70 12 44", whatsapp: "+212 661 88 99 22", hours: "Mon–Sat · 9am–6:30pm" },
    { name: "Citroën Kenitra", city: "Kenitra", address: "Route de Tanger, Kenitra", phone: "+212 537 36 14 55", hours: "Mon–Sat · 9am–6:30pm" },
    { name: "Citroën El Jadida", city: "El Jadida", address: "Av. Hassan II, El Jadida", phone: "+212 523 35 12 90", hours: "Mon–Sat · 9am–6:30pm" },
    { name: "Citroën Mohammedia", city: "Mohammedia", address: "Bd. Hassan II, Mohammedia", phone: "+212 523 30 22 70", hours: "Mon–Sat · 9am–6:30pm" },
    { name: "Citroën Béni Mellal", city: "Béni Mellal", address: "Av. Mohammed V, Béni Mellal", phone: "+212 523 48 33 70", hours: "Mon–Sat · 9am–6:30pm" },
    { name: "Citroën Nador", city: "Nador", address: "Bd. Hassan II, Nador", phone: "+212 536 60 22 14", hours: "Mon–Sat · 9am–6:30pm" },
  ],

  // Jeep Maroc — 11 maisons sur 8 villes. Source autoritative : RÉSEAU DES MAISONS
  // block in apps/store-citroen-ma/app/api/rihla/system-prompt/route.ts (les deux
  // doivent rester synchronisés sinon la voix et le chat divergent).
  // Cities NOT covered by Jeep: Beni Mellal, Khouribga, Larache, Settat, Tétouan,
  // Berkane, Meknès, Nador, Safi, El Jadida, Errachidia, Dakhla, Bouskoura,
  // Berrechid, Mohammedia. Do NOT seed those.
  "jeep-ma": [
    // Agadir
    { name: "Jeep Agadir — Fenie Brossette", city: "Agadir", address: "Tassila Rp. 40 Dchira El Jihadia, Agadir", phone: "+212 528 32 25 82", hours: "Mon–Sat · 9am–6:30pm", primary_dealer: true, service_centre: true },
    // Casablanca (3 maisons)
    { name: "Jeep Casablanca Bernoussi — Autohall", city: "Casablanca", address: "Km 12, Autoroute Casa-Rabat, Sortie Al Qods, Casablanca", phone: "+212 522 76 13 96", hours: "Mon–Sat · 9am–7pm", service_centre: true },
    { name: "Jeep Casablanca Bouskoura — Italcar Motorvillage", city: "Casablanca", address: "Ouled Benameur, RP 3011, Km 6, Bouskoura, sortie Ville Verte, Casablanca", phone: "+212 522 01 70 00", whatsapp: "+212 667 77 66 54", hours: "Mon–Sat · 9am–7pm", primary_dealer: true, service_centre: true },
    { name: "Jeep Casablanca Maârif — Italcar Motorvillage", city: "Casablanca", address: "Angle Bd Brahim Roudani, Bd Zerktouni et Rue Zurich, Maârif, Casablanca", phone: "+212 522 25 48 99", hours: "Mon–Sat · 9am–7pm", service_centre: true },
    // Fès
    { name: "Jeep Fès — Auto Hall", city: "Fès", address: "Rue de Libye, Fès", phone: "+212 535 62 59 51", hours: "Mon–Sat · 9am–6:30pm", primary_dealer: true, service_centre: true },
    // Kénitra
    { name: "Jeep Kénitra — Auto Hall", city: "Kenitra", address: "383 Boulevard Mohammed V, Kénitra", phone: "+212 537 37 99 66", hours: "Mon–Sat · 9am–6:30pm", service_centre: true },
    // Marrakech (2 maisons)
    { name: "Jeep Marrakech Centre Ville — Auto Hall", city: "Marrakech", address: "Km 13, Route de Casablanca, Marrakech 13000", phone: "+212 524 35 47 96", hours: "Mon–Sat · 9am–6:30pm", primary_dealer: true, service_centre: true },
    { name: "Jeep Marrakech Route de Casablanca — Maniss Auto", city: "Marrakech", address: "Route de Casablanca, Lieu-dit Jnane Sidi Abbad, Marrakech 40000", phone: "+212 524 30 91 01", hours: "Mon–Sat · 9am–6:30pm", service_centre: true },
    // Oujda
    { name: "Jeep Oujda — Auto Hall", city: "Oujda", address: "Km 6, Route d'Ahfir, Technopole, Oujda", phone: "+212 536 52 40 20", email: "autohall.oujda2@autohall.ma", hours: "Mon–Sat · 9am–6:30pm", service_centre: true },
    // Rabat
    { name: "Jeep Rabat — Orbis Automotive", city: "Rabat", address: "32 Avenue Hassan II, Lotissement Vita, Rabat", phone: "+212 537 28 35 50", email: "commercial@orbisautomotive.ma", hours: "Mon–Sat · 9am–7pm", primary_dealer: true, service_centre: true },
    // Tanger
    { name: "Jeep Tanger — Orbis Automotive", city: "Tanger", address: "Avenue des FAR, Route de Rabat, Tanger", phone: "+212 539 42 47 66", email: "commercial@orbisautomotive.ma", hours: "Mon–Sat · 9am–6:30pm", service_centre: true },
  ],

  "peugeot-ksa": [
    // Riyadh — capital, biggest market
    { name: "Peugeot Riyadh — King Fahd Rd", city: "Riyadh", address: "King Fahd Rd, Olaya, Riyadh 12241", phone: "+966 11 920 22 11", whatsapp: "+966 50 111 22 33", email: "riyadh.kingfahd@peugeot-ksa.com", hours: "Sat–Thu · 9am–10pm", primary_dealer: true, service_centre: true },
    { name: "Peugeot Riyadh — Exit 9", city: "Riyadh", address: "Eastern Ring Rd, Exit 9, Riyadh", phone: "+966 11 920 22 33", whatsapp: "+966 50 222 33 44", email: "riyadh.exit9@peugeot-ksa.com", hours: "Sat–Thu · 9am–9pm", service_centre: true },
    { name: "Peugeot Riyadh — Olaya", city: "Riyadh", address: "Olaya St, Riyadh 12331", phone: "+966 11 920 33 11", whatsapp: "+966 50 333 11 22", hours: "Sat–Thu · 10am–10pm" },
    { name: "Peugeot Riyadh — Northern Ring", city: "Riyadh", address: "Northern Ring Rd, Riyadh", phone: "+966 11 920 33 22", whatsapp: "+966 50 333 22 33", hours: "Sat–Thu · 10am–10pm", service_centre: true },
    // Jeddah — second biggest
    { name: "Peugeot Jeddah — Madinah Rd", city: "Jeddah", address: "Madinah Rd, Al Andalus, Jeddah", phone: "+966 12 660 11 88", whatsapp: "+966 50 333 44 55", email: "jeddah.madinah@peugeot-ksa.com", hours: "Sat–Thu · 9am–10pm", primary_dealer: true, service_centre: true },
    { name: "Peugeot Jeddah — Tahlia", city: "Jeddah", address: "Prince Sultan Rd, Tahlia, Jeddah", phone: "+966 12 660 11 99", whatsapp: "+966 50 444 55 66", hours: "Sat–Thu · 10am–10pm" },
    { name: "Peugeot Jeddah — Corniche", city: "Jeddah", address: "Corniche Rd, Jeddah", phone: "+966 12 660 22 33", hours: "Sat–Thu · 10am–10pm" },
    // Eastern Province — Dammam, Khobar, Hofuf
    { name: "Peugeot Dammam — King Saud", city: "Dammam", address: "King Saud Rd, Dammam 31411", phone: "+966 13 833 70 11", whatsapp: "+966 50 555 66 77", email: "dammam@peugeot-ksa.com", hours: "Sat–Thu · 9am–10pm", primary_dealer: true, service_centre: true },
    { name: "Peugeot Khobar", city: "Khobar", address: "Prince Faisal bin Fahd Rd, Khobar 34429", phone: "+966 13 894 22 50", whatsapp: "+966 50 666 77 88", hours: "Sat–Thu · 9am–10pm", service_centre: true },
    { name: "Peugeot Hofuf", city: "Hofuf", address: "King Abdulaziz Rd, Al-Hofuf, Al-Ahsa", phone: "+966 13 580 14 22", hours: "Sat–Thu · 10am–10pm" },
    // Holy cities
    { name: "Peugeot Mecca", city: "Mecca", address: "Ibrahim Al-Khalil Rd, Mecca", phone: "+966 12 530 14 22", whatsapp: "+966 50 777 88 99", hours: "Sat–Thu · 10am–10pm" },
    { name: "Peugeot Medina", city: "Medina", address: "King Abdulaziz Rd, Medina", phone: "+966 14 866 32 55", whatsapp: "+966 50 888 99 11", hours: "Sat–Thu · 10am–10pm" },
    // Northern / Western secondary cities
    { name: "Peugeot Tabuk", city: "Tabuk", address: "Prince Fahd bin Sultan Rd, Tabuk", phone: "+966 14 421 88 22", hours: "Sat–Thu · 9am–9pm" },
    { name: "Peugeot Yanbu", city: "Yanbu", address: "King Abdulaziz Rd, Yanbu", phone: "+966 14 322 70 14", hours: "Sat–Thu · 9am–9pm" },
    { name: "Peugeot Buraidah", city: "Buraidah", address: "King Khalid Rd, Buraidah, Al-Qassim", phone: "+966 16 326 14 55", hours: "Sat–Thu · 9am–9pm" },
    // Southern
    { name: "Peugeot Abha", city: "Abha", address: "King Faisal Rd, Abha 62521", phone: "+966 17 224 88 70", hours: "Sat–Thu · 9am–9pm" },
    { name: "Peugeot Najran", city: "Najran", address: "King Abdulaziz Rd, Najran", phone: "+966 17 522 14 33", hours: "Sat–Thu · 9am–9pm" },
    { name: "Peugeot Hail", city: "Hail", address: "King Khalid Rd, Hail", phone: "+966 16 533 70 22", hours: "Sat–Thu · 9am–9pm" },
  ],
};

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase env missing");
  const supa = createClient(url, key, { auth: { persistSession: false } });

  // Quick check that the showrooms table exists.
  const { error: probe } = await supa.from("showrooms").select("id", { head: true, count: "exact" });
  if (probe?.message?.includes("does not exist") || probe?.message?.includes("relation")) {
    console.error(
      "Showrooms table not found. Apply supabase/migrations/00002_showrooms.sql first.\n" +
        "→ https://supabase.com/dashboard/project/_/sql/new"
    );
    process.exit(1);
  }

  for (const [slug, rooms] of Object.entries(DATA)) {
    const { data: brand } = await supa.from("brands").select("id").eq("slug", slug).single();
    const brandId = (brand as { id?: string } | null)?.id;
    if (!brandId) {
      console.warn(`skip ${slug}: brand row not found`);
      continue;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supa.from("showrooms") as any).delete().eq("brand_id", brandId);
    const rows = rooms.map((r) => ({
      brand_id: brandId,
      name: r.name,
      city: r.city,
      address: r.address,
      phone: r.phone,
      whatsapp: r.whatsapp ?? null,
      email: r.email ?? null,
      hours: r.hours,
      service_centre: r.service_centre ?? false,
      primary_dealer: r.primary_dealer ?? false,
      enabled: true,
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supa.from("showrooms") as any).insert(rows);
    if (error) {
      console.error(`✗ ${slug}: ${error.message}`);
      continue;
    }
    console.log(`✓ ${slug}: seeded ${rows.length} showrooms`);
  }
  console.log("\nDone.");
}

main().catch((e) => { console.error(e); process.exit(1); });

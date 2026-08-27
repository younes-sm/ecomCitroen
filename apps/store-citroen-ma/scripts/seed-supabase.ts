/**
 * Seed Supabase from scraped brand-data JSONs.
 *
 * Idempotent — safe to re-run. Upserts brands by slug, replaces models per
 * brand, and creates an initial prompt version (v1) if no prompt exists yet.
 *
 * Prereqs:
 *   - SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_URL set in .env.local
 *   - Migration 00001_init.sql applied to the project
 *   - Scraper has produced scripts/brand-data/{slug}.json files
 *
 * Usage: pnpm tsx scripts/seed-supabase.ts
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";
loadEnv({ path: path.resolve(__dirname, "..", ".env.local") });

import { createClient } from "@supabase/supabase-js";

type Model = {
  slug: string;
  name: string;
  tagline?: string;
  description?: string;
  bodyType?: string;
  priceFrom?: number | null;
  currency?: string | null;
  fuel?: string | null;
  transmission?: string | null;
  seats?: number | null;
  heroImage: string;
  galleryImages?: string[];
  keyFeatures?: string[];
  specs?: Record<string, string>;
  pageUrl: string;
};
type BrandPayload = {
  slug: string;
  name: string;
  homepage: string;
  market: string;
  defaultCurrency: string;
  scrapedAt: string;
  models: Model[];
};

// Per-brand metadata that isn't in the scraped JSON (logo, color, locales).
const BRAND_META: Record<string, {
  primaryColor: string;
  logoUrl: string;
  voiceName: string;
  agentName: string;
  locales: string[];
}> = {
  "jeep-ma": {
    primaryColor: "#000000",
    logoUrl: "/brands/jeep-ma/logo.svg",
    voiceName: "Aoede",
    agentName: "NARA",
    locales: ["fr-MA", "ar-MA", "darija-MA", "en-MA"],
  },
  "citroen-ma": {
    primaryColor: "#C8102E",
    logoUrl: "/brands/citroen-ma/logo.svg",
    voiceName: "Aoede",
    agentName: "Rihla",
    locales: ["fr-MA", "ar-MA", "darija-MA", "en-MA"],
  },
  "peugeot-ksa": {
    primaryColor: "#1B1B1B",
    logoUrl: "/brands/peugeot-ksa/logo.svg",
    voiceName: "Aoede",
    agentName: "Rihla",
    locales: ["en-SA", "ar-SA"],
  },
};

function normalizeCurrency(input: string | null | undefined, fallback: string): string {
  const v = (input ?? "").toUpperCase();
  if (v === "DH" || v === "DHS" || v === "DHM") return "MAD";
  if (v === "MAD" || v === "SAR" || v === "AED") return v;
  return fallback;
}

const DEFAULT_PROMPT_BODY = `═══ MISSION ═══
Your ONLY goal: qualify the customer and book a test drive in 3–8 turns. Warm but direct. No small talk. ALWAYS reply in the user's language as defined by the LANGUAGE block above. The instructions below are in English ONLY for the model — never echo them.

═══ TURN-BY-TURN FLOW (MANDATORY ORDER) ═══
TURN 1 — Greet briefly + ask USE CASE (one question only). E.g. "city / family / specific need?"
TURN 2 — Ask BUDGET (monthly payment is friendlier than total price).
TURN 3 — Make ONE targeted recommendation matching their needs. ALWAYS call show_model_image(slug) so they SEE the car. Then offer a test drive.
TURN 4 — Ask FIRST NAME only.
TURN 5 — Ask MOBILE / WHATSAPP NUMBER only. After they give it, repeat it back digit-by-digit ("zero-six-six-one… is that right?") and wait for confirmation.
TURN 6 — Ask CITY only.
TURN 7 — Ask PREFERRED SLOT only (weekend/weekday, morning/afternoon).
TURN 8 — Summarize {firstName, phone, city, model, slot}, call book_test_drive(...), then say a warm goodbye and call end_call().

═══ STYLE ═══
- 1–2 sentences per turn. Never more.
- ONE question per turn. Never two.
- The moment they give a first name, use it in every following turn.
- When recommending a model, ALWAYS pair it with show_model_image() so the customer sees it.
- If the user asks to "see more / go to the website / open the official page" — call open_brand_page(slug). Opens in a new tab.
- Never invent prices, specs, availability, financing rates, or discounts. Use ONLY what's in the catalog above. If asked about something missing, offer to connect them with the dealer.
- Never say tool / parameter names out loud (no "slug", "open_model"). Speak naturally.

═══ END-OF-CONVERSATION RULE — ABSOLUTE ═══
You MUST call end_call() in any of these cases:
  1. Right after a successful book_test_drive() + a warm closing line.
  2. The user says goodbye / thanks / "I'm done" — in ANY language. See trigger list below.
  3. The user has refused twice and there's nothing left to offer.
  4. After ~12 silent or off-topic turns with no progress.

GOODBYE TRIGGERS (call end_call() if the user message contains any of these — case-insensitive, partial match):
  • English: "bye", "goodbye", "thanks", "thank you", "ok thanks", "talk later", "i'm done", "that's all", "no thanks", "see you", "have a good day"
  • French: "au revoir", "merci", "à bientôt", "à plus", "salut", "bonne journée", "non merci", "c'est bon", "ça ira"
  • Arabic / Darija: "شكرا", "شكراً", "بسلامة", "بسلامه", "في أمان الله", "مع السلامة", "يالله", "يالاه", "صافي", "خلاص", "تمام", "ربي يخليك", "بزاف عليا", "ما عنديش الوقت"

When you decide to end, output ONE short farewell line in the user's language, then IMMEDIATELY call end_call(). DO NOT generate further turns. DO NOT ask another question after a farewell.`;

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local");
  }
  const supa = createClient(url, serviceKey, { auth: { persistSession: false } });

  // This deployment is Jeep-only. Seed just jeep-ma so the admin dashboard and
  // brand list don't show Citroën / Peugeot. Override with SEED_BRANDS (comma-
  // separated slugs) if you ever need to seed more.
  const SEED_BRANDS = (process.env.SEED_BRANDS ?? "jeep-ma").split(",").map((s) => s.trim()).filter(Boolean);

  const dataDir = path.resolve(__dirname, "brand-data");
  const files = (await fs.readdir(dataDir)).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    const slug = file.replace(/\.json$/, "");
    if (!SEED_BRANDS.includes(slug)) {
      console.log(`skip ${slug} — not in SEED_BRANDS (${SEED_BRANDS.join(", ")})`);
      continue;
    }
    const meta = BRAND_META[slug];
    if (!meta) {
      console.log(`skip ${slug} — no metadata mapping`);
      continue;
    }
    const payload = JSON.parse(await fs.readFile(path.join(dataDir, file), "utf8")) as BrandPayload;
    console.log(`\n=== ${payload.name} (${slug}) ===`);

    // Upsert brand.
    const { data: brand, error: bErr } = await supa
      .from("brands")
      .upsert(
        {
          slug,
          name: payload.name,
          homepage_url: payload.homepage,
          market: payload.market,
          default_currency: payload.defaultCurrency,
          locales: meta.locales,
          primary_color: meta.primaryColor,
          logo_url: meta.logoUrl,
          voice_name: meta.voiceName,
          agent_name: meta.agentName,
          enabled: true,
        },
        { onConflict: "slug" }
      )
      .select()
      .single();
    if (bErr || !brand) throw new Error(`upsert brand failed: ${bErr?.message}`);
    console.log(`  ✓ brand id=${brand.id}`);

    // Replace models for this brand.
    const { error: dErr } = await supa.from("models").delete().eq("brand_id", brand.id);
    if (dErr) throw new Error(`delete models failed: ${dErr.message}`);

    const rows = payload.models.map((m, i) => ({
      brand_id: brand.id,
      slug: m.slug,
      name: m.name,
      tagline: m.tagline ?? null,
      description: m.description ?? null,
      body_type: m.bodyType ?? null,
      price_from: m.priceFrom && m.priceFrom > 0 ? m.priceFrom : null,
      currency: normalizeCurrency(m.currency, payload.defaultCurrency),
      fuel: m.fuel ?? null,
      transmission: m.transmission ?? null,
      seats: m.seats ?? null,
      hero_image_url: m.heroImage,
      gallery_images: m.galleryImages ?? [],
      key_features: m.keyFeatures ?? [],
      specs: m.specs ?? {},
      page_url: m.pageUrl,
      display_order: i + 1,
      enabled: true,
    }));
    if (rows.length > 0) {
      const { error: iErr } = await supa.from("models").insert(rows);
      if (iErr) throw new Error(`insert models failed: ${iErr.message}`);
    }
    console.log(`  ✓ inserted ${rows.length} models`);

    // Initial prompt v1, only if none exists for this brand.
    const { data: existingPrompt } = await supa
      .from("prompts")
      .select("id")
      .eq("brand_id", brand.id)
      .limit(1)
      .maybeSingle();
    if (!existingPrompt) {
      const { error: pErr } = await supa.from("prompts").insert({
        brand_id: brand.id,
        version: 1,
        body: DEFAULT_PROMPT_BODY,
        is_active: true,
        notes: "Initial seed.",
        edited_by: "system",
      });
      if (pErr) throw new Error(`insert prompt failed: ${pErr.message}`);
      console.log(`  ✓ created prompt v1`);
    } else {
      console.log(`  • prompt already exists (skipped)`);
    }
  }

  console.log("\nDone.");
}

main().catch((e) => { console.error(e); process.exit(1); });

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
import { SHOWROOMS_DATA } from "../lib/showrooms-data";

const DATA = SHOWROOMS_DATA;

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

  // Jeep-only deployment — seed showrooms for jeep-ma only (override with
  // SEED_BRANDS, comma-separated slugs).
  const SEED_BRANDS = (process.env.SEED_BRANDS ?? "jeep-ma").split(",").map((s) => s.trim()).filter(Boolean);

  for (const [slug, rooms] of Object.entries(DATA)) {
    if (!SEED_BRANDS.includes(slug)) {
      console.log(`skip ${slug} — not in SEED_BRANDS (${SEED_BRANDS.join(", ")})`);
      continue;
    }
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

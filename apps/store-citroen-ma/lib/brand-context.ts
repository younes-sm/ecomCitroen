// Loads a brand's full runtime context (brand row + active prompt + models)
// for the widget and the chat/voice agent.
//
// Server-only — uses the service-role client to bypass RLS for performance.
// Falls back to local scraped JSONs (scripts/brand-data/*.json) if Supabase is
// unreachable, so a network outage during a demo doesn't 404 the page.

import { promises as fs } from "node:fs";
import path from "node:path";
import { unstable_cache } from "next/cache";
import { adminClient } from "@/lib/supabase/admin";
import { SHOWROOMS_DATA } from "@/lib/showrooms-data";
import type { Brand, Locale, Model, PromptVersion } from "@/lib/supabase/database.types";
import type { BrandContext } from "@citroen-store/rihla-agent";

export type FullBrandContext = {
  brand: Brand;
  activePrompt: PromptVersion | null;
  models: Model[];
  /** Cities where this brand has at least one enabled showroom — used by the
   *  prompt builder to ground the agent in real coverage so it doesn't get
   *  stuck when a customer names a city outside the service area. */
  servedCities: string[];
};

// In-process cache. Survives Supabase outages so the demo doesn't 404 mid-pitch.
type CacheEntry = { ctx: FullBrandContext; cachedAt: number };
const brandCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000; // 60 s — refresh quickly so prompt edits land fast.

/** Per-brand agent persona name. Overrides whatever's in `brands.agent_name`
 *  in Supabase so we can rebrand without a migration / re-seed. */
const AGENT_NAME_OVERRIDES: Record<string, string> = {
  "jeep-ma": "NARA",
};

function applyOverrides(ctx: FullBrandContext): FullBrandContext {
  const override = AGENT_NAME_OVERRIDES[ctx.brand.slug];
  if (!override || ctx.brand.agent_name === override) return ctx;
  return { ...ctx, brand: { ...ctx.brand, agent_name: override } };
}

// Raw Supabase fetch, wrapped in Next's DURABLE data cache. The in-process Map
// above only lives for one serverless instance — under scale-to-zero / churn,
// most requests start with an empty Map and pay the full ~7s Supabase round
// trip (the "Waiting for server response: 7.24s" the widget showed). This
// cache persists across requests AND instances, so a cache hit returns in ~0ms.
// Brand data changes rarely; 5 min revalidate (stale-while-revalidate) means at
// most one request per window ever waits on Supabase. Throws on DB error so a
// transient failure is NOT cached and the outer fallback still runs.
const fetchBrandCached = unstable_cache(
  async (slug: string): Promise<FullBrandContext> => {
    const supa = adminClient();

    const { data: brandRow, error: bErr } = await supa
      .from("brands")
      .select("*")
      .eq("slug", slug)
      .eq("enabled", true)
      .single();
    if (bErr || !brandRow) {
      throw new Error(`brand fetch failed for ${slug}: ${bErr?.message ?? "no row"}`);
    }
    const brand = brandRow as unknown as Brand;

    const [models, prompt, showrooms] = await Promise.all([
      supa
        .from("models")
        .select("*")
        .eq("brand_id", brand.id)
        .eq("enabled", true)
        .order("display_order", { ascending: true }),
      supa
        .from("prompts")
        .select("*")
        .eq("brand_id", brand.id)
        .eq("is_active", true)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supa
        .from("showrooms")
        .select("city")
        .eq("brand_id", brand.id)
        .eq("enabled", true),
    ]);

    const cities = new Set<string>();
    for (const row of (showrooms.data as { city?: string | null }[] | null) ?? []) {
      if (row.city) cities.add(row.city.trim());
    }

    return applyOverrides({
      brand,
      activePrompt: (prompt.data as unknown as PromptVersion | null) ?? null,
      models: (models.data as unknown as Model[]) ?? [],
      servedCities: [...cities].sort(),
    });
  },
  ["brand-context"],
  { revalidate: 300, tags: ["brand-context"] }
);

/** Served cities for a brand, derived from the bundled static showroom list
 *  (the same source `find_showrooms` uses). Replaces the Supabase showrooms
 *  query so brand context needs zero DB access. */
function servedCitiesFromStatic(slug: string): string[] {
  const set = new Set<string>();
  for (const r of SHOWROOMS_DATA[slug] ?? []) {
    if (r.city) set.add(r.city.trim());
  }
  return [...set].sort();
}

/** Fetch the full brand bundle by slug.
 *
 *  LOCAL-FIRST: the Jeep chatbot (and any brand with a bundled JSON) runs
 *  entirely on static data — scripts/brand-data/<slug>.json + SHOWROOMS_DATA —
 *  with NO Supabase in the request path. That round trip was blocking the
 *  widget ~7s on every load ("Waiting for server response: 7.24s"). Supabase is
 *  only consulted for brands that have no local JSON. */
export async function getBrandContext(slug: string): Promise<FullBrandContext | null> {
  const cached = brandCache.get(slug);
  const fresh = cached && Date.now() - cached.cachedAt < CACHE_TTL_MS;
  if (fresh) return cached.ctx;

  // Local static data first — instant, no network.
  const local = await loadFromJsonFallback(slug);
  if (local) {
    const ctx = applyOverrides({ ...local, servedCities: servedCitiesFromStatic(slug) });
    brandCache.set(slug, { ctx, cachedAt: Date.now() });
    return ctx;
  }

  // No bundled JSON for this brand — fall back to Supabase (other/legacy demos).
  try {
    const ctx = await fetchBrandCached(slug);
    brandCache.set(slug, { ctx, cachedAt: Date.now() });
    return ctx;
  } catch (err) {
    // DB error / missing row / unreachable (incl. Supabase paused or restricted).
    // Degrade gracefully: stale in-process cache → local JSON → null.
    if (cached) {
      console.warn(`[brand-context] supabase fetch failed, serving stale cache for ${slug}:`, (err as Error).message?.slice(0, 80));
      return cached.ctx;
    }
    const fallback = await loadFromJsonFallback(slug);
    if (fallback) {
      const overridden = applyOverrides(fallback);
      console.warn(`[brand-context] supabase fetch failed, serving JSON fallback for ${slug}:`, (err as Error).message?.slice(0, 80));
      brandCache.set(slug, { ctx: overridden, cachedAt: Date.now() });
      return overridden;
    }
    console.warn(`[brand-context] supabase fetch failed + no fallback for ${slug}:`, (err as Error).message?.slice(0, 80));
    return null;
  }
}

/** Load brand from the local scraped JSON. Used when Supabase is unreachable. */
async function loadFromJsonFallback(slug: string): Promise<FullBrandContext | null> {
  try {
    const jsonPath = path.resolve(process.cwd(), "scripts", "brand-data", `${slug}.json`);
    const raw = await fs.readFile(jsonPath, "utf-8");
    const data = JSON.parse(raw) as {
      slug: string;
      name: string;
      homepage: string;
      market: string;
      defaultCurrency: string;
      models: Array<{
        slug: string;
        name: string;
        tagline?: string;
        description?: string;
        bodyType?: string;
        priceFrom?: number | null;
        currency?: string | null;
        fuel?: string | null;
        seats?: number | null;
        heroImage?: string;
        galleryImages?: string[];
        keyFeatures?: string[];
        pageUrl?: string;
      }>;
    };

    const fakeId = `fallback-${slug}`;
    const brand: Brand = {
      id: fakeId,
      slug: data.slug,
      name: data.name,
      homepage_url: data.homepage,
      market: data.market,
      default_currency: data.defaultCurrency,
      locales: pickLocalesForMarket(data.market, slug),
      primary_color: pickPrimaryColor(slug),
      logo_url: `/brands/${slug}/logo.svg`,
      agent_name: "Rihla",
      voice_name: "Aoede",
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const models: Model[] = data.models.map((m, idx) => ({
      id: `${fakeId}-model-${idx}`,
      brand_id: fakeId,
      slug: m.slug,
      name: m.name,
      tagline: m.tagline ?? null,
      description: m.description ?? null,
      body_type: m.bodyType ?? null,
      price_from: m.priceFrom ?? null,
      currency: m.currency ?? data.defaultCurrency,
      fuel: m.fuel ?? null,
      transmission: null,
      seats: m.seats ?? null,
      hero_image_url: m.heroImage ?? "",
      gallery_images: m.galleryImages ?? [],
      key_features: m.keyFeatures ?? [],
      specs: {},
      page_url: m.pageUrl ?? data.homepage,
      enabled: true,
      display_order: idx,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));

    return { brand, activePrompt: null, models, servedCities: [] };
  } catch {
    return null;
  }
}

function pickLocalesForMarket(market: string, slug: string): Locale[] {
  if (slug === "peugeot-ksa") return ["ar-SA", "en-SA"];
  if (market === "MA") return ["fr-MA", "ar-MA", "darija-MA", "en-MA"];
  return ["en-MA"];
}

function pickPrimaryColor(slug: string): string {
  if (slug === "citroen-ma") return "#D90030";
  if (slug === "jeep-ma") return "#1A5E2D";
  if (slug === "peugeot-ksa") return "#0E0E10";
  return "#121214";
}

/** Shape a FullBrandContext into the BrandContext the prompt builder expects. */
export function toAgentContext(full: FullBrandContext): BrandContext {
  return {
    brandSlug: full.brand.slug,
    brandName: full.brand.name,
    agentName: full.brand.agent_name,
    market: full.brand.market,
    defaultCurrency: full.brand.default_currency,
    servedCities: full.servedCities,
    models: full.models.map((m) => ({
      slug: m.slug,
      name: m.name,
      tagline: m.tagline,
      priceFrom: m.price_from,
      currency: m.currency,
      fuel: m.fuel,
      seats: m.seats,
      bodyType: m.body_type,
      keyFeatures: m.key_features,
    })),
  };
}

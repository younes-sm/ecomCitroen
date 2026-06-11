// /api/rihla/showrooms?brand=jeep-ma&city=Casablanca
// Returns the closest showrooms for a given brand + city. If no city match,
// returns all showrooms for the brand sorted by primary_dealer first.

import { NextRequest } from "next/server";
import { adminClient } from "@/lib/supabase/admin";
import { SHOWROOMS_DATA } from "@/lib/showrooms-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ShowroomRow = {
  id: string;
  name: string;
  city: string;
  address: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  hours: string | null;
  service_centre: boolean;
  primary_dealer: boolean;
};

/** Local fallback for when Supabase is unreachable/restricted, so the showroom
 *  selector still renders. Mirrors the DB shape, filtered + sorted like the query. */
function fallbackShowrooms(slug: string, city: string): ShowroomRow[] {
  const all = SHOWROOMS_DATA[slug] ?? [];
  const needle = city.toLowerCase();
  const matched = city ? all.filter((r) => r.city.toLowerCase().includes(needle)) : all;
  return matched
    .map((r, i) => ({
      id: `${slug}-fallback-${i}`,
      name: r.name,
      city: r.city,
      address: r.address ?? null,
      phone: r.phone ?? null,
      whatsapp: r.whatsapp ?? null,
      email: r.email ?? null,
      hours: r.hours ?? null,
      service_centre: r.service_centre ?? false,
      primary_dealer: r.primary_dealer ?? false,
    }))
    .sort((a, b) => Number(b.primary_dealer) - Number(a.primary_dealer) || a.name.localeCompare(b.name));
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const slug = url.searchParams.get("brand");
  const city = (url.searchParams.get("city") ?? "").trim();
  if (!slug) return Response.json({ items: [] }, { status: 400 });

  try {
    const supa = adminClient();
    const { data: brandRow } = await supa.from("brands").select("id").eq("slug", slug).single();
    const brandId = (brandRow as { id?: string } | null)?.id;
    if (!brandId) {
      // DB restricted / brand not seeded — serve local data so the selector renders.
      return Response.json({ items: fallbackShowrooms(slug, city), city: city || null });
    }

    let q = supa
      .from("showrooms")
      .select("id, name, city, address, phone, whatsapp, email, hours, service_centre, primary_dealer")
      .eq("brand_id", brandId)
      .eq("enabled", true);
    if (city) {
      // Case-insensitive city match — also fuzzy on prefix.
      q = q.ilike("city", `%${city}%`);
    }
    q = q.order("primary_dealer", { ascending: false }).order("name");
    const { data } = await q;
    let items = (data as unknown as ShowroomRow[]) ?? [];
    // DB reachable but returned nothing (e.g. showrooms not seeded) — fall back.
    if (items.length === 0) items = fallbackShowrooms(slug, city);
    return Response.json({ items, city: city || null });
  } catch (err) {
    console.warn("[showrooms] failed, serving local fallback:", (err as Error).message?.slice(0, 100));
    return Response.json({ items: fallbackShowrooms(slug, city), city: city || null });
  }
}

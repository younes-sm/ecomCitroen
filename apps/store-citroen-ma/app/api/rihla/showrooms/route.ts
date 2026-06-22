// /api/rihla/showrooms?brand=jeep-ma&city=Casablanca
// Returns the closest showrooms for a given brand + city. If no city match,
// returns all showrooms for the brand sorted by primary_dealer first.

import { NextRequest } from "next/server";
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

/** Build showroom rows from the bundled static dataset, filtered + sorted.
 *  This is now the sole source — the Jeep chatbot uses no Supabase at runtime. */
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

  // Served entirely from bundled static data — no Supabase round trip.
  return Response.json({ items: fallbackShowrooms(slug, city), city: city || null });
}

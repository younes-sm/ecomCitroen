/**
 * Emit clean Markdown transcripts of ALL engaged conversations (≥1 user turn)
 * over the last N days — for appending to the report.
 * Usage: pnpm exec tsx scripts/dump-transcripts-md.ts [days] [brandSlug]
 */
import path from "node:path";
import { config as loadEnv } from "dotenv";
loadEnv({ path: path.resolve(__dirname, "..", ".env.local") });
import { createClient } from "@supabase/supabase-js";

const DAYS = Number(process.argv[2] ?? 4);
const SLUG = process.argv[3] ?? "jeep-ma";

const clean = (s: string) =>
  (s ?? "")
    .replace(/\[(FIELD_TYPED|MAISON_SELECTED)\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
const clip = (s: string, n = 240) => (s.length > n ? s.slice(0, n) + "…" : s);

function dur(c: any): string {
  if (typeof c.duration_seconds === "number") return `${c.duration_seconds}s`;
  if (c.ended_at) return `${Math.round((+new Date(c.ended_at) - +new Date(c.started_at)) / 1000)}s`;
  return "—";
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supa = createClient(url, key, { auth: { persistSession: false } });
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();

  const { data: brand } = await supa.from("brands").select("id").eq("slug", SLUG).single();
  const brandId = (brand as { id: string }).id;
  const { data: convs } = await supa
    .from("conversations")
    .select("id,channel,locale,started_at,ended_at,duration_seconds")
    .eq("brand_id", brandId)
    .gte("started_at", since)
    .order("started_at", { ascending: true });

  let n = 0;
  for (const c of (convs ?? []) as any[]) {
    const { data: msgs } = await supa
      .from("messages")
      .select("role,kind,content")
      .eq("conversation_id", c.id)
      .order("seq", { ascending: true });
    const text = ((msgs ?? []) as any[]).filter((m) => m.kind === "text" && clean(m.content));
    if (!text.some((m) => m.role === "user")) continue; // engaged only
    n += 1;
    const d = new Date(c.started_at).toISOString().slice(5, 16).replace("T", " ");
    console.log(`\n### Conversation ${n} — ${c.channel} · ${c.locale} · ${d} · ${dur(c)}\n`);
    for (const m of text) {
      const who = m.role === "user" ? "**Client :**" : "**NARA :**";
      console.log(`> ${who} ${clip(clean(m.content))}`);
    }
  }
  console.log(`\n_(${n} conversations engagées)_`);
}
main().catch((e) => { console.error(e); process.exit(1); });

/**
 * Dump full conversation transcripts over the last N days.
 * Usage: pnpm exec tsx scripts/dump-transcripts.ts [days] [brandSlug]
 */
import path from "node:path";
import { config as loadEnv } from "dotenv";
loadEnv({ path: path.resolve(__dirname, "..", ".env.local") });
import { createClient } from "@supabase/supabase-js";

const DAYS = Number(process.argv[2] ?? 3);
const SLUG = process.argv[3] ?? "jeep-ma";

function dur(c: any): string {
  if (typeof c.duration_seconds === "number") return `${c.duration_seconds}s`;
  if (c.ended_at) return `${Math.round((+new Date(c.ended_at) - +new Date(c.started_at)) / 1000)}s`;
  return "open/—";
}
const clip = (s: string, n = 220) => (s.length > n ? s.slice(0, n) + "…" : s).replace(/\s+/g, " ");

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supa = createClient(url, key, { auth: { persistSession: false } });
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();

  const { data: brand } = await supa.from("brands").select("id").eq("slug", SLUG).single();
  const brandId = (brand as { id: string }).id;

  const { data: convs } = await supa
    .from("conversations")
    .select("id,channel,locale,status,started_at,ended_at,duration_seconds")
    .eq("brand_id", brandId)
    .gte("started_at", since)
    .order("started_at", { ascending: true });

  const rows = (convs ?? []) as any[];
  const empty: any[] = [];

  for (const c of rows) {
    const { data: msgs } = await supa
      .from("messages")
      .select("role,kind,content")
      .eq("conversation_id", c.id)
      .order("seq", { ascending: true });
    const m = (msgs ?? []) as any[];
    const t = new Date(c.started_at).toISOString().slice(5, 16).replace("T", " ");
    if (m.length === 0) { empty.push(c); continue; }

    console.log(`\n${"━".repeat(70)}`);
    console.log(`[${t}] ${c.channel.toUpperCase()} · ${c.locale} · ${c.status} · ${dur(c)} · ${m.length} msgs`);
    console.log("─".repeat(70));
    for (const x of m) {
      const who = x.role === "user" ? "👤 USER" : "🤖 NARA";
      const body = x.kind === "text" ? (x.content ?? "") : `[${x.kind}]${x.content ? " " + x.content : ""}`;
      console.log(`${who}: ${clip(body)}`);
    }
  }

  console.log(`\n${"═".repeat(70)}`);
  console.log(`EMPTY CONVERSATIONS (no messages): ${empty.length}`);
  console.log("─".repeat(70));
  for (const c of empty) {
    const t = new Date(c.started_at).toISOString().slice(5, 16).replace("T", " ");
    console.log(`[${t}] ${c.channel}/${c.locale} ${c.status} · duration ${dur(c)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

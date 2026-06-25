/**
 * One-off report: Jeep chatbot conversations over the last N days.
 * Usage: pnpm exec tsx scripts/report-conversations.ts [days] [brandSlug]
 */
import path from "node:path";
import { config as loadEnv } from "dotenv";
loadEnv({ path: path.resolve(__dirname, "..", ".env.local") });
import { createClient } from "@supabase/supabase-js";

const DAYS = Number(process.argv[2] ?? 3);
const SLUG = process.argv[3] ?? "jeep-ma";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  const supa = createClient(url, key, { auth: { persistSession: false } });
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  console.log(`\n=== Report: ${SLUG} · last ${DAYS} days (since ${since}) ===`);
  console.log(`project: ${url}\n`);

  const { data: brand } = await supa.from("brands").select("id,name").eq("slug", SLUG).single();
  if (!brand) { console.log("Brand not found."); return; }
  const brandId = (brand as { id: string }).id;

  const { data: convs } = await supa
    .from("conversations")
    .select("id,channel,locale,status,started_at,ended_at,duration_seconds,lead_name,lead_phone,lead_email,lead_city,lead_model_slug,lead_showroom")
    .eq("brand_id", brandId)
    .gte("started_at", since)
    .order("started_at", { ascending: true });

  const rows = convs ?? [];
  console.log(`TOTAL CONVERSATIONS: ${rows.length}`);
  if (rows.length === 0) { console.log("(none — prod may write to a different Supabase project)"); }

  const byChannel: Record<string, number> = {};
  const byLocale: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const c of rows as any[]) {
    byChannel[c.channel] = (byChannel[c.channel] ?? 0) + 1;
    byLocale[c.locale] = (byLocale[c.locale] ?? 0) + 1;
    byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
  }
  console.log("by channel:", byChannel);
  console.log("by locale :", byLocale);
  console.log("by status :", byStatus);

  // Per-conversation message breakdown.
  let totalUser = 0, totalAssistant = 0, withAssistant = 0, emptyConvs = 0;
  console.log("\n--- per conversation ---");
  for (const c of rows as any[]) {
    const { data: msgs } = await supa
      .from("messages")
      .select("role,kind,content,created_at")
      .eq("conversation_id", c.id)
      .order("seq", { ascending: true });
    const m = msgs ?? [];
    const u = m.filter((x: any) => x.role === "user").length;
    const a = m.filter((x: any) => x.role === "assistant").length;
    totalUser += u; totalAssistant += a;
    if (a > 0) withAssistant++;
    if (m.length === 0) emptyConvs++;
    const lead = c.lead_name ? ` LEAD:${c.lead_name}/${c.lead_phone ?? "?"}` : "";
    const t = new Date(c.started_at).toISOString().slice(5, 16).replace("T", " ");
    console.log(`[${t}] ${c.channel}/${c.locale} ${c.status} · ${u}u/${a}a msgs${lead}`);
  }

  // Tool usage.
  const { data: tools } = await supa
    .from("tool_calls")
    .select("name,conversation_id,created_at")
    .gte("created_at", since);
  const toolCounts: Record<string, number> = {};
  for (const t of (tools ?? []) as any[]) toolCounts[t.name] = (toolCounts[t.name] ?? 0) + 1;

  // Leads / appointments / complaints.
  const { count: leadCount } = await supa.from("leads").select("id", { count: "exact", head: true }).eq("brand_id", brandId).gte("created_at", since);
  const { count: apptCount } = await supa.from("service_appointments").select("id", { count: "exact", head: true }).eq("brand_id", brandId).gte("created_at", since);
  const { count: complaintCount } = await supa.from("complaints").select("id", { count: "exact", head: true }).eq("brand_id", brandId).gte("created_at", since);

  console.log("\n--- aggregates ---");
  console.log(`messages: ${totalUser} user / ${totalAssistant} assistant`);
  console.log(`conversations WITH assistant turns: ${withAssistant}/${rows.length}`);
  console.log(`conversations with NO messages at all: ${emptyConvs}`);
  console.log("tool calls:", toolCounts);
  console.log(`leads: ${leadCount ?? 0} · service appointments: ${apptCount ?? 0} · complaints: ${complaintCount ?? 0}`);
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); });

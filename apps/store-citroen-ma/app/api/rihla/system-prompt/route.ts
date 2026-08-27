// Returns the assembled system prompt + greeting + agent settings for a brand.
// Thin HTTP wrapper — the actual composition lives in lib/voice-prompt.ts and
// is shared with /api/rihla/voice/token, which bakes the same prompt into the
// ephemeral live-session token. Response shape is unchanged.

import { NextRequest } from "next/server";
import { composeVoicePrompt } from "@/lib/voice-prompt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const bundle = await composeVoicePrompt({
    brandSlug: url.searchParams.get("brand"),
    localeParam: url.searchParams.get("locale"),
    voice: url.searchParams.get("voice") === "1",
  });
  return Response.json(bundle);
}

// Returns the assembled system prompt + greeting + agent settings for a brand.
//
// The assembly itself lives in lib/voice-prompt.ts so the voice TOKEN route can
// build the identical prompt (it has to bake it into the ephemeral token —
// Google discards the browser's setup message in constrained Live mode).

import { NextRequest } from "next/server";
import { assemblePrompt } from "@/lib/voice-prompt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const brandSlug = url.searchParams.get("brand") ?? "jeep-ma";
  const localeParam = url.searchParams.get("locale");
  const voice = url.searchParams.get("voice") === "1";

  const { systemPrompt, opening, voiceName, locale, brand } = await assemblePrompt({
    brandSlug,
    localeParam,
    voice,
  });

  return Response.json({
    systemPrompt,
    opening,
    voiceName,
    brand: { slug: brand.brandSlug, name: brand.brandName, agentName: brand.agentName },
    locale,
  });
}

// Ephemeral-token mint for the Gemini Live voice session.
//
// The browser never sees GOOGLE_API_KEY. It POSTs {brandSlug, locale} here and
// receives a short-lived single-use token, then connects to the v1alpha
// `BidiGenerateContentConstrained` WebSocket with it.
//
// CRITICAL — learned the hard way (prod incident 2026-08-27): on the
// Constrained endpoint the client's `setup` message is silently IGNORED. The
// ENTIRE session config — model, voice, system prompt, tools, transcription —
// must be baked into the token via `bidiGenerateContentSetup` at mint time. A
// bare token yields a session with no persona (generic answers about
// Jeep/France) and the default male voice. Note the wire field is
// `bidiGenerateContentSetup`; the older `liveConnectConstraints` name is
// rejected by the current API.

import { NextRequest } from "next/server";
import { composeVoicePrompt } from "@/lib/voice-prompt";
import { LIVE_TOOLS } from "@/lib/live-tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIVE_MODEL = "models/gemini-3.1-flash-live-preview";

export async function POST(req: NextRequest) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.error("[voice/token] GOOGLE_API_KEY not configured");
    return Response.json({ error: "voice unavailable" }, { status: 503 });
  }

  let body: { brandSlug?: string; locale?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    // empty body tolerated — falls back to defaults like the system-prompt GET
  }

  const { systemPrompt, voiceName } = await composeVoicePrompt({
    brandSlug: body.brandSlug,
    localeParam: body.locale,
    voice: true,
  });

  const mintRes = await fetch(
    `https://generativelanguage.googleapis.com/v1alpha/auth_tokens?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uses: 1,
        bidiGenerateContentSetup: {
          model: LIVE_MODEL,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName } },
            },
          },
          // Transcribe both sides so the hook can persist the transcript.
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: { parts: [{ text: systemPrompt }] },
          tools: LIVE_TOOLS,
        },
      }),
    }
  );

  if (!mintRes.ok) {
    // Never echo the upstream body verbatim into logs at error level with the
    // URL — it can contain the key in some proxy setups. Status + trimmed
    // message only.
    const detail = await mintRes.text().catch(() => "");
    console.error(
      `[voice/token] mint failed: HTTP ${mintRes.status} ${detail.slice(0, 200).replace(/key=[^&"\s]+/g, "key=***")}`
    );
    return Response.json({ error: "voice unavailable" }, { status: 502 });
  }

  const minted = (await mintRes.json()) as { name?: string; expireTime?: string };
  if (!minted.name) {
    console.error("[voice/token] mint response missing token name");
    return Response.json({ error: "voice unavailable" }, { status: 502 });
  }

  return Response.json({
    token: minted.name,
    expiresAt: minted.expireTime ?? null,
    voiceName,
  });
}

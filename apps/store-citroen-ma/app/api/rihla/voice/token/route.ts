// POST /api/rihla/voice/token
// Mints a SHORT-LIVED, SINGLE-USE ephemeral token for the Gemini Live API so
// the browser never sees the real GOOGLE_API_KEY.
//
// IMPORTANT — why the whole session config is baked in here:
// Ephemeral tokens force the connection onto the CONSTRAINED Live method
// (BidiGenerateContentConstrained). In that mode Google treats the TOKEN's
// `liveConnectConstraints` as authoritative and DISCARDS the `setup` message
// the browser sends. Verified against the live endpoint:
//   • token locking only model+modality → the browser's systemInstruction and
//     tools were ignored; the agent answered as generic Gemini ("l'Avenger,
//     vous parlez des films Marvel ?") and never called a tool.
//   • token carrying systemInstruction + tools → both honoured; the agent
//     stayed in character and fired show_model_image(slug="compass").
// So the system prompt, tools, voice and transcription settings must ALL be
// locked here, server-side.
//
// Security model:
//   • GOOGLE_API_KEY stays server-only — never shipped to the browser bundle.
//   • The token opens exactly ONE Live session (`uses: 1`) within a ~1 min
//     window, and the session may then run up to `expireTime`.
//   • Because the config is locked, a stolen token cannot be repointed at a
//     different model, given a different system prompt, or handed new tools.
//   • Bonus: the system prompt and tool surface are no longer published to
//     every visitor in the client bundle.

import { NextRequest } from "next/server";
import { GoogleGenAI, Modality, type LiveConnectConfig } from "@google/genai";
import { assemblePrompt } from "@/lib/voice-prompt";
import { LIVE_TOOLS } from "@/lib/live-tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIVE_MODEL = "models/gemini-3.1-flash-live-preview";

// How long the session may run once started, and how long the caller has to
// actually open the session after minting the token.
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min max call length
const START_WINDOW_MS = 60 * 1000; // 1 min to open the WS

export async function POST(req: NextRequest) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "GOOGLE_API_KEY not set" }, { status: 503 });
  }

  let brandSlug = "jeep-ma";
  let locale: string | null = "fr";
  try {
    const body = (await req.json()) as { brandSlug?: string; locale?: string };
    if (body?.brandSlug) brandSlug = body.brandSlug;
    if (body?.locale) locale = body.locale;
  } catch {
    // No body — fall back to the Jeep defaults above.
  }

  try {
    const { systemPrompt, voiceName } = await assemblePrompt({
      brandSlug,
      localeParam: locale,
      voice: true,
    });

    // The exact config the Live session will run with. Locked into the token.
    const liveConfig: LiveConnectConfig = {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName } },
      },
      systemInstruction: { parts: [{ text: systemPrompt }] },
      tools: LIVE_TOOLS,
      // Transcribe both sides so the widget can persist the transcript.
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };

    // The ephemeral-token API lives on the v1alpha surface.
    const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1alpha" } });

    const now = Date.now();
    const token = await ai.authTokens.create({
      config: {
        uses: 1, // single use — one WebSocket open
        expireTime: new Date(now + SESSION_TTL_MS).toISOString(),
        newSessionExpireTime: new Date(now + START_WINDOW_MS).toISOString(),
        liveConnectConstraints: {
          model: LIVE_MODEL,
          config: liveConfig,
        },
      },
    });

    // `token.name` is the opaque "auth_tokens/…" string the browser passes as
    // ?access_token= on the constrained Live endpoint.
    return Response.json({
      token: token.name,
      voiceName,
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    });
  } catch (err) {
    console.error("[voice/token] failed to mint ephemeral token:", err);
    return Response.json({ error: "token mint failed" }, { status: 502 });
  }
}

// POST /api/rihla/voice/token
// Mints a SHORT-LIVED, SINGLE-USE ephemeral token for the Gemini Live API so
// the browser never sees the real GOOGLE_API_KEY. The widget calls this right
// before opening its WebSocket and puts the returned token where the API key
// used to go.
//
// Security model:
//   • GOOGLE_API_KEY stays server-only (NOT NEXT_PUBLIC_) — never shipped to
//     the browser bundle.
//   • The token is usable exactly once to open ONE Live session
//     (`uses: 1`), and only within a ~1 minute window to start that session
//     (`newSessionExpireTime`). The session itself may then run up to
//     `expireTime`. Even if the token leaks from the network tab, it is spent
//     and expired within seconds.
//   • `liveConnectConstraints` pins the model + response modality server-side
//     so a stolen token can't be repurposed for a different, costlier model.
//
// Requires @google/genai >= 1.x with the ephemeral-token API (authTokens),
// which must talk to the v1alpha surface.

import { GoogleGenAI } from "@google/genai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIVE_MODEL = "models/gemini-3.1-flash-live-preview";

// How long the session may run once started, and how long the caller has to
// actually open the session after minting the token.
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min max call length
const START_WINDOW_MS = 60 * 1000; // 1 min to open the WS

export async function POST() {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "GOOGLE_API_KEY not set" }, { status: 503 });
  }

  try {
    // The ephemeral-token API lives on the v1alpha surface.
    const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1alpha" } });

    const now = Date.now();
    const token = await ai.authTokens.create({
      config: {
        uses: 1, // single use — one WebSocket open
        expireTime: new Date(now + SESSION_TTL_MS).toISOString(),
        newSessionExpireTime: new Date(now + START_WINDOW_MS).toISOString(),
        // Lock the token to exactly the Live config the widget uses, so a
        // leaked token can't be pointed at a different model.
        liveConnectConstraints: {
          model: LIVE_MODEL,
          config: {
            responseModalities: ["AUDIO"],
          },
        },
      },
    });

    // `token.name` is the opaque string the browser passes in place of the key.
    return Response.json({
      token: token.name,
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    });
  } catch (err) {
    console.error("[voice/token] failed to mint ephemeral token:", err);
    return Response.json({ error: "token mint failed" }, { status: 502 });
  }
}

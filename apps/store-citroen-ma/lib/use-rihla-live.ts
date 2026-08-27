"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ─── Types ──────────────────────────────────────────────────────────────────

export type LiveState = "idle" | "connecting" | "connected" | "speaking" | "listening" | "error";

export type LiveToolCall = {
  name: string;
  id: string;
  args: Record<string, unknown>;
};

type LiveCallbacks = {
  onToolCall: (call: LiveToolCall) => string;
  onTranscript?: (text: string, fromUser: boolean) => void;
  onStateChange?: (state: LiveState) => void;
};

type GeminiMsg =
  | { setupComplete: unknown }
  | {
      serverContent?: {
        modelTurn?: { parts?: Array<{ inlineData?: { data: string; mimeType: string }; text?: string }> };
        inputTranscription?: { text?: string; finished?: boolean };
        outputTranscription?: { text?: string; finished?: boolean };
        turnComplete?: boolean;
      };
    }
  | {
      toolCall?: {
        functionCalls: Array<{ name: string; id: string; args: Record<string, unknown> }>;
      };
    };

// ─── Tool declarations for the live session ─────────────────────────────────

// LIVE_TOOLS moved to lib/live-tools.ts — the tool list is now locked into
// the ephemeral token server-side (constrained Live mode ignores tools sent
// from the browser). Keeping it out of the bundle also stops publishing the
// tool surface to every visitor.

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useRihlaLive(
  locale: string,
  voiceName: string = "Aoede",
  callbacks: LiveCallbacks,
  brandSlug?: string
) {
  const [state, setState] = useState<LiveState>("idle");
  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Input-side AudioContext (separate from audioCtxRef which is for OUTPUT
  // playback at 24 kHz). Tracked so we can resume it after a tab-hide auto-
  // suspend AND so we can close it cleanly on disconnect.
  const micCtxRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const playQueueRef = useRef<Float32Array[]>([]);
  const isPlayingRef = useRef(false);
  // Half-duplex gate. True from the first audio chunk of a model turn until
  // playback fully drains. While true, the mic processor drops outgoing frames
  // so the agent's own voice (which browser AEC does NOT cancel for Web Audio
  // output) can't echo back into Gemini's VAD and trigger a duplicate/looping
  // turn — the "agent repeats itself without letting me respond" bug.
  const agentSpeakingRef = useRef(false);
  const shouldDisconnectRef = useRef(false);
  // Guards against connect() running twice concurrently. React StrictMode
  // double-invokes effects in dev, and a re-render can re-fire the auto-
  // start effect — a second connect() would pre-clean (stop the mic stream)
  // the first connect() just acquired, producing the "mic opens then closes
  // then opens again" flicker the user reported. Set true the moment
  // connect() starts, cleared only when the session fully ends.
  const connectInFlightRef = useRef(false);
  const disconnectRef = useRef<(() => void) | null>(null);
  // Idle auto-end. A voice call that connects but sees NO interaction (no user
  // speech, no agent turn) leaves the conversation stuck "open" in the DB —
  // the dashboard was full of abandoned voice rows. We stamp lastActivityRef on
  // every user/agent transcript + tool call, and a watchdog ends the call after
  // IDLE_TIMEOUT_MS of silence (disconnect() persists "end" → closes the row).
  const IDLE_TIMEOUT_MS = 60_000;
  const lastActivityRef = useRef<number>(0);
  const idleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  // Voice persistence — server-issued conversation id, plus rolling buffers
  // for the currently-streaming user and assistant turns. Both are flushed on
  // each model turnComplete so persistence doesn't depend on Gemini setting
  // a `finished` flag (which it doesn't always set).
  const conversationIdRef = useRef<string | null>(null);
  const userBufferRef = useRef<string>("");
  const assistantBufferRef = useRef<string>("");

  const persistEvent = useCallback(async (payload: Record<string, unknown>) => {
    if (!conversationIdRef.current) return;
    try {
      await fetch("/api/rihla/voice/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: conversationIdRef.current, ...payload }),
      });
    } catch {
      // Best-effort; never break the call flow on persistence failure.
    }
  }, []);

  const updateState = useCallback((s: LiveState) => {
    setState(s);
    callbacksRef.current.onStateChange?.(s);
  }, []);

  const getAudioCtx = useCallback(() => {
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      audioCtxRef.current = new AudioContext({ sampleRate: 24000 });
    }
    if (audioCtxRef.current.state === "suspended") audioCtxRef.current.resume();
    return audioCtxRef.current;
  }, []);

  // ─── Play received audio ────────────────────────────────────────────────

  const playNextChunk = useCallback(() => {
    if (isPlayingRef.current || playQueueRef.current.length === 0) return;
    isPlayingRef.current = true;

    const ctx = getAudioCtx();
    // Merge all queued chunks into one buffer for gapless playback
    const totalLength = playQueueRef.current.reduce((s, c) => s + c.length, 0);
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of playQueueRef.current) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    playQueueRef.current = [];

    const buffer = ctx.createBuffer(1, merged.length, 24000);
    buffer.getChannelData(0).set(merged);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.onended = () => {
      isPlayingRef.current = false;
      if (playQueueRef.current.length > 0) playNextChunk();
    };
    src.start();
    updateState("speaking");
  }, [getAudioCtx, updateState]);

  const enqueueAudio = useCallback(
    (base64: string) => {
      // The model is producing speech for this turn — close the mic gate so we
      // don't feed its own audio back to Gemini.
      agentSpeakingRef.current = true;
      const raw = atob(base64);
      const pcm = new Int16Array(raw.length / 2);
      for (let i = 0; i < pcm.length; i++) {
        pcm[i] = raw.charCodeAt(i * 2) | (raw.charCodeAt(i * 2 + 1) << 8);
      }
      const float = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) float[i] = (pcm[i] ?? 0) / 32768;
      playQueueRef.current.push(float);
      // Start playback after a small buffer (200ms worth of audio = 4800 samples at 24kHz)
      const totalQueued = playQueueRef.current.reduce((s, c) => s + c.length, 0);
      if (!isPlayingRef.current && totalQueued > 4800) {
        playNextChunk();
      }
    },
    [playNextChunk]
  );

  // ─── WebSocket message handler ──────────────────────────────────────────

  const handleMessage = useCallback(
    (data: string) => {
      let msg: GeminiMsg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }

      if ("setupComplete" in msg) {
        updateState("listening");
        return;
      }

      if ("toolCall" in msg && msg.toolCall) {
        for (const fc of msg.toolCall.functionCalls) {
          // Persist every tool call (incl. end_call, book_test_drive).
          if (brandSlug) {
            void persistEvent({
              kind: "tool_call",
              brandSlug,
              name: fc.name,
              input: fc.args ?? {},
            });
          }
          if (fc.name === "end_call") {
            // 1. Mark for disconnect when audio drains.
            shouldDisconnectRef.current = true;
            // 2. Forward to caller so the UI can navigate (bubble switches off CallView).
            try { callbacksRef.current.onToolCall({ name: fc.name, id: fc.id, args: fc.args }); }
            catch { /* swallow */ }
            // 3. Hard backstop: after 6s, force disconnect even if turnComplete never arrives
            //    or the audio queue gets stuck. This is the safety net for the freeze the user hit.
            window.setTimeout(() => {
              if (shouldDisconnectRef.current) {
                shouldDisconnectRef.current = false;
                disconnectRef.current?.();
              }
            }, 6000);
            // 4. Ack the tool so the model can emit one final farewell turn.
            wsRef.current?.send(
              JSON.stringify({
                toolResponse: {
                  functionResponses: [
                    { name: fc.name, id: fc.id, response: { result: "call ended" } },
                  ],
                },
              })
            );
            continue;
          }
          const result = callbacksRef.current.onToolCall({
            name: fc.name,
            id: fc.id,
            args: fc.args,
          });
          wsRef.current?.send(
            JSON.stringify({
              toolResponse: {
                functionResponses: [
                  { name: fc.name, id: fc.id, response: { result } },
                ],
              },
            })
          );
        }
        return;
      }

      if ("serverContent" in msg && msg.serverContent) {
        const sc = msg.serverContent;

        // User speech transcript chunks (inputAudioTranscription must be
        // enabled in the setup payload). Buffer until turnComplete.
        if (sc.inputTranscription?.text) {
          const t = sc.inputTranscription.text;
          // Real user speech = activity → reset the idle clock.
          lastActivityRef.current = Date.now();
          userBufferRef.current += t;
          callbacksRef.current.onTranscript?.(t, true);
        }
        // Model speech transcript chunks.
        if (sc.outputTranscription?.text) {
          const t = sc.outputTranscription.text;
          assistantBufferRef.current += t;
          callbacksRef.current.onTranscript?.(t, false);
        }

        const parts = sc?.modelTurn?.parts ?? [];
        for (const part of parts) {
          if (part.inlineData?.data) {
            enqueueAudio(part.inlineData.data);
          }
          if (part.text) {
            assistantBufferRef.current += part.text;
            callbacksRef.current.onTranscript?.(part.text, false);
          }
        }
        if (sc?.turnComplete) {
          // A completed turn restarts the idle clock — the user gets a full
          // IDLE_TIMEOUT_MS to respond after the agent finishes speaking.
          lastActivityRef.current = Date.now();
          // Flush BOTH buffers once per completed model turn. Persisting user
          // text first preserves chronological order in the transcript view.
          if (userBufferRef.current.trim()) {
            void persistEvent({ kind: "user_text", text: userBufferRef.current.trim() });
            userBufferRef.current = "";
          }
          if (assistantBufferRef.current) {
            void persistEvent({ kind: "assistant_text", text: assistantBufferRef.current });
            assistantBufferRef.current = "";
          }
          // Flush remaining audio
          if (playQueueRef.current.length > 0 && !isPlayingRef.current) {
            playNextChunk();
          }
          // After playback finishes: either disconnect (end_call was called) or
          // go back to listening.
          const checkDone = () => {
            if (!isPlayingRef.current) {
              if (shouldDisconnectRef.current) {
                shouldDisconnectRef.current = false;
                disconnectRef.current?.();
              } else {
                // Reopen the mic only after a short tail delay so the speaker's
                // decay/reverb doesn't get captured and re-trigger the agent.
                setTimeout(() => { agentSpeakingRef.current = false; }, 250);
                updateState("listening");
              }
            } else {
              setTimeout(checkDone, 100);
            }
          };
          setTimeout(checkDone, 200);
        }
      }
    },
    [enqueueAudio, playNextChunk, updateState]
  );

  // ─── Mic capture → send PCM to Gemini ───────────────────────────────────

  const startMic = useCallback(
    async (ws: WebSocket) => {
      console.log("%c[voice] 🎙️ requesting microphone…", "color:#22c55e");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      const micLabel = stream.getAudioTracks()[0]?.label || "default device";
      console.log(`%c[voice] 🎙️ microphone GRANTED — ${micLabel}`, "color:#22c55e;font-weight:bold");

      // Reuse the existing micCtxRef if it's still alive — by the second
      // reconnect, creating a fresh AudioContext lands it in "suspended"
      // state, and we can't resume it (no gesture). Reusing the already-
      // running context from the first session is what keeps mic capture
      // working across reconnects.
      const ctx =
        micCtxRef.current && micCtxRef.current.state !== "closed"
          ? micCtxRef.current
          : new AudioContext({ sampleRate: 16000 });
      micCtxRef.current = ctx;
      // Browsers create AudioContexts in "suspended" state when not inside a
      // user gesture. Our connect() runs from a useEffect (auto-start when the
      // user picks voice mode), which is async and loses the gesture context.
      // Without this resume, processor.onaudioprocess never fires → mic
      // captures nothing → agent appears "not listening". This is THE fix
      // for the intermittent "have to close + reopen the call" bug.
      if (ctx.state === "suspended") {
        try { await ctx.resume(); } catch (err) {
          console.warn("[rihla-live] mic AudioContext resume failed", err);
        }
      }

      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;

      // Use ScriptProcessor as a simple cross-browser fallback
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      let firstAudioFired = false;
      processor.onaudioprocess = (e) => {
        if (!firstAudioFired) {
          firstAudioFired = true;
          console.log(`%c[voice] 🎙️ microphone CAPTURING — audio flowing to Gemini (ctx.state=${ctx.state})`, "color:#22c55e;font-weight:bold");
        }
        if (ws.readyState !== WebSocket.OPEN) return;
        // Half-duplex: while the agent is speaking, don't forward mic audio.
        // Otherwise the agent's voice leaking through the speaker is captured
        // and Gemini treats it as a new user turn → the agent repeats itself.
        if (agentSpeakingRef.current) return;
        const input = e.inputBuffer.getChannelData(0);
        const pcm16 = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          pcm16[i] = Math.max(-32768, Math.min(32767, Math.round((input[i] ?? 0) * 32767)));
        }
        const bytes = new Uint8Array(pcm16.buffer);
        let b64 = "";
        for (let i = 0; i < bytes.length; i++) b64 += String.fromCharCode(bytes[i]!);
        ws.send(
          JSON.stringify({
            realtimeInput: {
              audio: { data: btoa(b64), mimeType: "audio/pcm;rate=16000" },
            },
          })
        );
      };
      source.connect(processor);
      processor.connect(ctx.destination);
      workletRef.current = processor as unknown as AudioWorkletNode;

      // Watchdog: if no audio frame fires within 3 s, the AudioContext is
      // probably still suspended (browser policy edge case). Log loudly so
      // we can see it in DevTools and re-attempt the resume.
      window.setTimeout(() => {
        if (!firstAudioFired) {
          console.warn(
            `[rihla-live] mic watchdog: no audio frames after 3 s. ctx.state=${ctx.state}. Attempting resume + recovery.`
          );
          if (ctx.state === "suspended") {
            void ctx.resume().catch((err) =>
              console.warn("[rihla-live] watchdog resume failed", err)
            );
          }
        }
      }, 3000);
    },
    []
  );

  // ─── Connect ──────────────────────────────────────────────────────────────

  const connect = useCallback(async () => {
    // NOTE: no API key in the browser. We fetch a short-lived, single-use
    // ephemeral token from our own server (/api/rihla/voice/token) below and
    // use THAT in the WebSocket URL. The real GOOGLE_API_KEY never leaves the
    // backend.

    // In-flight guard: a second connect() while the first is still setting
    // up would stop the mic stream the first call just acquired (the
    // "mic opens, closes, opens again" flicker). Bail if a session is
    // already being established or is live.
    if (connectInFlightRef.current) {
      console.warn("[voice] ⚠️ connect() ignored — a session is already in flight");
      return;
    }
    connectInFlightRef.current = true;
    console.log("%c[voice] ▶️ SESSION STARTING — opening WebSocket + microphone", "color:#3b82f6;font-weight:bold");

    // Defensive resets — guard against any stale state from a previous
    // session leaking into the new one. Without this, the first connection
    // after the user navigates back into voice mode could see a leftover
    // shouldDisconnectRef = true (e.g., from a prior end_call where the
    // backstop fired) and silently disconnect mid-greeting.
    shouldDisconnectRef.current = false;
    isPlayingRef.current = false;
    agentSpeakingRef.current = false;
    playQueueRef.current = [];
    userBufferRef.current = "";
    assistantBufferRef.current = "";

    // If the user re-opens the call before the previous session fully tore
    // down (the WS hasn't fired onclose yet, or the mic stream is still
    // live), aggressively close them BEFORE we start fresh. This also lets
    // the stale-ws guard in onclose/onerror identify the old socket as
    // superseded via the wsRef !== ws check.
    if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
      try {
        wsRef.current.close();
      } catch { /* */ }
      wsRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    // We deliberately keep micCtxRef alive — it's reused by startMic() to
    // avoid re-creating an AudioContext that the browser won't let us
    // resume outside a fresh gesture (see comment in stopMic).
    try { workletRef.current?.disconnect(); } catch { /* */ }
    workletRef.current = null;
    try { sourceRef.current?.disconnect(); } catch { /* */ }
    sourceRef.current = null;

    // Pre-warm + resume the audio context now (we're inside a click handler
    // so browsers will allow it). Doing this here, awaited via the audio
    // queue's first-chunk path, avoids a silent first-greeting that
    // otherwise plays into a suspended context.
    try {
      const ctx = audioCtxRef.current && audioCtxRef.current.state !== "closed"
        ? audioCtxRef.current
        : new AudioContext({ sampleRate: 24000 });
      audioCtxRef.current = ctx;
      if (ctx.state === "suspended") void ctx.resume();
    } catch { /* AudioContext unavailable — non-fatal */ }

    updateState("connecting");

    // Fetch the system prompt + register the voice conversation BEFORE
    // opening the WebSocket. Gemini Live closes the socket with code 1007
    // ("Request contains an invalid argument") if the `setup` message
    // doesn't arrive promptly after the connection opens. The old code
    // opened the WS in parallel with these fetches and sent `setup` only
    // once they resolved inside ws.onopen — when a fetch was slow, Gemini
    // had already killed the socket, and ws.send() threw "WebSocket is
    // already in CLOSING or CLOSED state". Fetching first means onopen can
    // fire setup synchronously, the instant the socket is ready.
    const promptParams = new URLSearchParams({
      locale,
      voice: "1",
      ...(brandSlug ? { brand: brandSlug } : {}),
    });
    let systemPrompt = "";
    let resolvedVoice = voiceName;
    // Ephemeral token minted server-side — replaces the API key in the WS URL.
    let liveToken = "";
    try {
      const [promptResult, voiceResult, tokenResult] = await Promise.all([
        fetch(`/api/rihla/system-prompt?${promptParams}`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null) as Promise<{ systemPrompt: string; voiceName?: string } | null>,
        brandSlug
          ? (fetch("/api/rihla/voice/start", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ brandSlug, locale }),
            })
              .then((r) => (r.ok ? r.json() : null))
              .catch(() => null) as Promise<{ id?: string } | null>)
          : Promise.resolve(null),
        // The token carries the whole locked session config (system prompt,
        // tools, voice), so it needs to know which brand + locale to build.
        fetch("/api/rihla/voice/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brandSlug, locale }),
        })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null) as Promise<{ token?: string; voiceName?: string } | null>,
      ]);
      systemPrompt = promptResult?.systemPrompt ?? "";
      resolvedVoice = promptResult?.voiceName ?? voiceName;
      if (voiceResult?.id) conversationIdRef.current = voiceResult.id;
      liveToken = tokenResult?.token ?? "";
    } catch (err) {
      console.warn("[voice] prompt / voice-start / token fetch failed", err);
    }

    if (!liveToken) {
      console.error("[rihla-live] no ephemeral token — cannot open Live session");
      connectInFlightRef.current = false;
      updateState("error");
      return;
    }

    // The user may have hit the red button while the prompt was loading —
    // disconnect() clears connectInFlightRef. Abort instead of opening a WS
    // for a session the user already cancelled.
    if (!connectInFlightRef.current) {
      console.warn("%c[voice] ↩️ connect aborted — session cancelled during prompt fetch", "color:#f59e0b");
      return;
    }

    // Ephemeral tokens are NOT a drop-in for the `?key=` param. Per the SDK
    // (@google/genai, live.connect), a key starting with "auth_tokens/" must
    // use a different surface entirely:
    //   • apiVersion  v1beta  → v1alpha        (tokens are v1alpha-only)
    //   • method      BidiGenerateContent → BidiGenerateContentConstrained
    //   • param       ?key=   → ?access_token=
    // Getting any of these wrong returns close code 1007 "API key not valid".
    // The token is interpolated raw (not URI-encoded) — it contains a "/" that
    // the endpoint expects literally, exactly as the SDK sends it.
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${liveToken}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;
    // Track session duration so unexpected closes ("user said 3 words then it
    // died") can be distinguished from "10 minute call, then end_call".
    const wsOpenedAt = Date.now();
    // Mic acquisition runs alongside the WS handshake. The processor sends
    // nothing until the WS is OPEN (see startMic), so order doesn't matter.
    startMic(ws).catch((err) => {
      console.error("%c[voice] 🎙️ microphone FAILED to start", "color:#ef4444;font-weight:bold", err);
    });

    ws.onopen = () => {
      console.log("%c[voice] 🔌 WebSocket OPEN — sending setup to Gemini", "color:#3b82f6");
      void persistEvent({ kind: "ws_diag", phase: "open" });
      // Send setup IMMEDIATELY — Gemini kills the socket if `setup` is late.
      //
      // On the CONSTRAINED endpoint this message is essentially a handshake:
      // Google ignores its contents and uses the config locked into the
      // ephemeral token instead (system prompt, tools, voice, transcription —
      // all set server-side in /api/rihla/voice/token). We still send `model`
      // because the handshake requires a setup frame. Do NOT re-add the
      // prompt/tools here expecting them to apply — they are silently dropped,
      // which is exactly the bug that made the agent answer as generic Gemini.
      try {
        ws.send(
          JSON.stringify({
            setup: { model: "models/gemini-3.1-flash-live-preview" },
          })
        );
        console.log(
          `%c[voice] ✅ SESSION READY — conv=${conversationIdRef.current ?? "n/a"} voice=${resolvedVoice}`,
          "color:#22c55e;font-weight:bold"
        );
        // Start the idle watchdog. Stamp activity now (session just opened), then
        // poll every 10s — if there's been no user/agent activity for
        // IDLE_TIMEOUT_MS, end the call so the conversation doesn't sit "open"
        // forever (abandoned voice calls were the #1 stuck-open cause).
        lastActivityRef.current = Date.now();
        if (idleTimerRef.current) clearInterval(idleTimerRef.current);
        idleTimerRef.current = setInterval(() => {
          if (Date.now() - lastActivityRef.current >= IDLE_TIMEOUT_MS) {
            console.warn(`%c[voice] ⏱️ idle ${IDLE_TIMEOUT_MS / 1000}s — auto-ending call`, "color:#f59e0b");
            disconnectRef.current?.();
          }
        }, 10_000);
      } catch (err) {
        console.error("%c[voice] ✗ setup send failed", "color:#ef4444;font-weight:bold", err);
      }
    };

    ws.onmessage = async (e) => {
      let text: string;
      if (typeof e.data === "string") {
        text = e.data;
      } else if (e.data instanceof Blob) {
        text = await e.data.text();
      } else {
        return;
      }
      handleMessage(text);
    };
    ws.onerror = (ev) => {
      console.warn("[rihla-live] ws error", ev);
      void persistEvent({
        kind: "ws_diag",
        phase: "error",
        message: (ev as Event & { message?: string }).message ?? "(no message)",
        durationMs: Date.now() - wsOpenedAt,
      });
      // Guard: a stale ws (from a previous session) firing onerror after the
      // user already reopened a new call would otherwise flip the new
      // session into "error" state. Only react when this ws is still active.
      if (wsRef.current !== ws) {
        console.warn("[rihla-live] stale ws.onerror ignored — newer session is active");
        return;
      }
      connectInFlightRef.current = false;
      updateState("error");
    };
    ws.onclose = (ev) => {
      const durSec = ((Date.now() - wsOpenedAt) / 1000).toFixed(1);
      console.warn(`%c[voice] 🔌 WebSocket CLOSED — code=${ev.code} clean=${ev.wasClean} duration=${durSec}s reason="${ev.reason}"`, "color:#f59e0b");
      void persistEvent({
        kind: "ws_diag",
        phase: "close",
        code: ev.code,
        reason: ev.reason,
        wasClean: ev.wasClean,
        durationMs: Date.now() - wsOpenedAt,
      });
      // Guard: this onclose fires asynchronously. If the user re-opened the
      // call in the meantime (`connect()` already swapped wsRef to a NEW
      // socket), running updateState("idle") + stopMic() would kill the
      // brand-new session's mic — that's the "mic detected then closes
      // automatically, have to close + reopen widget" bug. Bail when this
      // close belongs to a superseded session.
      if (wsRef.current !== ws) {
        console.warn("%c[voice] ↩️ stale ws.onclose ignored — a newer session is active", "color:#f59e0b");
        return;
      }
      connectInFlightRef.current = false;
      updateState("idle");
      stopMic();
      console.log("%c[voice] ⏹️ SESSION ENDED — mic released, state=idle", "color:#ef4444;font-weight:bold");
    };
  }, [locale, voiceName, brandSlug, handleMessage, startMic, updateState]);

  // ─── Disconnect ───────────────────────────────────────────────────────────

  const stopMic = useCallback(() => {
    const hadStream = !!streamRef.current;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (hadStream) console.log("%c[voice] 🎙️ microphone RELEASED — tracks stopped", "color:#ef4444");
    try {
      workletRef.current?.disconnect();
    } catch { /* */ }
    workletRef.current = null;
    try {
      sourceRef.current?.disconnect();
    } catch { /* */ }
    sourceRef.current = null;
    // Keep micCtxRef ALIVE between sessions. Closing it forced the next
    // session to create a fresh AudioContext, which the browser then put
    // in a suspended state because connect() runs from a useEffect — by
    // the time we try to resume, the user's gesture has been consumed and
    // resume() silently fails. The mic appeared "live" in the UI but no
    // audio frames ever reached Gemini. Reusing the running context fixes
    // the second-reconnect mic dead-air bug.
  }, []);

  const disconnect = useCallback(() => {
    const wasLive = !!wsRef.current || !!streamRef.current;
    console.log(
      `%c[voice] ⏹️ SESSION CLOSING — disconnect() called (conv=${conversationIdRef.current ?? "n/a"}, wsOpen=${!!wsRef.current})`,
      "color:#ef4444;font-weight:bold"
    );
    if (idleTimerRef.current) { clearInterval(idleTimerRef.current); idleTimerRef.current = null; }
    // Mark the voice conversation closed (best effort).
    if (conversationIdRef.current) {
      // Include brandSlug so the server's stalled-booking recovery (in
      // /api/rihla/voice/event) can scope the lead push to the right brand.
      void persistEvent({ kind: "end", brandSlug });
    }
    wsRef.current?.close();
    wsRef.current = null;
    stopMic();
    playQueueRef.current = [];
    isPlayingRef.current = false;
    agentSpeakingRef.current = false;
    shouldDisconnectRef.current = false;
    connectInFlightRef.current = false;
    assistantBufferRef.current = "";
    userBufferRef.current = "";
    conversationIdRef.current = null;
    updateState("idle");
    if (wasLive) console.log("%c[voice] ⏹️ SESSION CLOSED — WebSocket closed, mic released, state=idle", "color:#ef4444;font-weight:bold");
  }, [persistEvent, stopMic, updateState]);

  disconnectRef.current = disconnect;

  // Send text through the live session (uses realtimeInput which works, unlike clientContent).
  // For voice, we also persist the typed text immediately as a user message so
  // it appears in the conversation transcript even though Gemini's input
  // transcription only covers audio.
  const sendText = useCallback((text: string) => {
    lastActivityRef.current = Date.now();
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ realtimeInput: { text } }));
    }
  }, []);

  /** Forward a typed-by-user line to listeners + persistence. Used by the
   *  CallView keyboard so the typed turn appears in the transcript. */
  const notifyUserText = useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;
    lastActivityRef.current = Date.now();
    callbacksRef.current.onTranscript?.(t, true);
    if (conversationIdRef.current) {
      void persistEvent({ kind: "user_text", text: t });
    }
  }, [persistEvent]);

  /** Mute / unmute the user's mic by toggling MediaStreamTrack.enabled.
   *  When muted, the audio worklet still runs but the captured samples are
   *  silent — Gemini receives zero amplitude, equivalent to no input. Cheap,
   *  reversible, and doesn't tear down the audio pipeline. */
  const setMuted = useCallback((muted: boolean) => {
    streamRef.current?.getAudioTracks().forEach((t) => { t.enabled = !muted; });
  }, []);

  // Tear down the session ONLY when the component truly unmounts. The deps
  // array MUST stay empty: depending on [disconnect] re-ran this cleanup
  // every time the disconnect callback was recreated (any re-render where
  // one of its deps shifted), firing disconnect() mid-call — that killed
  // the WebSocket and stopped the mic a fraction of a second after the
  // call started ("mic opens then closes" / "session won't stay open").
  // disconnectRef always points to the latest disconnect implementation.
  useEffect(() => {
    return () => {
      disconnectRef.current?.();
    };
  }, []);

  // Chrome auto-suspends AudioContexts when the tab is hidden, then leaves
  // them suspended on return — silently killing mic capture mid-call. Re-
  // resume both contexts on visibilitychange so the call survives a tab
  // switch. No-op if the contexts are already running or closed.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const mic = micCtxRef.current;
      const out = audioCtxRef.current;
      if (mic && mic.state === "suspended") {
        void mic.resume().catch(() => {});
      }
      if (out && out.state === "suspended") {
        void out.resume().catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  return {
    state,
    connect,
    disconnect,
    sendText,
    notifyUserText,
    setMuted,
    isConnected: state !== "idle" && state !== "error",
  };
}

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

const LIVE_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "configure_car",
        description: "Change the color, trim or angle of the car on the current page. MUST be called when user asks to change color (بدل اللون, mets en rouge).",
        parameters: {
          type: "OBJECT",
          properties: {
            slug: { type: "STRING", enum: ["c3-aircross", "c5-aircross", "berlingo"] },
            color: { type: "STRING" },
            trim: { type: "STRING" },
          },
        },
      },
      {
        name: "open_model",
        description: "Open a model detail page (بغيت نشوف, montre-moi).",
        parameters: {
          type: "OBJECT",
          properties: { slug: { type: "STRING", enum: ["c3-aircross", "c5-aircross", "berlingo"] } },
          required: ["slug"],
        },
      },
      {
        name: "start_reservation",
        description: "Open the reservation page to book this car.",
        parameters: {
          type: "OBJECT",
          properties: { slug: { type: "STRING" } },
          required: ["slug"],
        },
      },
      {
        name: "open_financing",
        description: "Open the financing advisor page or run a financing simulation.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "open_dealers",
        description: "Open the dealer locator page.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "calculate_financing",
        description: "Calculate monthly payment for a car. Call when user asks about price, mensualité, budget.",
        parameters: {
          type: "OBJECT",
          properties: {
            vehiclePrice: { type: "NUMBER" },
            downPayment: { type: "NUMBER" },
            termMonths: { type: "NUMBER" },
            annualRatePct: { type: "NUMBER" },
          },
          required: ["vehiclePrice"],
        },
      },
      {
        name: "show_model_image",
        description: "Display a photo of a specific model inline in the chat. Call when you recommend a model or the user asks to see one.",
        parameters: {
          type: "OBJECT",
          properties: {
            slug: { type: "STRING", description: "The model slug (e.g. 'wrangler', 'c3-aircross', '5008')." },
            caption: { type: "STRING", description: "Optional one-line caption shown under the image." },
          },
          required: ["slug"],
        },
      },
      {
        name: "show_model_video",
        description: "Display a video preview card for a model — opens YouTube search in a new tab. Use when user asks for a video, walk-around, or review.",
        parameters: {
          type: "OBJECT",
          properties: {
            slug: { type: "STRING", description: "The model slug." },
            caption: { type: "STRING", description: "Optional one-line caption." },
          },
          required: ["slug"],
        },
      },
      {
        name: "open_brand_page",
        description: "Open the official brand-site page for a model in a new browser tab. Use when the user wants to see more details, specs, or configure on the official site.",
        parameters: {
          type: "OBJECT",
          properties: {
            slug: { type: "STRING", description: "The model slug." },
          },
          required: ["slug"],
        },
      },
      {
        name: "book_test_drive",
        description: "Book a TEST DRIVE for a qualified lead. MANDATORY : you MUST call this tool the moment the customer says 'oui' / 'yes' / any affirmative TO THE CNDP CONSENT QUESTION (loi 09-08). NEVER respond with confirmation text alone ('Parfait, je transmets votre demande...') without ALSO calling this tool in the SAME turn — that would silently drop the lead, which is the #1 voice bug clients have flagged. Fill firstName, phone, email (if provided), city, preferredSlot, showroomName from the conversation history. CNDP consent is implicit in the customer's just-given 'oui'.",
        parameters: {
          type: "OBJECT",
          properties: {
            slug: { type: "STRING" },
            firstName: { type: "STRING" },
            phone: { type: "STRING" },
            email: { type: "STRING", description: "Customer email — optional. Ask once after phone; accept if customer prefers not to share." },
            city: { type: "STRING" },
            preferredSlot: { type: "STRING" },
            showroomName: { type: "STRING", description: "The exact showroom the customer chose from find_showrooms (e.g. 'Peugeot Riyadh — King Fahd Rd'). Verbatim." },
          },
          required: ["slug", "firstName", "phone"],
        },
      },
      {
        name: "book_showroom_visit",
        description: "Schedule a SHOWROOM VISIT (the user wants to come see the cars in person, not test-drive). MANDATORY : call this the moment the customer says 'oui' to the CNDP question. NEVER emit confirmation text without ALSO calling this tool in the same turn — that drops the lead silently.",
        parameters: {
          type: "OBJECT",
          properties: {
            slug: { type: "STRING" },
            firstName: { type: "STRING" },
            phone: { type: "STRING" },
            email: { type: "STRING", description: "Customer email — optional. Ask once after phone." },
            city: { type: "STRING" },
            preferredSlot: { type: "STRING" },
            showroomName: { type: "STRING", description: "The exact showroom the customer chose. Verbatim." },
          },
          required: ["firstName", "phone"],
        },
      },
      {
        name: "find_showrooms",
        description: "List nearby showrooms / dealers. CALL THIS whenever the user names a city ('I'm in Riyadh', 'Casablanca', 'Jeddah') or asks where to find the cars / book a visit / find a service centre. Renders a card list with names, addresses, phones, hours. After calling, briefly summarize ('I found 3 in Riyadh — would you like to visit one?').",
        parameters: {
          type: "OBJECT",
          properties: {
            city: { type: "STRING", description: "City name as the user said it. Empty/undefined to list all showrooms." },
          },
        },
      },
      {
        name: "end_call",
        description: "END THE CALL — call this IMMEDIATELY after your closing line whenever the user signals they're done. Triggers (any language, partial match): 'bye', 'goodbye', 'thanks', 'thank you', 'au revoir', 'merci', 'à bientôt', 'bonne journée', 'salut', 'شكرا', 'شكراً', 'بسلامة', 'في أمان الله', 'مع السلامة', 'يالله', 'يالاه', 'صافي', 'خلاص', 'تمام', 'تسلم', 'الله يعطيك العافية'. ALSO call after a successful book_test_drive + farewell. Never continue after a farewell — end_call is the only valid response.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "request_input",
        description: "MANDATORY in voice — open the on-screen keyboard whenever you ask the customer to type a sensitive field (name, phone, email, VIN). Voice dictation is refused for these 4 fields. Call on the SAME turn as your text instruction ('Tapez votre prénom, …'). For VIN, this also surfaces the carte-grise camera + upload buttons.",
        parameters: {
          type: "OBJECT",
          properties: {
            field: { type: "STRING", enum: ["name", "phone", "email", "vin"] },
          },
          required: ["field"],
        },
      },
      // ─── APV (after-sales) — Jeep widget only. Never call for other brands. ───
      {
        name: "lookup_vin",
        description: "APV ONLY. Look up a customer by VIN to pre-fill the form. Call as soon as the customer says their VIN (17 alphanumeric chars, no I/O/Q).",
        parameters: {
          type: "OBJECT",
          properties: { vin: { type: "STRING" } },
          required: ["vin"],
        },
      },
      {
        name: "book_service_appointment",
        description: "APV ONLY. MANDATORY : call this tool the moment the customer says 'oui' / 'yes' / any affirmative to the CNDP question. NEVER emit confirmation text ('Parfait, je transmets...') without ALSO calling this tool in the SAME turn — that drops the lead silently. Set cndpConsent=true (the customer just gave it).",
        parameters: {
          type: "OBJECT",
          properties: {
            fullName: { type: "STRING" },
            phone: { type: "STRING" },
            email: { type: "STRING" },
            vehicleBrand: { type: "STRING" },
            vehicleModel: { type: "STRING" },
            vin: { type: "STRING" },
            interventionType: { type: "STRING", enum: ["service_rapide", "mechanical", "bodywork"] },
            city: { type: "STRING" },
            preferredDate: { type: "STRING" },
            preferredSlot: { type: "STRING", enum: ["morning", "afternoon"] },
            comment: { type: "STRING" },
            cndpConsent: { type: "BOOLEAN" },
          },
          required: ["fullName", "phone", "email", "vehicleBrand", "vehicleModel", "vin", "interventionType", "city", "preferredDate", "preferredSlot", "cndpConsent"],
        },
      },
      {
        name: "submit_complaint",
        description: "APV ONLY. MANDATORY : call this the moment the customer says 'oui' to the CNDP question. NEVER emit confirmation text without ALSO calling this tool in the same turn — that drops the complaint silently. Set cndpConsent=true.",
        parameters: {
          type: "OBJECT",
          properties: {
            fullName: { type: "STRING" },
            phone: { type: "STRING" },
            email: { type: "STRING" },
            vehicleBrand: { type: "STRING" },
            vehicleModel: { type: "STRING" },
            vin: { type: "STRING" },
            interventionType: { type: "STRING", enum: ["service_rapide", "mechanical", "bodywork"] },
            site: { type: "STRING" },
            serviceDate: { type: "STRING" },
            reason: { type: "STRING" },
            attachmentUrl: { type: "STRING" },
            cndpConsent: { type: "BOOLEAN" },
          },
          required: ["fullName", "phone", "email", "vehicleBrand", "vehicleModel", "vin", "interventionType", "site", "reason", "cndpConsent"],
        },
      },
    ],
  },
];

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useRihlaLive(
  locale: string,
  voiceName: string = "Zephyr",
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
  const shouldDisconnectRef = useRef(false);
  const disconnectRef = useRef<(() => void) | null>(null);
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
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;

      const ctx = new AudioContext({ sampleRate: 16000 });
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
          console.log("[rihla-live] mic capture LIVE — first audio frame fired");
        }
        if (ws.readyState !== WebSocket.OPEN) return;
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

  const connect = useCallback(() => {
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_API_KEY;
    if (!apiKey) {
      console.error("[rihla-live] NEXT_PUBLIC_GOOGLE_API_KEY not set");
      updateState("error");
      return;
    }

    // Defensive resets — guard against any stale state from a previous
    // session leaking into the new one. Without this, the first connection
    // after the user navigates back into voice mode could see a leftover
    // shouldDisconnectRef = true (e.g., from a prior end_call where the
    // backstop fired) and silently disconnect mid-greeting.
    shouldDisconnectRef.current = false;
    isPlayingRef.current = false;
    playQueueRef.current = [];
    userBufferRef.current = "";
    assistantBufferRef.current = "";

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
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;

    // Kick off prompt + voice-session fetches in PARALLEL with the WS open
    // and with mic permission. Previously these were sequential inside
    // ws.onopen, costing ~2-4s before the agent could hear the user.
    const promptParams = new URLSearchParams({
      locale,
      voice: "1",
      ...(brandSlug ? { brand: brandSlug } : {}),
    });
    const promptPromise = fetch(`/api/rihla/system-prompt?${promptParams}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null) as Promise<{ systemPrompt: string; voiceName?: string; locale?: string } | null>;

    const voiceStartPromise = brandSlug
      ? fetch("/api/rihla/voice/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brandSlug, locale }),
        })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null) as Promise<{ id?: string } | null>
      : Promise.resolve(null);

    // Request mic permission and warm the audio context immediately.
    // (The processor sends nothing until the WS is open — see startMic.)
    const ws = new WebSocket(url);
    wsRef.current = ws;
    // Track session duration so unexpected closes ("user said 3 words then it
    // died") can be distinguished from "10 minute call, then end_call".
    const wsOpenedAt = Date.now();
    const micPromise = startMic(ws).catch((err) => {
      console.warn("[rihla-live] mic start failed", err);
    });

    ws.onopen = async () => {
      void persistEvent({ kind: "ws_diag", phase: "open" });
      const [promptResult, voiceResult] = await Promise.all([promptPromise, voiceStartPromise]);
      const systemPrompt = promptResult?.systemPrompt ?? "";
      const resolvedVoice = promptResult?.voiceName ?? voiceName;
      if (voiceResult?.id) conversationIdRef.current = voiceResult.id;
      // Wait for mic to be ready so the very first setup ack -> first audio
      // chunks the user produces aren't dropped.
      await micPromise;

      ws.send(
        JSON.stringify({
          setup: {
            model: "models/gemini-3.1-flash-live-preview",
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: resolvedVoice } },
              },
            },
            // Transcribe both sides so we can persist them.
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            systemInstruction: { parts: [{ text: systemPrompt }] },
            tools: LIVE_TOOLS,
          },
        })
      );
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
      updateState("error");
    };
    ws.onclose = (ev) => {
      console.warn(`[rihla-live] ws closed code=${ev.code} reason="${ev.reason}" wasClean=${ev.wasClean}`);
      void persistEvent({
        kind: "ws_diag",
        phase: "close",
        code: ev.code,
        reason: ev.reason,
        wasClean: ev.wasClean,
        durationMs: Date.now() - wsOpenedAt,
      });
      updateState("idle");
      stopMic();
    };
  }, [locale, voiceName, brandSlug, handleMessage, startMic, updateState]);

  // ─── Disconnect ───────────────────────────────────────────────────────────

  const stopMic = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    try {
      workletRef.current?.disconnect();
    } catch { /* */ }
    // Close the input AudioContext so the next session creates a fresh one
    // in a known state — prevents leaking suspended contexts across sessions.
    if (micCtxRef.current && micCtxRef.current.state !== "closed") {
      void micCtxRef.current.close().catch(() => {});
    }
    micCtxRef.current = null;
  }, []);

  const disconnect = useCallback(() => {
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
    shouldDisconnectRef.current = false;
    assistantBufferRef.current = "";
    userBufferRef.current = "";
    conversationIdRef.current = null;
    updateState("idle");
  }, [persistEvent, stopMic, updateState]);

  disconnectRef.current = disconnect;

  // Send text through the live session (uses realtimeInput which works, unlike clientContent).
  // For voice, we also persist the typed text immediately as a user message so
  // it appears in the conversation transcript even though Gemini's input
  // transcription only covers audio.
  const sendText = useCallback((text: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ realtimeInput: { text } }));
    }
  }, []);

  /** Forward a typed-by-user line to listeners + persistence. Used by the
   *  CallView keyboard so the typed turn appears in the transcript. */
  const notifyUserText = useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;
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

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

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

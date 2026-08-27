"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Image from "next/image";
import { useTranslations, useLocale } from "next-intl";
import { useRouter, usePathname } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { SendHorizonal, X, PhoneCall, Sparkles, Globe } from "lucide-react";
import { onRihlaOpen } from "@/lib/rihla-bus";
import { dispatchRihlaTool, onScrollTo, onEndCall } from "@/lib/rihla-actions";
import { useRihlaLive, type LiveToolCall } from "@/lib/use-rihla-live";
import { LanguagePicker, getLangConfig, type VoiceLang } from "@/components/rihla/LanguagePicker";
import { CallView } from "@/components/rihla/CallView";

type Msg = { role: "user" | "assistant"; text: string; tools?: { name: string; input: Record<string, unknown> }[] };
type StreamEvent = { type: "text"; text: string } | { type: "tool"; name: string; input: Record<string, unknown> } | { type: "done" };

export function RihlaBubble() {
  const t = useTranslations("rihla");
  const rawLocale = useLocale();
  const locale = (rawLocale === "ar" || rawLocale === "en" ? rawLocale : "fr") as "fr" | "ar" | "en";
  const router = useRouter();
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  useEffect(() => { pathnameRef.current = pathname; }, [pathname]);

  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const callTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [voiceLang, setVoiceLang] = useState<VoiceLang | null>(() => {
    if (typeof window !== "undefined") return localStorage.getItem("rihla-lang") as VoiceLang | null;
    return null;
  });
  const langConfig = voiceLang ? getLangConfig(voiceLang) : null;
  const apiLocale = voiceLang === "darija" ? "ar" : voiceLang ?? locale;

  const [messages, setMessages] = useState<Msg[]>(() => [
    { role: "assistant", text: langConfig?.greeting ?? t("greeting") },
  ]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // ─── Gemini Live ─────────────────────────────────────────
  const handleLiveToolCall = useCallback((call: LiveToolCall): string => {
    const result = dispatchRihlaTool(
      { name: call.name, input: call.args },
      { locale, router, currentPath: pathnameRef.current ?? "" }
    );
    if (call.name === "configure_car") {
      setTimeout(() => {
        document.querySelector<HTMLElement>('[data-rihla-section="configurator"]')
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 300);
    }
    setMessages((m) => {
      const copy = [...m];
      const last = copy[copy.length - 1];
      if (last?.role === "assistant") {
        copy[copy.length - 1] = { ...last, tools: [...(last.tools ?? []), { name: call.name, input: call.args }] };
      }
      return copy;
    });
    return result;
  }, [locale, router]);

  const handleLiveTranscript = useCallback((text: string, fromUser: boolean) => {
    if (fromUser) {
      setMessages((m) => [...m, { role: "user", text }]);
    } else {
      setMessages((m) => {
        const copy = [...m];
        const last = copy[copy.length - 1];
        if (last?.role === "assistant") {
          copy[copy.length - 1] = { ...last, text: last.text + text };
        } else {
          copy.push({ role: "assistant", text });
        }
        return copy;
      });
    }
  }, []);

  const live = useRihlaLive(voiceLang ?? locale, "Aoede", {
    onToolCall: handleLiveToolCall,
    onTranscript: handleLiveTranscript,
  });

  // Call duration timer
  useEffect(() => {
    if (live.isConnected) {
      setCallDuration(0);
      callTimerRef.current = setInterval(() => setCallDuration((d) => d + 1), 1000);
    } else {
      if (callTimerRef.current) clearInterval(callTimerRef.current);
      callTimerRef.current = null;
    }
    return () => { if (callTimerRef.current) clearInterval(callTimerRef.current); };
  }, [live.isConnected]);

  const startCall = useCallback(() => {
    if (!live.isConnected) {
      setMessages((m) => [...m, { role: "assistant", text: "" }]);
      live.connect();
    }
  }, [live]);

  const endCall = useCallback(() => {
    live.disconnect();
  }, [live]);

  // ─── Scroll + events ──────────────────────────────────
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, open]);

  useEffect(() => {
    return onScrollTo((section) => {
      if (!section || typeof document === "undefined") return;
      const el = document.querySelector<HTMLElement>(`[data-rihla-section="${section}"]`) ?? document.getElementById(section);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, []);

  // end_call from the text chat → close the panel after a short delay so the
  // farewell message stays visible. For voice, the hook handles disconnect itself.
  useEffect(() => {
    return onEndCall(() => {
      if (live.isConnected) return;
      setTimeout(() => setOpen(false), 2500);
    });
  }, [live.isConnected]);

  const handleLangSelect = useCallback((lang: VoiceLang) => {
    setVoiceLang(lang);
    localStorage.setItem("rihla-lang", lang);
    setMessages([{ role: "assistant", text: getLangConfig(lang).greeting }]);
  }, []);

  // ─── Text chat (POST) ─────────────────────────────────
  const sendTextMessage = useCallback(async (text: string) => {
    const current = messagesRef.current;
    const next: Msg[] = [...current, { role: "user", text }, { role: "assistant", text: "", tools: [] }];
    setMessages(next);
    setIsStreaming(true);

    if (live.isConnected) {
      live.sendText(text);
      setIsStreaming(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/rihla/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locale: apiLocale,
          voice: false,
          messages: next.slice(0, -1).map((m) => ({ role: m.role, content: m.text })),
          pageContext: { path: pathname ?? "/" },
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let textAcc = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: StreamEvent;
          try { ev = JSON.parse(line.trim()); } catch { continue; }
          if (ev.type === "text") {
            textAcc += ev.text;
            setMessages((m) => { const copy = [...m]; const last = copy[copy.length - 1]; if (last?.role === "assistant") copy[copy.length - 1] = { ...last, text: textAcc }; return copy; });
          } else if (ev.type === "tool") {
            dispatchRihlaTool({ name: ev.name, input: ev.input }, { locale, router, currentPath: pathname ?? "" });
            if (ev.name === "configure_car") setTimeout(() => document.querySelector<HTMLElement>('[data-rihla-section="configurator"]')?.scrollIntoView({ behavior: "smooth", block: "center" }), 300);
            setMessages((m) => { const copy = [...m]; const last = copy[copy.length - 1]; if (last?.role === "assistant") copy[copy.length - 1] = { ...last, tools: [...(last.tools ?? []), { name: ev.name, input: ev.input }] }; return copy; });
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setMessages((m) => { const copy = [...m]; const last = copy[copy.length - 1]; if (last?.role === "assistant" && !last.text) copy[copy.length - 1] = { ...last, text: "Petit souci technique." }; return copy; });
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [apiLocale, locale, live, pathname, router]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    void sendTextMessage(text);
  }, [input, isStreaming, sendTextMessage]);

  useEffect(() => {
    return onRihlaOpen(({ seedMessage, autoSend, voice }) => {
      setOpen(true);
      if (voice && voiceLang && !live.isConnected) setTimeout(() => startCall(), 200);
      if (seedMessage) {
        if (autoSend) void sendTextMessage(seedMessage);
        else setInput(seedMessage);
      }
    });
  }, [live, sendTextMessage, startCall, voiceLang]);

  // ─── Render ────────────────────────────────────────────

  return (
    <>
      {/* FAB */}
      <AnimatePresence>
        {!open && (
          <motion.button
            key="fab"
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            type="button"
            onClick={() => setOpen(true)}
            whileTap={{ scale: 0.92 }}
            whileHover={{ scale: 1.05 }}
            className="fixed bottom-5 end-5 z-[60] overflow-hidden rounded-full shadow-[0_8px_36px_-6px_rgba(0,0,0,0.35)]"
          >
            <div className="relative h-14 w-14">
              <Image src="/brand/rihla-avatar.jpg" alt="Rihla" fill className="object-cover" sizes="56px" />
              <div className="absolute -end-0.5 -top-0.5 h-3.5 w-3.5 rounded-full border-2 border-white bg-emerald-400" />
            </div>
          </motion.button>
        )}
      </AnimatePresence>

      {/* Panel */}
      <AnimatePresence>
        {open && (
          <motion.div
            key="panel"
            initial={{ opacity: 0, y: 20, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.96 }}
            transition={{ duration: 0.25, ease: [0.22, 0.68, 0, 1] }}
            role="dialog"
            aria-label="Rihla"
            className="fixed inset-x-3 bottom-3 z-[60] flex h-[min(700px,calc(100dvh-24px))] flex-col overflow-hidden rounded-[24px] bg-white shadow-[0_24px_80px_-16px_rgba(0,0,0,0.25),0_0_0_1px_rgba(0,0,0,0.06)] sm:inset-x-auto sm:bottom-5 sm:end-4 sm:h-[min(700px,calc(100dvh-40px))] sm:w-[min(400px,calc(100vw-32px))]"
          >
            {/* If in a live call → show call view */}
            {live.isConnected ? (
              <CallView state={live.state} onHangUp={endCall} duration={callDuration} />
            ) : (
              <>
                {/* Header */}
                <header className="flex items-center gap-3 border-b border-black/[0.06] px-4 py-3">
                  <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-full">
                    <Image src="/brand/rihla-avatar.jpg" alt="Rihla" fill className="object-cover" sizes="40px" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold text-[#121214]">Rihla</div>
                    <div className="flex items-center gap-1.5 text-[11px] text-black/40">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                      En ligne
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {voiceLang && (
                      <button
                        type="button"
                        onClick={() => { setVoiceLang(null); localStorage.removeItem("rihla-lang"); }}
                        className="flex items-center gap-1 rounded-full bg-black/[0.04] px-2.5 py-1 text-[10px] text-black/40 transition hover:bg-black/[0.08]"
                      >
                        <Globe size={10} /> {langConfig?.flag}
                      </button>
                    )}
                    <button type="button" onClick={() => setOpen(false)} className="flex h-8 w-8 items-center justify-center rounded-full bg-black/[0.04] text-black/40 transition hover:bg-black/[0.08]">
                      <X size={15} />
                    </button>
                  </div>
                </header>

                {/* Body */}
                {!voiceLang ? (
                  <div className="flex-1 bg-[#fafafa]">
                    <LanguagePicker onSelect={handleLangSelect} />
                  </div>
                ) : (
                  <>
                    <div ref={scrollRef} className="flex-1 overflow-y-auto bg-[#fafafa] px-4 py-4">
                      <div className="space-y-4">
                        {messages.map((m, i) => (
                          <motion.div key={i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className={m.role === "user" ? "flex justify-end" : ""}>
                            {m.role === "assistant" ? (
                              <div className="flex gap-2.5">
                                <div className="relative mt-0.5 h-7 w-7 shrink-0 overflow-hidden rounded-full">
                                  <Image src="/brand/rihla-avatar.jpg" alt="" fill className="object-cover" sizes="28px" />
                                </div>
                                <div className="min-w-0 max-w-[85%]">
                                  <div className="rounded-2xl rounded-tl-md bg-white px-3.5 py-2.5 text-[13px] leading-relaxed text-[#121214] shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
                                    {m.text || (isStreaming && i === messages.length - 1 ? <TypingDots /> : "")}
                                  </div>
                                  {m.tools && m.tools.length > 0 && (
                                    <div className="mt-1 flex flex-wrap gap-1">
                                      {m.tools.map((tc, j) => (
                                        <span key={j} className="inline-flex items-center gap-0.5 rounded-md bg-black/[0.04] px-1.5 py-0.5 text-[9px] text-black/35">
                                          <Sparkles size={8} /> {tc.name.replace(/_/g, " ")}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </div>
                            ) : (
                              <div className="max-w-[85%] rounded-2xl rounded-tr-md bg-[#121214] px-3.5 py-2.5 text-[13px] leading-relaxed text-white">
                                {m.text}
                              </div>
                            )}
                          </motion.div>
                        ))}
                      </div>
                    </div>

                    {/* Input + call button */}
                    <div className="border-t border-black/[0.06] bg-white px-3 pb-3 pt-2">
                      <div className="flex items-end gap-1.5 rounded-2xl border border-black/[0.08] bg-[#fafafa] p-1.5">
                        <button
                          type="button"
                          onClick={startCall}
                          className="mb-px flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-emerald-500 text-white transition hover:bg-emerald-600"
                          title="Appeler Rihla"
                        >
                          <PhoneCall size={14} />
                        </button>
                        <textarea
                          value={input}
                          onChange={(e) => setInput(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                          placeholder={langConfig?.label ? `Message en ${langConfig.label}…` : "Écrivez ici…"}
                          rows={1}
                          disabled={isStreaming}
                          className="block max-h-[96px] min-h-[32px] flex-1 resize-none overflow-y-auto bg-transparent px-2 py-1.5 text-[13px] leading-snug text-[#121214] outline-none placeholder:text-black/30 disabled:opacity-40"
                          style={{ fieldSizing: "content" } as React.CSSProperties}
                        />
                        <button
                          type="button"
                          onClick={handleSend}
                          disabled={isStreaming || !input.trim()}
                          className="mb-px flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[#121214] text-white transition hover:bg-[#2a2a2e] disabled:opacity-20"
                        >
                          <SendHorizonal size={14} strokeWidth={2} />
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-[3px]">
      {[0, 1, 2].map((i) => (
        <motion.span key={i} className="inline-block h-[5px] w-[5px] rounded-full bg-black/25" animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1, delay: i * 0.15, repeat: Infinity }} />
      ))}
    </span>
  );
}

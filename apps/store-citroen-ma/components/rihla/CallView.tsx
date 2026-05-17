"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import Image from "next/image";
import { motion, AnimatePresence } from "framer-motion";
import { PhoneOff, Mic, MicOff, Keyboard, SendHorizonal, X, ExternalLink, MapPin, Star, Check } from "lucide-react";
import type { LiveState } from "@/lib/use-rihla-live";
import type { ImageCardPayload, ShowroomsPayload } from "@/lib/rihla-actions";
import VinScanButtons from "./VinScanButtons";

type CallViewProps = {
  state: LiveState;
  onHangUp: () => void;
  duration: number;
  accent?: string;
  brandName?: string;
  /** Persona name shown in the header ("NARA", "Rihla", …). Defaults to "Rihla". */
  agentName?: string;
  /** When provided, exposes a "type" affordance the user can tap to send text mid-call. */
  onSendText?: (text: string) => void;
  /** Locale for the typing affordance label. */
  locale?: "fr" | "ar" | "en" | "darija" | null;
  /** When the agent calls show_model_image during a voice call, render the image overlay. */
  currentImage?: ImageCardPayload | null;
  /** When the agent calls find_showrooms during a voice call, render a compact
   *  list overlay so the customer can SEE the maison options + tap to choose
   *  one (without the cards they only hear "we have 3 maisons" and have to
   *  guess the names back via voice). */
  currentShowrooms?: ShowroomsPayload | null;
  /** Click handler for the "Choisir" button on each voice-mode showroom item.
   *  Sends the maison name back as a typed user turn (with [MAISON_SELECTED]
   *  marker) so the agent can move to the date question. */
  onShowroomChoice?: (name: string) => void;
  /** When the agent asks the user to type something, this gets bumped — opens
   *  the inline keyboard automatically, optional placeholder hint, and a
   *  field kind so VIN-specific affordances (camera + upload OCR) can render. */
  typeRequest?: {
    id: number;
    placeholder?: string;
    kind?: "vin" | "email" | "phone" | "name";
  } | null;
};

const TYPE_LABELS: Record<NonNullable<CallViewProps["locale"]>, { tap: string; placeholder: string; sent: string }> = {
  fr: { tap: "Écrire", placeholder: "Tapez votre nom, numéro…", sent: "Envoyé" },
  darija: { tap: "كتب", placeholder: "كتب الاسم، الرقم…", sent: "تم الإرسال" },
  ar: { tap: "اكتب", placeholder: "اكتب الاسم، الرقم…", sent: "تم الإرسال" },
  en: { tap: "Type", placeholder: "Type your name, number…", sent: "Sent" },
};

function viewSiteLabel(locale: CallViewProps["locale"]): string {
  if (locale === "ar" || locale === "darija") return "زر الموقع الرسمي";
  if (locale === "en") return "View on official site";
  return "Voir sur le site officiel";
}

function statusText(state: LiveState, locale: CallViewProps["locale"], agentName: string): string {
  // Arabic display form for the speaking line — Latin agent names like "NARA"
  // stay in Latin (read out as letters), legacy "Rihla" maps to "رحلة".
  const arName = agentName === "Rihla" ? "رحلة" : agentName;
  if (locale === "en") {
    if (state === "speaking") return `${agentName} is speaking…`;
    if (state === "listening") return "Listening…";
    if (state === "connecting") return "Connecting…";
    return "On call";
  }
  if (locale === "ar" || locale === "darija") {
    if (state === "speaking") return `${arName} تتحدث…`;
    if (state === "listening") return "تفضل…";
    if (state === "connecting") return "جاري الاتصال…";
    return "في المكالمة";
  }
  if (state === "speaking") return `${agentName} parle…`;
  if (state === "listening") return "À vous…";
  if (state === "connecting") return "Connexion…";
  return "En appel";
}

function advisorLabel(locale: CallViewProps["locale"]): string {
  if (locale === "ar" || locale === "darija") return "مستشارة";
  if (locale === "en") return "Advisor";
  return "Conseillère";
}

function showroomHeaderLabel(count: number, city: string | undefined, locale: CallViewProps["locale"]): string {
  const cityPart = city ? ` · ${city}` : "";
  if (locale === "darija") return count === 1 ? `la maison${cityPart}` : `${count} maisons${cityPart}`;
  if (locale === "ar") {
    if (count === 1) return `معرض واحد${cityPart}`;
    if (count === 2) return `معرضان${cityPart}`;
    return `${count} معارض${cityPart}`;
  }
  if (locale === "en") return `${count} showroom${count > 1 ? "s" : ""}${cityPart}`;
  return `${count} maison${count > 1 ? "s" : ""}${cityPart}`;
}

function chooseLabelVoice(locale: CallViewProps["locale"]): string {
  if (locale === "ar" || locale === "darija") return "اختار";
  if (locale === "en") return "Choose";
  return "Choisir";
}

function chosenLabelVoice(locale: CallViewProps["locale"]): string {
  if (locale === "ar" || locale === "darija") return "تم الاختيار";
  if (locale === "en") return "Selected";
  return "Sélectionné";
}

export function CallView({
  state,
  onHangUp,
  duration,
  accent = "#60a5fa",
  brandName = "Rihla",
  agentName = "Rihla",
  onSendText,
  locale,
  currentImage,
  currentShowrooms,
  onShowroomChoice,
  typeRequest,
}: CallViewProps) {
  const [selectedShowroomId, setSelectedShowroomId] = useState<string | null>(null);
  // Reset the selection lock whenever a new showroom list arrives — e.g. the
  // customer asked for a different city.
  useEffect(() => {
    setSelectedShowroomId(null);
  }, [currentShowrooms?.city, currentShowrooms?.items?.length]);

  // When the showroom list is on screen, hide the model image so the layout
  // doesn't bury the customer's choice under stacked cards. Re-shows once the
  // showrooms clear. Same logic used to keep the avatar size + image overlay
  // gated on a single computed flag.
  const showroomsVisible = !!currentShowrooms?.items && currentShowrooms.items.length > 0;
  const showCarImage = !!currentImage?.imageUrl && !showroomsVisible;
  const minutes = Math.floor(duration / 60);
  const seconds = duration % 60;
  const timeStr = `${minutes}:${seconds.toString().padStart(2, "0")}`;

  const isActive = state === "listening" || state === "speaking" || state === "connected";
  const statusLabel = statusText(state, locale, agentName);

  const dotColor = state === "listening" ? "#22c55e" : state === "speaking" ? accent : "#a3e635";

  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  const [sentFlash, setSentFlash] = useState(false);
  const [autoPlaceholder, setAutoPlaceholder] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const labels = TYPE_LABELS[locale ?? "fr"];
  const isRtl = locale === "ar" || locale === "darija";
  const placeholder = autoPlaceholder ?? labels.placeholder;

  useEffect(() => {
    if (typing) inputRef.current?.focus();
  }, [typing]);

  // Auto-open the keyboard whenever the agent asks the user to type something
  // (name, phone). The bubble bumps `typeRequest.id` each time the assistant
  // turn includes a "type" trigger word.
  useEffect(() => {
    if (!typeRequest) return;
    setAutoPlaceholder(typeRequest.placeholder ?? null);
    setTyping(true);
  }, [typeRequest]);

  const send = useCallback(() => {
    const t = text.trim();
    if (!t || !onSendText) return;
    onSendText(t);
    setText("");
    setAutoPlaceholder(null);
    setSentFlash(true);
    setTimeout(() => setSentFlash(false), 1100);
  }, [text, onSendText]);

  return (
    <div
      className="relative flex h-full flex-col items-center justify-between overflow-hidden px-6 py-8"
      style={{
        background: `radial-gradient(120% 80% at 50% 0%, ${accent}22 0%, #0e0e10 60%, #0a0a0c 100%)`,
      }}
      dir={isRtl ? "rtl" : "ltr"}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.06] mix-blend-overlay"
        style={{
          backgroundImage: "radial-gradient(rgba(255,255,255,0.6) 1px, transparent 1px)",
          backgroundSize: "3px 3px",
        }}
      />

      {/* Top: status */}
      <div className="relative shrink-0 text-center">
        <div className="flex items-center justify-center gap-2 text-[11px] uppercase tracking-[0.22em] text-white/50">
          <motion.span
            className="h-2 w-2 rounded-full"
            style={{ background: dotColor, boxShadow: `0 0 12px ${dotColor}` }}
            animate={isActive ? { scale: [1, 1.45, 1] } : {}}
            transition={{ duration: 1.2, repeat: Infinity }}
          />
          {statusLabel}
        </div>
        <div className="mt-2 font-mono text-base tabular-nums text-white/55">{timeStr}</div>
      </div>

      {/* Middle: avatar + (when present) image card, vertically centered.
          Putting them in normal flex flow lets the avatar shrink to make room
          for the image — the previous absolute positioning floated the image
          on top of the avatar on small viewports. */}
      <div className="relative flex w-full min-h-0 flex-1 flex-col items-center justify-center gap-4">

      {/* Center: avatar */}
      <div className="relative">
        <div
          aria-hidden
          className="absolute -inset-12 rounded-full blur-3xl"
          style={{ background: `${accent}30` }}
        />

        <AnimatePresence>
          {state === "speaking" && (
            <>
              {[1, 2, 3, 4].map((i) => (
                <motion.div
                  key={i}
                  className="absolute inset-0 rounded-full"
                  style={{ border: `1.5px solid ${accent}` }}
                  initial={{ scale: 1, opacity: 0.55 }}
                  animate={{ scale: 1 + i * 0.32, opacity: 0 }}
                  transition={{ duration: 1.8, delay: i * 0.28, repeat: Infinity, ease: "easeOut" }}
                />
              ))}
            </>
          )}
          {state === "listening" && (
            <>
              {[1, 2, 3].map((i) => (
                <motion.div
                  key={`l-${i}`}
                  className="absolute inset-0 rounded-full border border-emerald-400/35"
                  initial={{ scale: 1, opacity: 0.4 }}
                  animate={{ scale: 1 + i * 0.2, opacity: 0 }}
                  transition={{ duration: 2.2, delay: i * 0.35, repeat: Infinity, ease: "easeOut" }}
                />
              ))}
            </>
          )}
        </AnimatePresence>

        <motion.div
          className={`relative overflow-hidden rounded-full ring-4 ring-white/10 transition-all duration-300 ${
            showCarImage ? "h-28 w-28" : "h-40 w-40"
          }`}
          style={{
            boxShadow: `0 0 80px -10px ${accent}66, 0 0 0 1px rgba(255,255,255,0.1)`,
          }}
          animate={
            state === "speaking"
              ? { scale: [1, 1.045, 1] }
              : state === "listening"
              ? { scale: [1, 1.02, 1] }
              : { scale: 1 }
          }
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
        >
          <Image
            src="/brand/rihla-avatar.jpg"
            alt="Rihla"
            fill
            className="object-cover"
            sizes="176px"
            priority
          />
          <div
            className="absolute inset-0 rounded-full mix-blend-soft-light"
            style={{
              background:
                state === "speaking"
                  ? `radial-gradient(circle, ${accent}40 0%, transparent 70%)`
                  : state === "listening"
                  ? "radial-gradient(circle, rgba(34,197,94,0.32) 0%, transparent 70%)"
                  : "none",
            }}
          />
        </motion.div>

        <div className={`relative text-center ${showCarImage ? "mt-3" : "mt-5"}`}>
          <div className={`font-semibold tracking-tight text-white ${showCarImage ? "text-base" : "text-xl"}`}>{agentName}</div>
          <div className={`mt-0.5 text-white/45 ${showCarImage ? "text-[11px]" : "text-[12px]"}`}>{advisorLabel(locale)} · {brandName}</div>

          {/* Equalizer is positioned ABSOLUTELY below the name so it doesn't
              push the image card down when the agent starts speaking. */}
          <AnimatePresence>
            {state === "speaking" && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="pointer-events-none absolute inset-x-0 -bottom-7 flex items-end justify-center gap-1"
              >
                {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                  <motion.span
                    key={i}
                    className="block w-[3px] rounded-full"
                    style={{ background: accent }}
                    animate={{ height: [6, 16 + (i % 3) * 6, 8, 14, 6] }}
                    transition={{ duration: 0.8, delay: i * 0.05, repeat: Infinity }}
                  />
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Inline car image — flex sibling of the avatar so they never
          overlap on small viewports. Avatar shrinks above when this is
          present so the layout self-balances. */}
      <AnimatePresence>
        {showCarImage && currentImage?.imageUrl && (
          <motion.div
            key={currentImage.imageUrl}
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.95 }}
            transition={{ duration: 0.32, ease: [0.22, 0.68, 0, 1] }}
            className="z-20 w-[min(340px,calc(100vw-48px))] overflow-hidden rounded-2xl bg-white/[0.04]"
            style={{ boxShadow: `0 18px 42px -12px ${accent}55, 0 0 0 1px rgba(255,255,255,0.08)` }}
          >
            <div className="relative aspect-[16/8] w-full overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={currentImage.imageUrl}
                alt={currentImage.caption ?? ""}
                className="h-full w-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-transparent to-transparent" />
              {currentImage.caption && (
                <div className="absolute inset-x-0 bottom-0 px-3.5 pb-2 pt-6">
                  <div className="text-[12.5px] font-semibold text-white drop-shadow-sm">
                    {currentImage.caption}
                  </div>
                </div>
              )}
            </div>
            {currentImage.ctaUrl && (
              <a
                href={currentImage.ctaUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between px-3.5 py-2 text-[12px] font-medium transition hover:bg-white/[0.04]"
                style={{ color: accent }}
              >
                <span>{currentImage.ctaLabel ?? viewSiteLabel(locale)}</span>
                <ExternalLink size={12} strokeWidth={2} />
              </a>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Showroom list overlay — appears when find_showrooms fires during a
          voice call. Compact list (operator + locality + Choisir button) so
          the customer can SEE the maison options the agent is talking about.
          Without this, voice users hear "we have 3 maisons" with no visual. */}
      <AnimatePresence>
        {showroomsVisible && currentShowrooms && (
          <motion.div
            key={`showrooms-${currentShowrooms.city ?? "all"}`}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.28, ease: [0.22, 0.68, 0, 1] }}
            // Same width + side-margins as the model image overlay so the
            // two never overlap; max-h with overflow keeps the panel from
            // pushing the input off-screen on short viewports.
            className="mt-4 w-[min(340px,calc(100vw-48px))] max-h-[42vh] overflow-y-auto overflow-x-hidden rounded-2xl border border-white/10 bg-white/[0.05] backdrop-blur-xl"
          >
            <div className="px-3.5 pt-2.5 text-[10px] font-medium uppercase tracking-[0.18em] text-white/55">
              {showroomHeaderLabel(currentShowrooms.items.length, currentShowrooms.city, locale)}
            </div>
            <div className="space-y-1 p-2">
              {currentShowrooms.items.slice(0, 4).map((s) => {
                const isSelected = selectedShowroomId === s.id;
                const isDimmed = selectedShowroomId !== null && !isSelected;
                return (
                  <div
                    key={s.id}
                    className="rounded-xl border border-white/8 bg-white/[0.04] px-3 py-2 transition"
                    style={{
                      opacity: isDimmed ? 0.45 : 1,
                      boxShadow: isSelected ? `inset 0 0 0 1.5px ${accent}` : undefined,
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md" style={{ background: `${accent}25`, color: accent }}>
                        <MapPin size={12} strokeWidth={1.8} />
                      </div>
                      <div className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-white">
                        {s.name}
                      </div>
                      {s.primary_dealer && (
                        <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[8.5px] font-semibold uppercase tracking-[0.12em]" style={{ background: `${accent}25`, color: accent }}>
                          <Star size={8} strokeWidth={2.2} fill={accent} stroke="none" />
                        </span>
                      )}
                    </div>
                    {onShowroomChoice && (
                      <button
                        type="button"
                        onClick={() => {
                          if (selectedShowroomId !== null) return;
                          setSelectedShowroomId(s.id);
                          onShowroomChoice(s.name);
                        }}
                        disabled={selectedShowroomId !== null}
                        className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-lg border border-white/10 px-2 py-1 text-[11px] text-white/85 transition enabled:hover:bg-white/[0.08] disabled:opacity-100"
                        style={isSelected ? { color: accent, borderColor: `${accent}55` } : undefined}
                      >
                        {isSelected ? (
                          <>
                            <Check size={11} strokeWidth={2.4} />
                            <span>{chosenLabelVoice(locale)}</span>
                          </>
                        ) : (
                          <span>{chooseLabelVoice(locale)}</span>
                        )}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      </div>{/* /middle flex wrapper */}

      {/* Bottom: controls */}
      <div className="relative shrink-0 flex flex-col items-center gap-3">
        {/* VIN scan buttons — show the MOMENT the agent asks for the chassis
            number, regardless of whether the customer has opened the keyboard.
            In voice mode the customer is mostly speaking, so they shouldn't
            have to discover the keyboard first to see the carte-grise scan
            affordance. We render this when typeRequest.kind === "vin" alone,
            so the camera / upload buttons are immediately reachable. */}
        {onSendText && typeRequest?.kind === "vin" && (
          <VinScanButtons
            accent={accent}
            locale={locale ?? null}
            onConfirm={(vin) => {
              onSendText(vin);
              setText("");
              setAutoPlaceholder(null);
              setSentFlash(true);
              setTimeout(() => setSentFlash(false), 1100);
            }}
          />
        )}

        {/* Inline text input — slides in when the user taps "Type" */}
        <AnimatePresence>
          {typing && onSendText && (
            <motion.div
              initial={{ opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.96 }}
              transition={{ duration: 0.22, ease: [0.22, 0.68, 0, 1] }}
              className="mb-1 flex w-[min(360px,calc(100vw-48px))] items-center gap-2 rounded-2xl border border-white/15 bg-white/[0.07] p-1.5 backdrop-blur-xl"
              style={{ boxShadow: `0 12px 32px -8px ${accent}55` }}
            >
              <input
                ref={inputRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); send(); }
                  if (e.key === "Escape") { setTyping(false); setText(""); }
                }}
                placeholder={placeholder}
                // focus-visible:outline-none + inline outline:none suppress the
                // global app/globals.css :focus-visible (Citroën red). Without
                // them autoFocus paints a red ring around the input on every
                // turn the keyboard opens.
                className="flex-1 bg-transparent px-3 py-2 text-[13.5px] text-white outline-none focus:outline-none focus-visible:outline-none placeholder:text-white/35"
                style={{ outline: "none" }}
              />
              <motion.button
                type="button"
                onClick={send}
                disabled={!text.trim()}
                whileTap={{ scale: 0.92 }}
                className="flex h-9 w-9 items-center justify-center rounded-xl text-white transition disabled:opacity-30"
                style={{ background: accent }}
                aria-label="Send"
              >
                <SendHorizonal size={15} strokeWidth={2} />
              </motion.button>
              <button
                type="button"
                onClick={() => { setTyping(false); setText(""); }}
                className="flex h-9 w-9 items-center justify-center rounded-xl text-white/55 transition hover:bg-white/[0.08] hover:text-white"
                aria-label="Close keyboard"
              >
                <X size={14} strokeWidth={2} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {sentFlash && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="text-[10.5px] uppercase tracking-[0.18em] text-emerald-300/85"
            >
              {labels.sent}
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex items-center gap-7">
          <button
            type="button"
            className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 text-white/75"
            title={state === "listening" ? "Mic on" : "Mic muted"}
            aria-label="Microphone"
          >
            {state === "listening" ? <Mic size={18} /> : <MicOff size={18} />}
          </button>

          <motion.button
            type="button"
            onClick={onHangUp}
            whileTap={{ scale: 0.9 }}
            whileHover={{ scale: 1.06 }}
            className="flex h-16 w-16 items-center justify-center rounded-full bg-red-500 text-white shadow-[0_0_42px_-6px_rgba(239,68,68,0.65)] transition hover:bg-red-600"
            aria-label="Hang up"
          >
            <PhoneOff size={22} />
          </motion.button>

          {onSendText ? (
            <motion.button
              type="button"
              onClick={() => setTyping((v) => !v)}
              whileTap={{ scale: 0.92 }}
              className={`flex h-12 w-12 items-center justify-center rounded-full transition ${
                typing ? "bg-white text-[#0c0c10]" : "bg-white/10 text-white/75 hover:bg-white/15 hover:text-white"
              }`}
              aria-label={labels.tap}
              title={labels.tap}
            >
              <Keyboard size={18} />
            </motion.button>
          ) : (
            <div className="h-12 w-12" />
          )}
        </div>

        {onSendText && !typing && (
          <button
            type="button"
            onClick={() => setTyping(true)}
            className="text-[11px] uppercase tracking-[0.2em] text-white/40 transition hover:text-white/70"
          >
            {labels.tap} ↑
          </button>
        )}
      </div>
    </div>
  );
}

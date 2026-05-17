"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { ExternalLink, MapPin, Phone, Clock, MessageCircle, Star, Check } from "lucide-react";
import type { ShowroomItem } from "@/lib/rihla-actions";

type Locale = "fr" | "ar" | "darija" | "en" | null | undefined;

function showroomHeader(count: number, city: string | undefined, locale: Locale): string {
  const cityPart = city ? ` · ${city}` : "";
  // Darija uses the brand-marketing term "la maison" (Stellantis stores in
  // Morocco are positioned as "La Maison [Brand]"), kept in Latin even inside
  // RTL flow. Standard Arabic still uses معرض.
  if (locale === "darija") {
    if (count === 1) return `la maison${cityPart}`;
    return `${count} maisons${cityPart}`;
  }
  if (locale === "ar") {
    if (count === 1) return `معرض واحد${cityPart}`;
    if (count === 2) return `معرضان${cityPart}`;
    return `${count} معارض${cityPart}`;
  }
  if (locale === "en") return `${count} showroom${count > 1 ? "s" : ""}${cityPart}`;
  return `${count} concession${count > 1 ? "s" : ""}${cityPart}`;
}

function chooseLabel(locale: Locale): string {
  if (locale === "ar" || locale === "darija") return "اختار";
  if (locale === "en") return "Choose";
  return "Choisir";
}

function chosenLabel(locale: Locale): string {
  if (locale === "ar" || locale === "darija") return "تم الاختيار";
  if (locale === "en") return "Selected";
  return "Sélectionné";
}

export function ShowroomCards({
  items,
  city,
  accent,
  locale,
  onSelect,
}: {
  items: ShowroomItem[];
  city?: string;
  accent: string;
  locale?: Locale;
  /** When provided, each card surfaces a "Choisir" button. Clicking it calls
   *  back with the showroom name so the parent can send it as a user message
   *  (clients reported the cards alone were a dead-end — no way to pick a
   *  maison without typing its full name). The card list locks after the
   *  first click so a tap doesn't double-fire. */
  onSelect?: (name: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  if (items.length === 0) return null;
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: [0.22, 0.68, 0, 1] }}
      className="flex w-full min-w-0 items-end gap-2"
    >
      <div className="relative h-7 w-7 shrink-0 overflow-hidden rounded-full ring-2 ring-white shadow-sm">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/rihla-avatar.jpg" alt="" className="h-full w-full object-cover" />
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-black/50">
          {showroomHeader(items.length, city, locale)}
        </div>
        <div className="space-y-1.5">
          {items.slice(0, 4).map((s, i) => {
            const isSelected = selectedId === s.id;
            const isDimmed = selectedId !== null && !isSelected;
            return (
            <motion.div
              key={s.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: isDimmed ? 0.45 : 1, y: 0 }}
              transition={{ duration: 0.25, delay: i * 0.04 }}
              className="w-full overflow-hidden rounded-2xl rounded-bl-md bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06),0_0_0_1px_rgba(0,0,0,0.05)] transition"
              style={isSelected ? { boxShadow: `0 1px 3px rgba(0,0,0,0.06), 0 0 0 2px ${accent}` } : undefined}
            >
              <div className="flex items-start gap-2.5 px-3.5 py-3">
                <div
                  className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                  style={{ background: `${accent}15`, color: accent }}
                >
                  <MapPin size={13} strokeWidth={1.7} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <div className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[#0c0c10]">{s.name}</div>
                    {s.primary_dealer && (
                      <span
                        className="inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em]"
                        style={{ background: `${accent}18`, color: accent }}
                      >
                        <Star size={9} strokeWidth={2.2} fill={accent} stroke="none" /> Flagship
                      </span>
                    )}
                  </div>
                  {s.address && (
                    <div className="mt-0.5 line-clamp-2 break-words text-[11.5px] text-black/55">{s.address}</div>
                  )}
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-black/55">
                    {s.phone && (
                      <a href={`tel:${s.phone.replace(/\s/g, "")}`} className="inline-flex items-center gap-1 transition hover:text-black/85">
                        <Phone size={10} strokeWidth={2} />
                        <bdi dir="ltr">{s.phone}</bdi>
                      </a>
                    )}
                    {s.whatsapp && (
                      <a
                        href={`https://wa.me/${s.whatsapp.replace(/[\s+]/g, "")}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 transition hover:text-emerald-600"
                      >
                        <MessageCircle size={10} strokeWidth={2} /> WhatsApp
                      </a>
                    )}
                    {s.hours && (
                      <span className="inline-flex items-center gap-1 whitespace-nowrap">
                        <Clock size={10} strokeWidth={2} />
                        {s.hours}
                      </span>
                    )}
                  </div>
                </div>
                {s.address && (
                  <a
                    href={`https://maps.google.com/?q=${encodeURIComponent(`${s.name} ${s.address}`)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Open in Google Maps"
                    className="ms-1 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-black/40 transition hover:bg-black/[0.04] hover:text-black/80"
                  >
                    <ExternalLink size={12} strokeWidth={2} />
                  </a>
                )}
              </div>
              {onSelect && (
                <button
                  type="button"
                  onClick={() => {
                    if (selectedId !== null) return;
                    setSelectedId(s.id);
                    onSelect(s.name);
                  }}
                  disabled={selectedId !== null}
                  className="flex w-full items-center justify-center gap-1.5 border-t border-black/[0.05] px-3 py-2 text-[12px] font-medium transition disabled:opacity-100 enabled:hover:bg-black/[0.03]"
                  style={isSelected ? { color: accent } : { color: "rgba(12, 12, 16, 0.7)" }}
                >
                  {isSelected ? (
                    <>
                      <Check size={13} strokeWidth={2.4} />
                      <span>{chosenLabel(locale)}</span>
                    </>
                  ) : (
                    <span>{chooseLabel(locale)}</span>
                  )}
                </button>
              )}
            </motion.div>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}

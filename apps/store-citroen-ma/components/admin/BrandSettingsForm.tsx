"use client";

import { useState, useTransition } from "react";
import { motion } from "framer-motion";
import { Check } from "lucide-react";
import type { Brand } from "@/lib/supabase/database.types";
import { updateBrandAction } from "@/app/admin/[brand]/settings/actions";

const VOICES = ["Zephyr", "Aoede", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus"];
const LOCALES = [
  { id: "fr-MA", label: "Français (MA)" },
  { id: "ar-MA", label: "Arabic (MA)" },
  { id: "darija-MA", label: "Darija (MA)" },
  { id: "en-MA", label: "English (MA)" },
  { id: "ar-SA", label: "Arabic (SA)" },
  { id: "en-SA", label: "English (SA)" },
];
const PRESET_COLORS = ["#D90030", "#1A5E2D", "#0E0E10", "#F0CB00", "#005EB8", "#E5293E", "#0072C5", "#DC0000"];

export function BrandSettingsForm({ brand }: { brand: Brand }) {
  const [color, setColor] = useState(brand.primary_color ?? "#6366f1");
  const [voice, setVoice] = useState(brand.voice_name ?? "Aoede");
  const [locales, setLocales] = useState<string[]>(brand.locales);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  return (
    <form
      action={(fd) => {
        // Locales come from checkbox state.
        for (const loc of LOCALES) {
          if (locales.includes(loc.id)) fd.set(`locale_${loc.id}`, "1");
          else fd.delete(`locale_${loc.id}`);
        }
        startTransition(async () => {
          await updateBrandAction(brand.id, fd);
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        });
      }}
      className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-5"
    >
      <div className="text-[13px] font-semibold">Identity</div>
      <div className="mt-0.5 text-[11px] text-white/40">Brand name, agent name, homepage</div>
      <div className="mt-4 space-y-3">
        <Field label="Brand name" name="name" defaultValue={brand.name} />
        <Field label="Agent name" name="agent_name" defaultValue={brand.agent_name} hint="Default: Rihla. Try “Layla” for Peugeot KSA." />
        <Field label="Homepage URL" name="homepage_url" defaultValue={brand.homepage_url} />
      </div>

      <div className="mt-7 text-[13px] font-semibold">Theme</div>
      <div className="mt-0.5 text-[11px] text-white/40">Primary color drives all accents on the demo + widget.</div>
      <div className="mt-4 space-y-2">
        <div className="flex flex-wrap gap-2">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className={`h-8 w-8 rounded-lg ring-2 transition ${color === c ? "ring-white" : "ring-transparent hover:ring-white/30"}`}
              style={{ background: c }}
              aria-label={c}
            />
          ))}
        </div>
        <div className="flex items-center gap-3">
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-9 w-9 cursor-pointer rounded-lg border border-white/10 bg-transparent"
          />
          <input
            type="text"
            name="primary_color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 font-mono text-[12px] text-white outline-none focus:border-white/30"
          />
        </div>
      </div>

      <div className="mt-7 text-[13px] font-semibold">Voice</div>
      <div className="mt-0.5 text-[11px] text-white/40">Gemini Live prebuilt voice for the call mode.</div>
      <div className="mt-3 grid grid-cols-4 gap-2">
        {VOICES.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setVoice(v)}
            className={`rounded-lg border px-2 py-2 text-[11.5px] transition ${
              voice === v
                ? "border-white/30 bg-white/[0.07] text-white"
                : "border-white/10 bg-white/[0.025] text-white/55 hover:border-white/20 hover:text-white"
            }`}
          >
            {v}
          </button>
        ))}
        <input type="hidden" name="voice_name" value={voice} />
      </div>

      <div className="mt-7 text-[13px] font-semibold">Languages</div>
      <div className="mt-0.5 text-[11px] text-white/40">Locales available in the language picker.</div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {LOCALES.map((loc) => {
          const on = locales.includes(loc.id);
          return (
            <button
              key={loc.id}
              type="button"
              onClick={() =>
                setLocales((prev) => (prev.includes(loc.id) ? prev.filter((l) => l !== loc.id) : [...prev, loc.id]))
              }
              className={`flex items-center justify-between rounded-lg border px-3 py-2 text-[11.5px] transition ${
                on
                  ? "border-white/30 bg-white/[0.07] text-white"
                  : "border-white/10 bg-white/[0.025] text-white/55 hover:border-white/20"
              }`}
            >
              <span>{loc.label}</span>
              {on && <Check size={13} strokeWidth={2.4} />}
            </button>
          );
        })}
      </div>

      {/* Save */}
      <div className="mt-7 flex items-center justify-end gap-3">
        {saved && (
          <motion.div
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0 }}
            className="inline-flex items-center gap-1.5 text-[11px] text-emerald-400"
          >
            <Check size={13} strokeWidth={2} /> Saved
          </motion.div>
        )}
        <button
          type="submit"
          disabled={isPending}
          className="rounded-lg bg-white px-4 py-2 text-[12px] font-medium text-[#0c0c10] transition hover:bg-white/90 disabled:opacity-50"
        >
          {isPending ? "Saving…" : "Save settings"}
        </button>
      </div>
    </form>
  );
}

function Field({ label, name, defaultValue, hint }: { label: string; name: string; defaultValue?: string; hint?: string }) {
  return (
    <label className="block">
      <span className="block text-[11px] text-white/55">{label}</span>
      <input
        name={name}
        defaultValue={defaultValue}
        className="mt-1 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[13px] text-white outline-none focus:border-white/30"
      />
      {hint && <span className="mt-1 block text-[10.5px] text-white/35">{hint}</span>}
    </label>
  );
}

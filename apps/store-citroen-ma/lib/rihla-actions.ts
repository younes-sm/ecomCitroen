"use client";

// Client-side action dispatcher for Rihla tool-use events.
// The API route emits ND-JSON lines with {type:"tool", name, input}; this module
// turns them into real DOM / router side effects.

import { lookupVin } from "@/lib/vin-lookup";

export type ConfiguratorChange = {
  modelSlug?: string;
  colorId?: string;
  trimId?: string;
  angleIndex?: number;
};

const CONFIG_EVENT = "rihla:configurator";
const SECTION_EVENT = "rihla:scroll";
const FINANCING_EVENT = "rihla:financing";
const END_CALL_EVENT = "rihla:end-call";
const TEST_DRIVE_EVENT = "rihla:test-drive";
const IMAGE_CARD_EVENT = "rihla:image-card";
const SHOWROOMS_EVENT = "rihla:showrooms";
const VIDEO_CARD_EVENT = "rihla:video-card";
const TYPE_REQUEST_EVENT = "rihla:type-request";

export type ShowroomItem = {
  id: string;
  name: string;
  city: string;
  address: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  hours: string | null;
  service_centre: boolean;
  primary_dealer: boolean;
};

export type ShowroomsPayload = {
  city?: string;
  brandName?: string;
  items: ShowroomItem[];
};

export function emitShowrooms(payload: ShowroomsPayload) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ShowroomsPayload>(SHOWROOMS_EVENT, { detail: payload }));
}

export function onShowrooms(cb: (p: ShowroomsPayload) => void) {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => cb((e as CustomEvent<ShowroomsPayload>).detail);
  window.addEventListener(SHOWROOMS_EVENT, listener);
  return () => window.removeEventListener(SHOWROOMS_EVENT, listener);
}

/** Payload for the explicit "open the input keyboard for this field" event.
 *  The agent fires request_input(field) when it needs the customer to type a
 *  sensitive value — way more reliable than regex-parsing the transcript. */
export type TypeRequestPayload = {
  field: "name" | "phone" | "email" | "vin";
};

export function emitTypeRequest(payload: TypeRequestPayload) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<TypeRequestPayload>(TYPE_REQUEST_EVENT, { detail: payload }));
}

export function onTypeRequest(cb: (p: TypeRequestPayload) => void) {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => cb((e as CustomEvent<TypeRequestPayload>).detail);
  window.addEventListener(TYPE_REQUEST_EVENT, listener);
  return () => window.removeEventListener(TYPE_REQUEST_EVENT, listener);
}

export type ImageCardPayload = {
  /** Model slug — used to look up image in brand catalog if imageUrl missing. */
  modelSlug?: string;
  /** Full image URL (local /brands/... path or remote). Wins over modelSlug lookup. */
  imageUrl?: string;
  caption?: string;
  /** Optional CTA shown under the image — opens ctaUrl in a new tab. */
  ctaLabel?: string;
  ctaUrl?: string;
};

export function emitImageCard(payload: ImageCardPayload) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ImageCardPayload>(IMAGE_CARD_EVENT, { detail: payload }));
}

export function onImageCard(cb: (p: ImageCardPayload) => void) {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => cb((e as CustomEvent<ImageCardPayload>).detail);
  window.addEventListener(IMAGE_CARD_EVENT, listener);
  return () => window.removeEventListener(IMAGE_CARD_EVENT, listener);
}

export type VideoCardPayload = {
  modelSlug?: string;
  caption?: string;
  /** Direct video URL (e.g. /videos/demo.mp4). Plays inline with native
   *  <video> controls. Stellantis will hand over per-model assets at
   *  deployment; until then we use the demo asset for every model. */
  videoUrl: string;
  /** Optional poster image shown before play. */
  poster?: string;
};

export function emitVideoCard(payload: VideoCardPayload) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<VideoCardPayload>(VIDEO_CARD_EVENT, { detail: payload }));
}

export function onVideoCard(cb: (p: VideoCardPayload) => void) {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => cb((e as CustomEvent<VideoCardPayload>).detail);
  window.addEventListener(VIDEO_CARD_EVENT, listener);
  return () => window.removeEventListener(VIDEO_CARD_EVENT, listener);
}

export type TestDrivePayload = {
  slug?: string;
  firstName?: string;
  phone?: string;
  city?: string;
  preferredSlot?: string;
};

export function emitEndCall() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(END_CALL_EVENT));
}

export function onEndCall(cb: () => void) {
  if (typeof window === "undefined") return () => {};
  const listener = () => cb();
  window.addEventListener(END_CALL_EVENT, listener);
  return () => window.removeEventListener(END_CALL_EVENT, listener);
}

export function emitTestDrive(payload: TestDrivePayload) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<TestDrivePayload>(TEST_DRIVE_EVENT, { detail: payload }));
}

export function onTestDrive(cb: (p: TestDrivePayload) => void) {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => cb((e as CustomEvent<TestDrivePayload>).detail);
  window.addEventListener(TEST_DRIVE_EVENT, listener);
  return () => window.removeEventListener(TEST_DRIVE_EVENT, listener);
}

export type FinancingUpdate = {
  modelSlug?: string;
  downPayment?: number;
  termMonths?: number;
  tradeIn?: number;
};

export function emitFinancingUpdate(update: FinancingUpdate) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<FinancingUpdate>(FINANCING_EVENT, { detail: update }));
}

export function onFinancingUpdate(cb: (u: FinancingUpdate) => void) {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => cb((e as CustomEvent<FinancingUpdate>).detail);
  window.addEventListener(FINANCING_EVENT, listener);
  return () => window.removeEventListener(FINANCING_EVENT, listener);
}

// Buffered snapshot of the most recent configurator change so it survives the
// router.push → mount race. When the agent fires configure_car AND we need to
// navigate to /models/{slug} at the same time, `dispatchEvent` runs *before*
// ConfiguratorStage subscribes — and a stock CustomEvent has no replay, so the
// visual stays on the old color despite the agent promising the change.
//
// We solve this with a tiny "last change" cache: emit() stores the change with
// a timestamp + a sequence number, and any new subscriber consumes it if it's
// fresh enough (1500 ms) and not already consumed by its own sequence number.
// Listeners track the last seq they processed so they don't replay the same
// change on every re-render.
let pendingConfigChange: { change: ConfiguratorChange; seq: number; at: number } | null = null;
let configSeq = 0;
const CONFIG_REPLAY_WINDOW_MS = 1500;

export function emitConfiguratorChange(change: ConfiguratorChange) {
  if (typeof window === "undefined") return;
  configSeq += 1;
  pendingConfigChange = { change, seq: configSeq, at: Date.now() };
  window.dispatchEvent(
    new CustomEvent<{ change: ConfiguratorChange; seq: number }>(CONFIG_EVENT, {
      detail: { change, seq: configSeq },
    })
  );
}

export function onConfiguratorChange(cb: (c: ConfiguratorChange) => void) {
  if (typeof window === "undefined") return () => {};
  let lastSeqHandled = 0;
  const handle = (change: ConfiguratorChange, seq: number) => {
    if (seq <= lastSeqHandled) return;
    lastSeqHandled = seq;
    cb(change);
  };
  // Replay the most recent change if it landed while we were mounting.
  // Cap at CONFIG_REPLAY_WINDOW_MS so a stale snapshot doesn't fire when the
  // user opens a fresh model page minutes later.
  const pending = pendingConfigChange;
  if (pending && Date.now() - pending.at < CONFIG_REPLAY_WINDOW_MS) {
    handle(pending.change, pending.seq);
  }
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<{ change: ConfiguratorChange; seq: number }>).detail;
    handle(detail.change, detail.seq);
  };
  window.addEventListener(CONFIG_EVENT, listener);
  return () => window.removeEventListener(CONFIG_EVENT, listener);
}

export function emitScrollTo(section: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>(SECTION_EVENT, { detail: section }));
}

export function onScrollTo(cb: (section: string) => void) {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => cb((e as CustomEvent<string>).detail);
  window.addEventListener(SECTION_EVENT, listener);
  return () => window.removeEventListener(SECTION_EVENT, listener);
}

export type RihlaToolCall = {
  name: string;
  input: Record<string, unknown>;
};

/**
 * Brand catalog passed in widget mode. When present, tools that "show a model"
 * resolve to image cards / new-tab page opens instead of router pushes — there's
 * no local model page on the demo widget surface.
 */
export type WidgetBrand = {
  slug: string;
  /** Display name used in UI labels and showroom-card headings. */
  name?: string;
  /** Persona name shown as the chat header / call view ("NARA", "Rihla", …). */
  agentName?: string;
  homepageUrl: string;
  models: Array<{
    slug: string;
    name: string;
    heroImage: string;
    galleryImages: string[];
    pageUrl: string;
  }>;
};

type DispatchCtx = {
  locale: string;
  router: { push: (href: string) => void };
  currentPath?: string;
  brand?: WidgetBrand;
};

/** Resolve a tool_use call to an outcome description the model sees next turn. */
export function dispatchRihlaTool(call: RihlaToolCall, ctx: DispatchCtx): string {
  const { name, input } = call;
  const { locale, router, currentPath = "", brand } = ctx;

  // In widget mode, we delegate "show me a model" intents to image cards and
  // "go to the page" intents to opening the brand site in a new tab.
  const widgetMode = !!brand;
  // Fuzzy slug resolver — voice transcripts often deliver "Wrangler" /
  // "Jeep Wrangler" / "wrangler 2024" instead of the canonical "wrangler"
  // slug. Normalize aggressively (lowercase, alphanumerics only) and try:
  //   1. exact match on canonical slug
  //   2. canonical slug ⊂ normalized input (substring containment)
  //   3. canonical model name ⊂ normalized input
  const normSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const findModel = (slug: string) => {
    if (!brand?.models?.length || !slug) return undefined;
    const ns = normSlug(slug);
    if (!ns) return undefined;
    const exact = brand.models.find((m) => normSlug(m.slug) === ns);
    if (exact) return exact;
    const slugSubstr = brand.models.find((m) => {
      const ms = normSlug(m.slug);
      return ms && (ns.includes(ms) || ms.includes(ns));
    });
    if (slugSubstr) return slugSubstr;
    return brand.models.find((m) => {
      const mn = normSlug(m.name);
      return mn && (ns.includes(mn) || mn.includes(ns));
    });
  };

  try {
    switch (name) {
      case "navigate_to": {
        // Legacy storefront-only tool. In widget mode, ignore.
        if (widgetMode) return "navigate_to is disabled in widget mode";
        const raw = String(input.path ?? "/");
        const path = raw.startsWith("/") ? raw : `/${raw}`;
        const localePrefixed = path.startsWith(`/${locale}`) ? path : `/${locale}${path}`;
        if (currentPath === localePrefixed) return "already on that page";
        router.push(localePrefixed);
        return `navigated to ${localePrefixed}`;
      }
      case "show_model_image": {
        const slug = String(input.slug ?? input.modelSlug ?? "");
        const model = slug ? findModel(slug) : undefined;
        const imageUrl = typeof input.imageUrl === "string" ? input.imageUrl : model?.heroImage;
        if (!imageUrl) {
          const known = brand?.models?.map((m) => m.slug).join(", ") ?? "—";
          console.warn(`[rihla] show_model_image — no image resolved for slug "${slug}". Known: [${known}]`);
          return `no image for slug "${slug}" — known slugs: [${known}]`;
        }
        const caption =
          typeof input.caption === "string"
            ? input.caption
            : model
            ? model.name
            : undefined;
        console.log(`[rihla] show_model_image → ${model?.slug ?? slug} (${imageUrl})`);
        emitImageCard({
          modelSlug: model?.slug ?? slug ?? undefined,
          imageUrl,
          caption,
          ctaUrl: model?.pageUrl,
        });
        return `showed image for ${model?.slug ?? slug}`;
      }
      case "show_model_video": {
        const slug = String(input.slug ?? input.modelSlug ?? "");
        const model = slug ? findModel(slug) : undefined;
        // Single demo asset for every model — Stellantis will provide
        // per-model video files at deployment. The card just demonstrates
        // that videos can be played inline.
        emitVideoCard({
          modelSlug: slug || undefined,
          caption: model?.name ?? slug,
          videoUrl: "/videos/demo.mp4",
          poster: model?.heroImage,
        });
        return `showed video card for ${slug || "model"}`;
      }
      case "open_brand_page": {
        const slug = String(input.slug ?? "");
        const model = slug ? findModel(slug) : undefined;
        const url = typeof input.url === "string" ? input.url : model?.pageUrl ?? brand?.homepageUrl;
        if (!url) return "no URL to open";
        if (typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer");
        return `opened ${url} in new tab`;
      }
      case "open_model": {
        const slug = String(input.slug ?? "");
        // Widget mode: prefer showing an image card + offering the brand page,
        // not routing to a local /models/[slug] page that doesn't exist.
        if (widgetMode) {
          const model = findModel(slug);
          if (model) {
            emitImageCard({
              modelSlug: slug,
              imageUrl: model.heroImage,
              caption: model.name,
              ctaUrl: model.pageUrl,
            });
            return `showed ${slug} (widget mode)`;
          }
          return `unknown model "${slug}"`;
        }
        // Legacy storefront mode.
        const target = `/${locale}/models/${slug || "c3-aircross"}`;
        if (currentPath === target) return "already on that model page";
        router.push(target);
        return `opened model detail for ${slug}`;
      }
      case "configure_car": {
        const change: ConfiguratorChange = {
          modelSlug: typeof input.slug === "string" ? input.slug : undefined,
          colorId: typeof input.color === "string" ? input.color : undefined,
          trimId: typeof input.trim === "string" ? input.trim : undefined,
          angleIndex:
            typeof input.angle === "number"
              ? input.angle
              : typeof input.angleIndex === "number"
              ? input.angleIndex
              : undefined,
        };
        // Widget mode (chatbot embedded on a 3rd-party page or brand site) has
        // no in-page ConfiguratorStage to drive. Hijacking router.push() would
        // navigate the HOST page away — terrible UX. Instead, send back an
        // image-card showing the new color and surface a tool-result message
        // the model can paraphrase ("voici l'Avenger en noir, ouvrez le
        // configurateur pour interagir"). Skip emitConfiguratorChange so we
        // don't leave a stale snapshot dangling for the next session.
        if (widgetMode) {
          const model = change.modelSlug ? findModel(change.modelSlug) : undefined;
          if (model && change.colorId) {
            // Reuse show_model_image to surface a fresh card. We don't pick a
            // color-specific render here — the brand catalog at widget-mode
            // doesn't carry per-color images. The card is a visual cue; the
            // canonical configurator lives on the brand site.
            emitImageCard({
              modelSlug: model.slug,
              imageUrl: model.heroImage,
              caption: `${model.name} — ${change.colorId}`,
              ctaUrl: model.pageUrl,
            });
            return `widget-mode: shown ${model.slug} card (color ${change.colorId} not previewable inline — direct customer to ${model.pageUrl} for live configurator)`;
          }
          return `widget-mode: configure_car ignored — open the brand site for the live configurator${model ? ` (${model.pageUrl})` : ""}`;
        }
        // Storefront mode: only navigate if we're NOT already on the target
        // model page — otherwise just update the live configurator to avoid a
        // full reload. emitConfiguratorChange buffers the change so the
        // ConfiguratorStage component picks it up after the router.push
        // completes (see lib/rihla-actions.ts emitConfiguratorChange).
        const targetPath = change.modelSlug
          ? `/${locale}/models/${change.modelSlug}`
          : null;
        if (targetPath && currentPath !== targetPath) {
          router.push(targetPath);
        }
        emitConfiguratorChange(change);
        return `updated configurator with ${JSON.stringify(change)}`;
      }
      case "scroll_to": {
        const section = String(input.section ?? "");
        emitScrollTo(section);
        return `scrolled to ${section}`;
      }
      case "start_reservation": {
        const slug = String(input.slug ?? "c3-aircross");
        const target = `/${locale}/reserve/${slug}`;
        if (currentPath === target) return "already on reservation";
        router.push(target);
        return `started reservation for ${slug}`;
      }
      case "open_dealers": {
        const target = `/${locale}/dealers`;
        if (currentPath === target) return "already on dealers";
        router.push(target);
        return "opened dealers page";
      }
      case "open_financing": {
        const target = `/${locale}/financing`;
        if (currentPath !== target) router.push(target);
        return "opened financing advisor";
      }
      case "end_call": {
        emitEndCall();
        return "call ended";
      }
      case "request_input": {
        // Explicit "open the on-screen keyboard for this field" tool. The
        // agent calls this on the same turn as its text instruction so the
        // customer sees the input field appear right when prompted. Much
        // more reliable than relying on transcript regex parsing to detect
        // sensitive-field asks.
        const rawField = String(input.field ?? "").toLowerCase();
        const field = (
          ["name", "phone", "email", "vin"].includes(rawField) ? rawField : "name"
        ) as "name" | "phone" | "email" | "vin";
        emitTypeRequest({ field });
        return `keyboard opened for field=${field}`;
      }
      case "lookup_vin": {
        // APV (Jeep) — voice path. Look up the customer record from the mock
        // CRC database and return a structured string the model reads on its
        // next turn. The chat path uses server-side VIN PREFILL injection
        // instead; this case keeps the voice flow symmetric.
        const rawVin = String(input.vin ?? "");
        const rec = lookupVin(rawVin);
        if (!rec) {
          return `vin_lookup_result=not_found · vin="${rawVin}" · The chassis number is not in the CRC database. Tell the customer politely and offer to collect their info manually (full name → mobile → email → confirm Jeep + model), then continue with intervention type / city / date / slot.`;
        }
        const firstName = rec.fullName.split(/\s+/)[0] ?? rec.fullName;
        const parts = [
          `vin_lookup_result=matched`,
          `vin=${rec.vin}`,
          `first_name=${firstName}`,
          `full_name=${rec.fullName}`,
          `phone=${rec.phone}`,
          `email=${rec.email}`,
          `vehicle=${rec.brand} ${rec.model} (${rec.modelYear})`,
          `registration_city=${rec.registrationCity}`,
        ];
        if (rec.preferredSite) parts.push(`preferred_site=${rec.preferredSite}`);
        if (rec.lastServiceDate) parts.push(`last_service=${rec.lastServiceDate} at ${rec.lastServiceLocation ?? "-"}`);
        parts.push("Greet by first_name in the customer's language and confirm full_name + phone + email + vehicle (and preferred_site if present) in ONE warm sentence, then ask intervention type (mécanique / carrosserie). DO NOT re-ask name / phone / email / brand / model.");
        return parts.join(" · ");
      }
      case "find_showrooms": {
        const city = typeof input.city === "string" ? input.city : undefined;
        const brandSlug = brand?.slug;
        if (!brandSlug) return "no brand context for showroom lookup";
        // Fire-and-forget: hit the server endpoint, then emit a UI event.
        const params = new URLSearchParams({ brand: brandSlug });
        if (city) params.set("city", city);
        if (typeof window !== "undefined") {
          fetch(`/api/rihla/showrooms?${params}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => {
              const items = (j?.items ?? []) as ShowroomItem[];
              if (items.length === 0) return;
              emitShowrooms({ city, brandName: brand?.name, items });
            })
            .catch(() => {});
        }
        // Tell the model how many we'll show so it can phrase its turn well.
        return `showroom lookup dispatched for "${city ?? "all cities"}"`;
      }
      case "book_showroom_visit": {
        const payload: TestDrivePayload = {
          slug: typeof input.slug === "string" ? input.slug : undefined,
          firstName: typeof input.firstName === "string" ? input.firstName : undefined,
          phone: typeof input.phone === "string" ? input.phone : undefined,
          city: typeof input.city === "string" ? input.city : undefined,
          preferredSlot: typeof input.preferredSlot === "string" ? input.preferredSlot : undefined,
        };
        // Reuse the test-drive lead pipeline; mark it as a showroom visit via slug suffix.
        emitTestDrive(payload);
        return `showroom visit booked for ${payload.firstName ?? "lead"} (${payload.phone ?? "no phone"}) in ${payload.city ?? "—"}`;
      }
      case "book_test_drive": {
        const payload: TestDrivePayload = {
          slug: typeof input.slug === "string" ? input.slug : undefined,
          firstName: typeof input.firstName === "string" ? input.firstName : undefined,
          phone: typeof input.phone === "string" ? input.phone : undefined,
          city: typeof input.city === "string" ? input.city : undefined,
          preferredSlot: typeof input.preferredSlot === "string" ? input.preferredSlot : undefined,
        };
        emitTestDrive(payload);
        return `test drive booked for ${payload.firstName ?? "lead"} (${payload.phone ?? "no phone"}) on ${payload.slug ?? "model"}`;
      }
      case "calculate_financing": {
        const update: FinancingUpdate = {};
        if (typeof input.slug === "string") update.modelSlug = input.slug;
        if (typeof input.vehiclePrice === "number") {
          // Map price to model slug
          const priceMap: Record<number, string> = { 234900: "c3-aircross", 295900: "c5-aircross", 195900: "berlingo" };
          update.modelSlug = priceMap[input.vehiclePrice] ?? update.modelSlug;
        }
        if (typeof input.downPayment === "number") update.downPayment = input.downPayment;
        if (typeof input.termMonths === "number") update.termMonths = input.termMonths;
        if (typeof input.tradeIn === "number") update.tradeIn = input.tradeIn;

        // Navigate to financing page if not already there
        const finTarget = `/${locale}/financing`;
        if (currentPath !== finTarget) router.push(finTarget);

        // Emit the update so the form picks it up
        setTimeout(() => emitFinancingUpdate(update), 500);

        // Run the calculation locally and return the result to the model
        const price = input.vehiclePrice as number || 234900;
        const dp = (input.downPayment as number) || 0;
        const months = (input.termMonths as number) || 60;
        const rate = (input.annualRatePct as number) || 5.99;
        const principal = price - dp;
        const mr = rate / 100 / 12;
        const monthly = mr === 0 ? principal / months : (principal * mr * Math.pow(1 + mr, months)) / (Math.pow(1 + mr, months) - 1);
        return `Financing: ${Math.round(monthly)} MAD/month over ${months} months, principal ${principal} MAD, rate ${rate}%`;
      }
      default:
        return `unknown tool: ${name}`;
    }
  } catch (err) {
    return `tool error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

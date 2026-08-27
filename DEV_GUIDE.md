# Rihla — Dev Guide

Multi-brand AI sales + after-sales chatbot widget for Stellantis (Citroën Maroc, Jeep Maroc, Peugeot KSA). One Next.js app. One agent persona ("Rihla"). Per-brand prompts, catalogs, showrooms, and feature gates. Designed to demo to OEM stakeholders and to drop a Salesforce CRM integration in later.

This guide gives the team enough to keep shipping without me. Read top to bottom on day one; sections are referenced throughout.

---

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js 15 App Router** | Server actions for admin, edge-friendly streaming for chat |
| Language | **TypeScript** strict | Catches contract drift across the persistence + tool layer |
| Styling | **Tailwind CSS** + Framer Motion | All custom components, no UI library |
| DB | **Supabase (Postgres)** | Service-role for server-only writes, RLS-locked everywhere else |
| Chat LLM | **Gemini 3.1 Flash Preview** via `@google/genai` | Streaming, function calling, fast TTFT |
| Voice LLM | **Gemini 3.1 Flash Live Preview** via WebSocket Bidi API | Real-time audio in/out + tools + transcription |
| Failover | **Claude Opus 4.7** via `@anthropic-ai/sdk` | Used when Gemini is down |
| Hosting | **Vercel** | Auto-deploy on push to `main` |
| Repo | Monorepo (Turborepo + pnpm workspaces) | Shared `@citroen-store/rihla-agent` package for prompt-builder reuse |

The app lives at `apps/store-citroen-ma/`. The shared agent package is `packages/rihla-agent/`. Don't add another app — extend this one with brand routing.

---

## 2. Local setup

```bash
# from the repo root
pnpm install

cd apps/store-citroen-ma
cp .env.local.example .env.local   # edit values — see §3
pnpm dev                            # runs on :3100
```

Then open one of:

- `http://localhost:3100/demo/citroen-ma`
- `http://localhost:3100/demo/jeep-ma`
- `http://localhost:3100/demo/peugeot-ksa`

Admin: `http://localhost:3100/admin` (password = `ADMIN_PASSWORD` from `.env.local`).

---

## 3. Environment variables

All in `apps/store-citroen-ma/.env.local`. Production values live in Vercel's project settings — never commit them.

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ…       # browser-side, RLS-bound
SUPABASE_SERVICE_ROLE_KEY=eyJ…           # SERVER ONLY, bypasses RLS

# LLMs
GOOGLE_API_KEY=AIza…                      # SERVER ONLY — chat (Gemini) + voice ephemeral-token mint. Never NEXT_PUBLIC_.
ANTHROPIC_API_KEY=sk-ant-…                # chat failover (Claude Opus 4.7)

# Scraping (slice 3 — KB content from brand sites)
FIRECRAWL_API_KEY=fc-…

# Admin gate
ADMIN_PASSWORD=stellantis-demo-2026       # single-tenant gate; replace per environment
ADMIN_SESSION_SECRET=<random-32-bytes>    # signs the auth cookie
```

**Security note:** the voice path no longer exposes any API key to the browser. The widget POSTs `/api/rihla/voice/token`; the server mints a single-use ephemeral token with the session config (system prompt, voice, tools) baked in via `bidiGenerateContentSetup`, and the browser connects to the `v1alpha` `BidiGenerateContentConstrained` WebSocket with that token. `GOOGLE_API_KEY` must exist only as a server env var. IMPORTANT: on the Constrained endpoint the client `setup` message is IGNORED — changing the voice/prompt means changing the MINT (lib/voice-prompt.ts + the token route), not the client.

---

## 4. Repository structure

```
.
├── apps/store-citroen-ma/         # the only app; multi-brand widget + admin
│   ├── app/
│   │   ├── (marketing)/           # public landing — not used in the demo
│   │   ├── [locale]/              # locale-prefixed customer pages (legacy)
│   │   ├── admin/                 # ADMIN backoffice (gated by ADMIN_PASSWORD)
│   │   │   ├── [brand]/
│   │   │   │   ├── page.tsx                    # brand dashboard (KPIs)
│   │   │   │   ├── conversations/              # chat + voice transcripts
│   │   │   │   ├── leads/                      # SALES leads (test drives + showroom visits)
│   │   │   │   ├── appointments/               # APV — service appointments (Jeep only)
│   │   │   │   ├── complaints/                 # APV — complaints (Jeep only)
│   │   │   │   ├── analytics/                  # funnel + drop-off
│   │   │   │   ├── prompt/                     # system-prompt editor with version history
│   │   │   │   └── settings/                   # brand identity, voice name, locales
│   │   │   ├── login/                          # password gate
│   │   │   └── page.tsx                        # cross-brand summary
│   │   ├── demo/[brand]/page.tsx               # the customer-facing widget host page
│   │   └── api/rihla/                          # backend
│   │       ├── chat/route.ts                   # NDJSON streaming chat — Gemini → tool events
│   │       ├── system-prompt/route.ts          # composed system prompt for voice mode
│   │       ├── voice/start/route.ts            # registers a voice conversation (gets id)
│   │       ├── voice/event/route.ts            # persists voice transcript chunks
│   │       └── showrooms/route.ts              # served-cities lookup for find_showrooms
│   ├── components/
│   │   ├── rihla/                              # CUSTOMER widget
│   │   │   ├── WidgetBubble.tsx                # the chat panel + state machine
│   │   │   ├── CallView.tsx                    # voice-mode UI (avatar + image overlay)
│   │   │   ├── LanguagePicker.tsx              # language + brand-aware welcomes
│   │   │   ├── ModePicker.tsx                  # chat vs voice picker
│   │   │   └── ShowroomCards.tsx               # showroom-list card
│   │   ├── admin/                              # ADMIN UI
│   │   │   ├── AdminSidebar.tsx                # nav with brand switcher + APV gating
│   │   │   ├── PromptEditorClient.tsx          # tone presets + diff view
│   │   │   ├── AppointmentStatusSelect.tsx
│   │   │   ├── ComplaintStatusSelect.tsx
│   │   │   ├── LeadStatusSelect.tsx
│   │   │   └── charts/                         # SVG funnel / time-series / heatmap
│   │   └── demo/                               # the "fake brand site" hosting the widget
│   ├── lib/
│   │   ├── rihla-actions.ts                    # CLIENT-side tool dispatcher (event bus)
│   │   ├── use-rihla-live.ts                   # voice WebSocket hook
│   │   ├── persistence.ts                      # all Supabase writes (server-only)
│   │   ├── brand-context.ts                    # caches brand row + models + showrooms
│   │   ├── phone.ts                            # MA / SA mobile validators
│   │   ├── email.ts                            # email validator
│   │   ├── vin.ts                              # VIN validator (17 chars, no I/O/Q)
│   │   ├── dates.ts                            # appointment date validator (J+1..J+30, no Sun, no MA holidays)
│   │   ├── vin-lookup.ts                       # MOCK — 8 seeded Jeep VINs that pre-fill
│   │   ├── reference-number.ts                 # RDV-YYYY-MMDD-NNN generator
│   │   └── supabase/                           # supabase client + types
│   ├── scripts/                                # ONE-OFF and SEED scripts (run with pnpm tsx)
│   │   ├── refresh-prompts.ts                  # PUSHES the active prompt body to DB
│   │   ├── seed-supabase.ts                    # seeds brands + models from brand-data/*.json
│   │   ├── seed-showrooms.ts                   # seeds 50+ showrooms across 3 brands
│   │   ├── seed-prices.ts                      # bulk-updates model prices
│   │   ├── seed-synthetic.ts                   # 150 fake conversations for analytics demo
│   │   ├── scrape-brands.ts                    # firecrawl scrape of brand model pages
│   │   ├── download-images.ts                  # downloads model hero + gallery images
│   │   └── brand-data/                         # scraped JSON per brand (offline fallback)
│   ├── public/
│   │   ├── brand/                              # Rihla avatar
│   │   ├── brands/{slug}/                      # per-brand images (hero + gallery)
│   │   └── videos/demo.mp4                     # the demo video the agent plays inline
│   └── package.json
├── packages/rihla-agent/                       # shared prompt-builder package
│   └── src/
│       ├── prompt.ts                           # composes system prompt
│       └── models.ts                           # RIHLA_MODELS (Anthropic model id constants)
├── supabase/migrations/                        # SQL — run in Supabase SQL editor in order
│   ├── 00001_init.sql                          # brands, models, prompts, conversations, messages, leads
│   ├── 00002_showrooms.sql                     # showrooms table
│   ├── 00003_lead_extras.sql                   # showroom_name + messages.seq + trigger
│   └── 00004_apv.sql                           # service_appointments + complaints (after-sales)
└── Workflow_Chatbot_APV_Stellantis.xlsx        # client-provided spec for the after-sales flow
```

---

## 5. Architecture overview

### 5.1 Customer-facing flow

```
Customer browser
  │  (1) loads /demo/{brand} → renders the brand microsite + widget
  │
  ├─ WidgetBubble.tsx  (state machine: lang → mode → chat | voice)
  │     │
  │     ├─ Chat mode → POST /api/rihla/chat (NDJSON streaming)
  │     │     │
  │     │     ▼
  │     │   Gemini 3.1 Flash Preview (function calling)
  │     │     │  text deltas + tool calls
  │     │     ▼
  │     │   Server tap proxy:
  │     │     - dedup tool calls (don't show same model twice)
  │     │     - inline persist for APV bookings (gets ref number)
  │     │     - emit apv_confirmation event
  │     │     ▼
  │     │   Client receives stream → renders messages + cards + dispatches tools
  │     │
  │     └─ Voice mode → WebSocket → Gemini 3.1 Flash Live Preview
  │           │  bidi audio + transcripts + function calls
  │           ▼
  │         use-rihla-live.ts hook:
  │           - mic capture → PCM frames over WS
  │           - speaker output ← PCM frames from WS
  │           - tool calls + tool responses
  │           - transcript persistence
  │
Server  ──── Supabase
  │   conversations, messages, tool_calls, leads,
  │   service_appointments, complaints, events
```

### 5.2 Brand-aware logic

Every customer touchpoint is parametrized by `brandSlug`:

- **Catalog** (cars, prices, gallery): `lib/brand-context.ts` reads from `models` table by brand_id, with a JSON fallback in `scripts/brand-data/{slug}.json` if Supabase is offline.
- **Showrooms**: same pattern — `showrooms` table filtered by brand_id, cities surfaced as the SHOWROOM COVERAGE block in the prompt.
- **System prompt**: `prompts` table holds versioned bodies per brand. The active row (where `is_active = true`) is what the agent uses. Edit it via the admin (`/admin/{brand}/prompt`) or via `pnpm tsx scripts/refresh-prompts.ts`.
- **Welcome / opener**: `LanguagePicker.tsx` → `getOpeningGreeting(lang, brandSlug)`. Jeep gets the 4-track APV greeting, others stay sales-only.
- **Feature gates** (e.g., APV): hardcoded in `apvEnabled = brandSlug === "jeep-ma"` — three places: the chat route's VIN pre-extraction + persistence loop, the prompt builder (APV block appended only for Jeep), the AdminSidebar (Appointments/Complaints links shown only for Jeep). Search `"jeep-ma"` to find them all when you flip the flag.

### 5.3 Chat conversation flow (sales)

The agent runs a **two-phase conversation** for sales:

**Phase 1 — Information & Discovery.** Customer asks questions, agent recommends models, answers specs/pricing/comparisons. No data collection. The agent makes ONE soft test-drive offer per 3–4 substantive turns and otherwise stays helpful.

**Phase 2 — Data Collection** (only on explicit trigger like "yes book it" / "let's do a test drive"). One field per turn: name → mobile (validated MA / SA format) → city → showroom → preferred slot. Agent recaps in one natural sentence, then calls `book_test_drive` or `book_showroom_visit`.

The trigger and rules live in the prompt body, not in code. To change the flow, edit `scripts/refresh-prompts.ts` and run it.

### 5.4 Chat conversation flow (after-sales — Jeep only)

Layered ON TOP of the sales prompt. The agent reads the customer's first reply and routes into ONE of four tracks:

- **Sales** (existing flow)
- **RDV** — service appointment booking. 11 fields. CNDP consent required. Calls `book_service_appointment`.
- **Info** — KB Q&A (currently a holding answer that says "a dealer will get you the exact figure" — slice 3 will replace this with scraped content from `jeep.com/ma/after-sales/*`).
- **Réclamation** — complaint flow. 10 fields + free-text reason ≥ 20 chars. Empathetic opening tone. Urgency keywords trigger the 5050 hotline message. Calls `submit_complaint`.

When the customer types a VIN, the chat route runs a regex on the user message, calls `lookupVin()`, and injects the resulting record (name / email / phone / preferred site) as a `VIN PREFILL` block into the system prompt. The agent greets the returning customer by name and pre-fills the form. **No tool round-trip** — this is server-side text injection, which avoids a class of "model called lookup_vin and waited forever" bugs.

### 5.5 Tool system

Two separate tool registries, kept in lockstep:

- **Chat (HTTPS)**: `apps/store-citroen-ma/app/api/rihla/chat/route.ts` — `GEMINI_NAV_TOOLS` and `ANTHROPIC_NAV_TOOLS`.
- **Voice (Live WebSocket)**: `apps/store-citroen-ma/lib/use-rihla-live.ts` — `LIVE_TOOLS`.

Tools fall into three classes:

| Class | Tools | What happens |
|---|---|---|
| **Pure UI side-effects** | `show_model_image`, `show_model_video`, `find_showrooms`, `open_brand_page` | Server emits a tool event in the stream → client dispatches via `lib/rihla-actions.ts` → fires a custom DOM event (`rihla:image-card`, `rihla:showrooms`, etc.) → `WidgetBubble` listens and renders a card. **Idempotent**: server dedups same-slug calls before forwarding. |
| **Lead / booking captures** | `book_test_drive`, `book_showroom_visit`, `book_service_appointment`, `submit_complaint` | Server validates → persists → for APV bookings emits an `apv_confirmation` event with the generated ref number. Customer sees a green confirmation card with their reference number in the same turn. |
| **Conversation control** | `end_call`, `configure_car`, `scroll_to`, `navigate_to`, `start_reservation` | Mostly used in voice / legacy storefront. `end_call` is the most important — fires the "end of call" lifecycle on voice. |

**Adding a new tool** — see §11.2.

---

## 6. Database schema — quick tour

The key tables, in dependency order. Full DDL is in `supabase/migrations/`.

### 6.1 `brands`
The widgets we run for. Each row drives a separate brand microsite. Currently three: `citroen-ma`, `jeep-ma`, `peugeot-ksa`.

### 6.2 `models`
One row per car model per brand. Fields: `slug`, `name`, `price_from`, `currency`, `body_type`, `seats`, `fuel`, `hero_image_url`, `gallery_images`, `key_features`, `page_url` (link to the brand's official site).

The agent NEVER invents a model — the prompt builder injects this catalog as a CATALOG block.

### 6.3 `prompts`
Versioned system prompt bodies per brand. The active row (`is_active = true`) is what the chat + voice routes load. **Always create a new version** rather than editing in place — keeps an audit trail and one-click rollback in the admin.

### 6.4 `showrooms`
Brand dealer locations (50+ rows seeded across the 3 brands). The list of distinct cities here drives the SHOWROOM COVERAGE block in the prompt — when the customer names a city not in this list, the agent gracefully suggests a covered one instead of getting stuck.

### 6.5 `conversations`
One row per chat session or voice call. Tracks funnel checkpoints (`reached_usage`, `reached_budget`, …, `booked_test_drive`), captured lead data (`lead_name`, `lead_phone`, `lead_city`, `lead_slot`, `lead_showroom`, `lead_model_slug`), locale, channel (`chat` / `voice`), and lifecycle status (`open` / `closed_lead` / `closed_no_lead` / `abandoned`).

### 6.6 `messages`
Per-turn rows tied to a conversation. `role` is `user` | `assistant` | `system`. `kind` is `text` | `image_card` | `tool_use`. The optional `payload` JSON carries structured data for non-text rows. The `seq` column is auto-assigned by a trigger and gives deterministic ordering when multiple rows land within the same millisecond.

### 6.7 `tool_calls`
Denormalised view of every tool invocation, for analytics. Joined to `messages` via `message_id`.

### 6.8 `leads`
Sales leads — captured by `book_test_drive` / `book_showroom_visit`. Fields: `first_name`, `phone`, `city`, `preferred_slot`, `model_slug`, `showroom_name`, `notes`, status enum.

### 6.9 `service_appointments` (APV — Jeep)
The 11 RDV fields + `ref_number` (`RDV-2026-0427-001`-style) + `cndp_consent_at` + a 6-stage status workflow (`new` → `qualified` → `assigned` → `confirmed` → `completed` / `cancelled`). When validation warnings happen during agent collection (bad VIN, off-format phone), they're tagged into `notes` so the CRC is alerted but the lead isn't dropped.

### 6.10 `complaints` (APV — Jeep)
Same shape as `service_appointments` minus date/slot, plus `site` (the atelier where the problem happened), `reason` (free text ≥ 20 chars), `service_date` (optional, ≤ today and ≥ today-180), `attachment_url` (optional). Status workflow: `new` → `qualified` → `assigned` → `in_progress` → `resolved` / `closed_no_resolution`.

### 6.11 `events`
Generic analytics events (`widget_opened`, `voice_started`, etc.). Used sparingly for now.

### 6.12 RLS

Everything is RLS-locked. The browser only reads `brands` and `models` (filtered to `enabled = true`). All writes and analytics reads go through server routes using the **service-role key**. Don't surface other tables to anon — the lead/appointment/complaint data is PII and must never hit the client directly.

---

## 7. Common dev tasks

### 7.1 Edit the system prompt for a brand

Two ways:

**Admin UI** (recommended for content tweaks):
1. Go to `/admin/{brand}/prompt`.
2. Edit the textarea — note the tone-preset chips at the top, they stamp a TONE OVERRIDE block on click.
3. Tick "Activate immediately".
4. Click "Save new version".

The new version is live the next time the chat route loads (1-min in-process cache TTL). Older versions stay in `prompts` table for one-click rollback.

**Script** (for the canonical body — when you want to re-baseline all brands):
1. Edit `scripts/refresh-prompts.ts` (the per-brand `PERSONAS` map and the shared `BODY` / `APV_BLOCK` constants).
2. Run `pnpm tsx scripts/refresh-prompts.ts` from `apps/store-citroen-ma/`.

### 7.2 Add a new model to a brand

1. Add the row in `models` table (via the Supabase Studio or via SQL).
2. Drop the hero image at `apps/store-citroen-ma/public/brands/{slug}/{model-slug}/hero.png`.
3. Bump the prompt — model catalog is auto-injected on every chat call, no prompt edit needed.

If you scrape from the brand's site, follow the pattern in `scripts/scrape-brands.ts` + `scripts/download-images.ts`.

### 7.3 Add a new brand

This is the bigger lift but well-trodden:

1. **DB**: insert a row in `brands` (slug, name, market, currency, locales, primary_color, logo_url).
2. **Catalog**: add models. If you have a brand site, run `scripts/scrape-brands.ts` against it.
3. **Showrooms**: add to `scripts/seed-showrooms.ts` and re-run.
4. **Prompt**: extend the `PERSONAS` map in `scripts/refresh-prompts.ts` with a brand persona block, then run the script.
5. **Welcomes**: if you want APV-style or other variant openers, extend `LanguagePicker.tsx` `APV_GREETINGS` (or rename it once we have more brand variants).
6. **Logo + Rihla avatar override** (optional): drop assets in `public/brands/{slug}/`.
7. **Demo route**: there's already a generic `/demo/[brand]/page.tsx` that picks up any enabled brand. No code change needed if the brand_id resolves.

### 7.4 Edit the voice system prompt

Voice and chat share the same prompt body (DB `prompts` row), with a voice-specific suffix appended in `app/api/rihla/system-prompt/route.ts`. To tune the voice behaviour, edit either:

- The shared body (changes both chat and voice) — `refresh-prompts.ts`.
- The voice suffix only (tone for spoken-aloud, end-call rules) — `app/api/rihla/system-prompt/route.ts` lines 80–106.

### 7.5 Push a tone change quickly

Use the **tone presets** in `/admin/{brand}/prompt`. Click "Warm" / "Direct" / "Premium" / "Playful". Each stamps a `═══ TONE OVERRIDE ═══` block at the top of the prompt body that takes precedence over later instructions. Save as a new version.

### 7.6 Add a service appointment / complaint to the demo for a non-Jeep brand

Today this is gated on `brandSlug === "jeep-ma"` in three places. To enable for Citroën / Peugeot KSA:

1. **`scripts/refresh-prompts.ts`** → `compose(slug)` — change `slug === "jeep-ma"` to also include the new brand.
2. **`components/admin/AdminSidebar.tsx`** → `apvEnabled` — same.
3. **`app/api/rihla/chat/route.ts`** → `apvEnabled` (around line 575) — same.
4. **`components/rihla/LanguagePicker.tsx`** → `getOpeningGreeting()` — extend to use `APV_GREETINGS` for the new brand.

Then run `pnpm tsx scripts/refresh-prompts.ts` to push the prompt body.

### 7.7 Apply a database migration

We are NOT using Supabase CLI yet. Migrations are SQL files we paste into Supabase's SQL editor:

1. Open https://supabase.com/dashboard/project/_/sql/new.
2. Paste the contents of the next un-applied file from `supabase/migrations/`.
3. Run.

Files are numbered. Apply in order. The repo currently has `00001` through `00004`.

When a code change requires a column the migration adds, the inserts wrap try/catch — the chat will still work but the new field won't persist. So always apply migrations **before** deploying code that uses them.

### 7.8 Run the seed scripts

From `apps/store-citroen-ma/`:

```bash
pnpm tsx scripts/seed-supabase.ts        # brands + models from brand-data/*.json
pnpm tsx scripts/seed-showrooms.ts       # 50+ showrooms
pnpm tsx scripts/seed-prices.ts          # bulk-update model prices
pnpm tsx scripts/seed-synthetic.ts       # 150 fake conversations for analytics demo
pnpm tsx scripts/refresh-prompts.ts      # push the current prompt body to all brands
```

All scripts are idempotent (delete + reinsert by brand_id, or upsert by slug).

### 7.9 Test the chat locally without leaving the deploy DB unchanged

`pnpm dev` from `apps/store-citroen-ma/` always points at the `.env.local` Supabase. We don't have a separate dev DB. If you need to mutate prompts / catalogs / showrooms experimentally, do it in a feature branch + a separate Supabase project; the `getBrandContext` cache flushes after 60 s.

---

## 8. The agent prompt — what's in it

The full system prompt the LLM sees on every turn is composed in `packages/rihla-agent/src/prompt.ts` `buildSystemPrompt()` and topped up by the chat route. In order, top to bottom:

1. **Persona head** — "You are Rihla, a senior sales advisor for {brandName}…" (function-generated)
2. **Language block** — strict locale rules (no darija in MSA, no Arabic in French, etc.) per the active locale
3. **Custom body** from `prompts.body` for that brand — this is what admins edit
4. **Catalog** — auto-injected from `models` table for that brand
5. **Showroom coverage** — auto-injected from `showrooms` table cities
6. **Page context** — current page path + viewing-model slug (storefront-mode only)
7. **Voice mode rules** — when the request is voice
8. **Session memory** — `═══ SESSION MEMORY ═══` block listing already-shown models/videos/cities/collected fields. Updated every turn from the client's `sessionContext` payload. **This is what stops the "ok → re-show same image card" bug.**
9. **VIN PREFILL** (Jeep + APV only) — when a VIN regex hit fires server-side, the matched record is pasted in.

The custom body for Jeep also has the **APV BLOCK** at the very end with the 4-track intent routing, RDV / complaint sub-flows, CNDP consent rules, and 4 worked examples.

Total prompt size for the Jeep widget: ~12,000 words. For Citroën / Peugeot KSA: ~5,000 words. Gemini Flash Preview handles both fine.

---

## 9. Backoffice (admin)

Auth: a single password gate. `/admin/login` form posts to `loginAction`, sets a signed cookie. Server-side middleware (`middleware.ts`) validates on every admin request.

Per-brand pages live under `/admin/{slug}/`:

- **Dashboard** — KPI cards, time-series, mini funnel
- **Conversations** — list + detail. Detail page renders the transcript with image / video / showroom / lead-captured rows shown as the customer saw them.
- **Sales leads** — captured by test-drive / showroom-visit bookings. Status workflow + CSV export.
- **Appointments** (Jeep) — RDVs with the 11 fields, filter pills, status select inline, 6-stage workflow.
- **Complaints** (Jeep) — same shape, includes the customer's free-text reason.
- **Analytics** — funnel + drop-off charts.
- **Prompt** — versioned editor with tone presets + line-level diff + version history sidebar with one-click rollback.
- **Settings** — brand identity, primary color, voice name, locales, model toggle list.

The sidebar feature-flags Appointments / Complaints to Jeep only. Flip in `components/admin/AdminSidebar.tsx`.

---

## 10. Voice mode

The voice path is **separate** from chat. Read `lib/use-rihla-live.ts` end to end before changing anything here.

Sequence:

1. User picks "voice" from the mode picker.
2. `useEffect` kicks `live.connect()`.
3. `connect()` opens a WebSocket to `wss://generativelanguage.googleapis.com/.../BidiGenerateContent` with the API key.
4. In parallel, fetches `/api/rihla/system-prompt` (gets the prompt body + voice settings) and `/api/rihla/voice/start` (creates a conversation row in DB and returns its id), and requests mic permission.
5. On `ws.onopen`, awaits all three and sends the `setup` payload (model id, voice config, system instruction, tools, transcription enabled).
6. On `setupComplete`, state goes to `listening` and mic chunks start flowing as `realtimeInput` PCM.
7. Audio chunks come back as base64 PCM in `serverContent.modelTurn.parts[].inlineData`. Decoded → queued → played via `AudioContext` `BufferSource`.
8. Tool calls come as `toolCall.functionCalls`. Each gets dispatched to the same client-side `dispatchRihlaTool` as chat. The function's return string is sent back as a `toolResponse` so the model can continue.
9. `serverContent.turnComplete` ends a turn — flush transcript buffers to `/api/rihla/voice/event`, drain audio queue, return state to `listening`.
10. `end_call` tool sets `shouldDisconnectRef = true` with a 6-second hard backstop. After audio drains, the WS is closed.

**Defensive resets** in `connect()` — `shouldDisconnectRef`, `isPlayingRef`, `playQueueRef`, transcript buffers — guard against a stale state from a previous session leaking into the new one. Without these, the first voice attempt of a fresh page could silently disconnect mid-greeting because a leftover `shouldDisconnectRef = true` would fire on `turnComplete`. (Bug fixed `9f576bc`.)

**Audio context** — pre-warmed and resumed in `connect()`, inside the user click. Without this, the first-greeting audio could play into a suspended context (browser autoplay policy) and be silent.

---

## 11. Add / change patterns

### 11.1 Add a UI string to the welcome / picker

`components/rihla/LanguagePicker.tsx` — the `LANGS` table holds the default sales greeting per locale. `APV_GREETINGS` holds the Jeep variant. `getOpeningGreeting(lang, brandSlug)` is the resolver — extend it when you add brand-specific welcomes.

### 11.2 Add a new tool

Register it in three places:

1. **Chat-Gemini schema** — `app/api/rihla/chat/route.ts` → `GEMINI_NAV_TOOLS[0].functionDeclarations`.
2. **Chat-Anthropic schema** — same file → `ANTHROPIC_NAV_TOOLS`.
3. **Voice schema** — `lib/use-rihla-live.ts` → `LIVE_TOOLS[0].functionDeclarations` (note: voice uses `"OBJECT"` / `"STRING"` / `"BOOLEAN"` strings, whereas chat-Gemini uses the `Type` enum).

Then implement the dispatcher in `lib/rihla-actions.ts` — a new `case` in the `switch` that fires a custom DOM event. Listen to it in `WidgetBubble.tsx` to render UI.

If the tool has server-side side-effects (like persisting a row), handle it in the chat route's post-stream loop — that's where `book_test_drive`, `book_service_appointment`, and `submit_complaint` are hooked. For voice, server-side side-effects don't have a natural hook today; the dispatcher handles everything client-side.

Update the prompt body to teach the LLM when to call the new tool. Examples + when-NOT-to-call rules > abstract descriptions.

### 11.3 Add a new conversation flow / track

If it's a new "Phase" (like a ticket-status check), put it in the DB-stored prompt body — no code needed beyond a tool registration. Use the APV block in `refresh-prompts.ts` as a template. Keep flows mutually exclusive in the prompt with explicit intent triggers, otherwise the LLM blends them.

### 11.4 Wire Salesforce

Today every booking writes to our Supabase. The Salesforce integration described in the Stellantis spec (`Workflow_Chatbot_APV_Stellantis.xlsx`, sheet 6) is where this routes to instead. The change is small:

1. Update `lib/persistence.ts` `createServiceAppointment()` and `createComplaint()` to ALSO POST to `/apex/chatbot/appointment` (or wherever the SF endpoint sits) with OAuth.
2. Add a `salesforce_id` column to the relevant tables to store SF's case ID.
3. Add retry + dead-letter logging in case SF is unreachable.

Same applies to `captureLeadFromBooking()` for the sales side.

The Stellantis-Morocco Salesforce wire we built earlier in this engagement is the reference implementation; copy that pattern.

---

## 12. Known issues / TODO

Honest inventory of what's not yet there. None of these block the demo, but address them before scaling.

1. **KB / Info track for Jeep** — the prompt currently returns a holding answer ("a dealer will give you exact figures") instead of grounded content. The next round will firecrawl `jeep.com/ma/after-sales/*` (8 URLs) into a `kb_articles` table and add an `answer_kb` tool that does retrieval over scraped content. **Scoped, not started.**
2. **Salesforce CRM integration** — mocked. Reference numbers are generated locally, no SF round-trip yet. Wire when the OEM provides credentials. See §11.4.
3. **APV gated to Jeep only** — by design for the demo. Flip after sign-off (§7.6).
4. **VIN lookup is mocked** — `lib/vin-lookup.ts` has 8 seeded Jeep VINs. Production will swap this for the SF `/apex/chatbot/lookup-vin` endpoint.
5. **Voice diagnostics** — `ws.onclose` now logs `code` + `reason`. If voice stops mid-call, watch the console for non-1000 codes.
6. **Phone validation** — only MA + KSA today. Add markets when needed.
7. **No rate limiting** on `/api/rihla/chat`. Anyone can hammer it. Add per-IP rate limits before going live publicly.
8. **No CNDP cookie banner**. Required for MA/EU production. Stub a banner before public launch.
9. ~~`NEXT_PUBLIC_GOOGLE_API_KEY` exposed to the browser~~ — FIXED: voice now uses server-minted ephemeral tokens (see §3). The env var is unused; remove it from Vercel.
10. **Single admin password**. Add per-brand admin users + audit log when production needs it.
11. **No KPI dashboards on the new APV tables** yet. The `/admin/{brand}` dashboard still only counts sales leads. Extend the analytics queries to include appointments + complaints.
12. **Eval harness** — none. We've been testing manually. Before each prompt change, run a 12-conversation script per locale to catch regressions. Mandatory before scaling beyond the demo.

---

## 13. Deployment

- `git push origin main` → Vercel auto-deploys to `https://agent-cars.vercel.app/`.
- Vercel env vars are in the project settings — keep in sync with `.env.local` shape but use production values.
- Migrations are NOT auto-applied. After pushing code that depends on a new column / table, paste the migration into the Supabase SQL editor BEFORE the deploy goes live.
- Prompt body changes do NOT require a deploy — they're pulled at runtime from the DB. After editing in `/admin/{brand}/prompt` (or running `refresh-prompts.ts`), the next chat call within 60 seconds will pick them up.

---

## 14. Where to find things — quick map

| You want to… | File |
|---|---|
| Edit the welcome message | `components/rihla/LanguagePicker.tsx` |
| Edit the chat panel UI | `components/rihla/WidgetBubble.tsx` |
| Edit the voice call screen | `components/rihla/CallView.tsx` |
| Edit the canonical prompt body | `scripts/refresh-prompts.ts` |
| Edit the prompt skeleton (catalog block, language block) | `packages/rihla-agent/src/prompt.ts` |
| Edit the chat backend / streaming | `app/api/rihla/chat/route.ts` |
| Edit the voice WebSocket logic | `lib/use-rihla-live.ts` |
| Edit the system prompt for voice | `app/api/rihla/system-prompt/route.ts` |
| Add a tool for the LLM | §11.2 |
| Add a new admin page | `app/admin/[brand]/{page}/page.tsx` |
| Add a brand | §7.3 |
| Tweak validators (phone / email / VIN / dates) | `lib/{phone,email,vin,dates}.ts` |
| Update the seeded VIN database | `lib/vin-lookup.ts` |
| Update reference-number format | `lib/reference-number.ts` |
| Apply a SQL migration | §7.7 |

---

## 15. Contact / handover notes

- **Repo**: `https://github.com/VolundVentures/ecomCitroen`
- **Production**: `https://agent-cars.vercel.app/`
- **Stellantis spec doc**: `Workflow_Chatbot_APV_Stellantis.xlsx` at the repo root — reference for the after-sales flow contract (fields, validation rules, SF endpoints, KPIs).
- **Prompt versioning**: every save in `/admin/{brand}/prompt` creates a new row. Roll back from the version history sidebar.
- **Cache TTL**: brand context (catalog + active prompt) is cached in-process for 60 seconds. After editing, give it up to a minute or hit a different lambda warm-up.

When in doubt, read the file. The codebase is small enough that grep + a clear hypothesis beats stack traces. Naming is descriptive; comments above non-obvious code blocks explain the *why*. Stick to that style.

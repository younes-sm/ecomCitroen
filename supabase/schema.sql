-- Combined schema for the Jeep chatbot Supabase project.
-- Generated from supabase/migrations/* in order. Paste into the Supabase
-- SQL Editor (one shot) on a fresh project, then run the seed scripts.

-- ════════════════════════════════════════════════════════════════
-- supabase/migrations/00001_init.sql
-- ════════════════════════════════════════════════════════════════
-- ─── Brands ─────────────────────────────────────────────────────────────────
-- Each brand drives a separate widget (jeep-ma, citroen-ma, peugeot-ksa).
create table if not exists public.brands (
  id              uuid primary key default gen_random_uuid(),
  slug            text unique not null,                     -- 'jeep-ma'
  name            text not null,                            -- 'Jeep Maroc'
  homepage_url    text not null,                            -- 'https://www.jeep.com/ma/index.html'
  market          text not null,                            -- 'MA' / 'SA'
  default_currency text not null,                           -- 'MAD' / 'SAR'
  locales         text[] not null,                          -- ['fr-MA','ar-MA','darija-MA']
  primary_color   text,                                     -- '#1a1a1a' for theming
  logo_url        text,                                     -- '/brands/jeep-ma/logo.svg'
  voice_name      text not null default 'Zephyr',           -- Gemini voice
  agent_name      text not null default 'Rihla',
  enabled         boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ─── Models ─────────────────────────────────────────────────────────────────
-- Vehicles per brand. Used by the agent to recommend + show inline images.
create table if not exists public.models (
  id              uuid primary key default gen_random_uuid(),
  brand_id        uuid not null references public.brands(id) on delete cascade,
  slug            text not null,                            -- 'wrangler', 'c3-aircross'
  name            text not null,                            -- 'Wrangler', 'C3 Aircross'
  tagline         text,
  description     text,
  body_type       text,                                     -- 'SUV', 'Hatchback', etc.
  price_from      numeric(12,2),
  currency        text,
  fuel            text,
  transmission    text,
  seats           int,
  hero_image_url  text not null,                            -- canonical hero
  gallery_images  text[] not null default '{}',             -- additional photos
  key_features    text[] not null default '{}',
  specs           jsonb not null default '{}'::jsonb,
  page_url        text not null,                            -- canonical brand-site URL
  display_order   int not null default 100,
  enabled         boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (brand_id, slug)
);
create index if not exists idx_models_brand on public.models(brand_id) where enabled;

-- ─── Prompt versions ────────────────────────────────────────────────────────
-- Versioned system prompts per brand. The latest version with is_active = true
-- is what the agent uses at runtime.
create table if not exists public.prompts (
  id              uuid primary key default gen_random_uuid(),
  brand_id        uuid not null references public.brands(id) on delete cascade,
  version         int not null,                             -- monotonic per brand
  body            text not null,                            -- the full system prompt
  is_active       boolean not null default false,
  notes           text,                                     -- editor's note about the change
  edited_by       text,                                     -- email or 'system'
  created_at      timestamptz not null default now(),
  unique (brand_id, version)
);
create index if not exists idx_prompts_active on public.prompts(brand_id, is_active) where is_active;

-- ─── Conversations ──────────────────────────────────────────────────────────
create type public.conversation_status as enum ('open', 'closed_lead', 'closed_no_lead', 'abandoned');

create table if not exists public.conversations (
  id              uuid primary key default gen_random_uuid(),
  brand_id        uuid not null references public.brands(id) on delete cascade,
  prompt_id       uuid references public.prompts(id) on delete set null,
  locale          text not null,                            -- 'fr-MA' / 'ar-MA' / 'darija-MA' / 'en-MA'
  channel         text not null,                            -- 'chat' or 'voice'
  status          public.conversation_status not null default 'open',
  -- Funnel checkpoints — set when the corresponding info is captured.
  reached_usage      timestamptz,
  reached_budget     timestamptz,
  reached_recommendation timestamptz,
  captured_name      timestamptz,
  captured_phone     timestamptz,
  captured_city      timestamptz,
  captured_slot      timestamptz,
  booked_test_drive  timestamptz,
  -- Lead data captured during the flow (also normalized in `leads` table).
  lead_name       text,
  lead_phone      text,
  lead_city       text,
  lead_slot       text,
  lead_model_slug text,
  ip_country      text,
  user_agent      text,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  duration_seconds int generated always as (
    case when ended_at is not null then extract(epoch from (ended_at - started_at))::int else null end
  ) stored
);
create index if not exists idx_conv_brand_started on public.conversations(brand_id, started_at desc);
create index if not exists idx_conv_status on public.conversations(brand_id, status);

-- ─── Messages ───────────────────────────────────────────────────────────────
create type public.message_role as enum ('user', 'assistant', 'system');
create type public.message_kind as enum ('text', 'image_card', 'tool_use');

create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role            public.message_role not null,
  kind            public.message_kind not null default 'text',
  content         text,                                     -- text body (null for tool_use)
  -- For image_card and tool_use, payload carries structured data:
  --   image_card: { imageUrl, caption, ctaLabel, ctaUrl, modelSlug }
  --   tool_use:   { name, input, output? }
  payload         jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists idx_messages_conv on public.messages(conversation_id, created_at);

-- ─── Tool calls ─────────────────────────────────────────────────────────────
-- Denormalized view of tool invocations for analytics. Mirrors a subset of `messages`
-- but is queryable directly without unpacking JSON.
create table if not exists public.tool_calls (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  message_id      uuid references public.messages(id) on delete cascade,
  name            text not null,                            -- 'open_model', 'book_test_drive', ...
  input           jsonb not null default '{}'::jsonb,
  result          jsonb,
  succeeded       boolean,
  created_at      timestamptz not null default now()
);
create index if not exists idx_toolcalls_conv on public.tool_calls(conversation_id, created_at);
create index if not exists idx_toolcalls_name on public.tool_calls(name, created_at desc);

-- ─── Events ─────────────────────────────────────────────────────────────────
-- Generic analytics events — page loads, CTAs, drop-offs.
create table if not exists public.events (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations(id) on delete cascade,
  brand_id        uuid references public.brands(id) on delete cascade,
  name            text not null,                            -- 'widget_opened', 'voice_started', etc.
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists idx_events_brand_name on public.events(brand_id, name, created_at desc);
create index if not exists idx_events_conv on public.events(conversation_id, created_at);

-- ─── Leads ──────────────────────────────────────────────────────────────────
-- Normalized lead records (what the dealer actually receives).
create table if not exists public.leads (
  id              uuid primary key default gen_random_uuid(),
  brand_id        uuid not null references public.brands(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  model_slug      text not null,
  first_name      text not null,
  phone           text not null,
  city            text,
  preferred_slot  text,
  notes           text,
  status          text not null default 'new',              -- 'new' / 'contacted' / 'closed'
  created_at      timestamptz not null default now()
);
create index if not exists idx_leads_brand on public.leads(brand_id, created_at desc);
create index if not exists idx_leads_status on public.leads(brand_id, status);

-- ─── updated_at triggers ────────────────────────────────────────────────────
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_brands_touch on public.brands;
create trigger trg_brands_touch before update on public.brands
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_models_touch on public.models;
create trigger trg_models_touch before update on public.models
  for each row execute function public.touch_updated_at();

-- ─── RLS ────────────────────────────────────────────────────────────────────
-- Row Level Security: lock everything down. The browser uses the anon key only
-- to read brand + model catalogs (public-facing widget data). All writes and
-- analytics reads go through server routes using the service-role key.
alter table public.brands           enable row level security;
alter table public.models           enable row level security;
alter table public.prompts          enable row level security;
alter table public.conversations    enable row level security;
alter table public.messages         enable row level security;
alter table public.tool_calls       enable row level security;
alter table public.events           enable row level security;
alter table public.leads            enable row level security;

-- Public read of enabled brands + models for the widget.
drop policy if exists "anon read enabled brands" on public.brands;
create policy "anon read enabled brands" on public.brands
  for select using (enabled = true);

drop policy if exists "anon read enabled models" on public.models;
create policy "anon read enabled models" on public.models
  for select using (enabled = true);

-- Everything else: service-role only (no anon policy = anon blocked).


-- ════════════════════════════════════════════════════════════════
-- supabase/migrations/00002_showrooms.sql
-- ════════════════════════════════════════════════════════════════
-- Showrooms / dealer locations per brand. Used by the find_showrooms tool so
-- Rihla can list nearby concessions when the customer names a city.

create table if not exists public.showrooms (
  id              uuid primary key default gen_random_uuid(),
  brand_id        uuid not null references public.brands(id) on delete cascade,
  name            text not null,                    -- "Stafim Tunis Centre"
  city            text not null,                    -- "Casablanca"
  address         text,                              -- "Bd. Anfa, Casablanca 20000"
  phone           text,
  whatsapp        text,
  email           text,
  hours           text,                              -- "Mon–Sat 9am–7pm"
  lat             double precision,
  lng             double precision,
  service_centre  boolean not null default false,    -- has a workshop too
  primary_dealer  boolean not null default false,    -- highlighted in city
  enabled         boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists showrooms_brand_idx on public.showrooms(brand_id);
create index if not exists showrooms_city_idx on public.showrooms(brand_id, city);

-- Re-create the updated_at trigger using the helper from migration 00001.
drop trigger if exists trg_showrooms_touch on public.showrooms;
create trigger trg_showrooms_touch before update on public.showrooms
  for each row execute function public.touch_updated_at();

-- Service-role can do anything; anon can read enabled rows.
alter table public.showrooms enable row level security;
drop policy if exists showrooms_anon_read on public.showrooms;
create policy showrooms_anon_read on public.showrooms
  for select to anon, authenticated using (enabled = true);
drop policy if exists showrooms_service_all on public.showrooms;
create policy showrooms_service_all on public.showrooms
  for all to service_role using (true) with check (true);


-- ════════════════════════════════════════════════════════════════
-- supabase/migrations/00003_lead_extras.sql
-- ════════════════════════════════════════════════════════════════
-- ─── Round-3 lead extras ───────────────────────────────────────────────────
-- 1. Capture the dealer the customer booked with (showroom_name) — currently
--    lost when the customer picks a specific showroom from the find_showrooms
--    list. Mirrored in `leads` (dealer-facing record) and `conversations`
--    (admin transcript view's lead summary).
-- 2. Per-conversation message sequence number — gives deterministic ordering
--    in the admin transcript when multiple rows land in the same millisecond
--    (which is what was making messages appear out of order). Existing rows
--    default to 0; new rows get the next value via the trigger below.

alter table public.leads
  add column if not exists showroom_name  text;

alter table public.conversations
  add column if not exists lead_showroom  text;

alter table public.messages
  add column if not exists seq integer not null default 0;

create index if not exists idx_messages_conv_seq on public.messages(conversation_id, seq);

create or replace function public.assign_message_seq()
returns trigger language plpgsql as $$
declare
  next_seq int;
begin
  if NEW.seq is null or NEW.seq = 0 then
    select coalesce(max(seq), 0) + 1
      into next_seq
      from public.messages
      where conversation_id = NEW.conversation_id;
    NEW.seq := next_seq;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_messages_assign_seq on public.messages;
create trigger trg_messages_assign_seq
  before insert on public.messages
  for each row execute function public.assign_message_seq();


-- ════════════════════════════════════════════════════════════════
-- supabase/migrations/00004_apv.sql
-- ════════════════════════════════════════════════════════════════
-- ─── APV (Après-Vente) — Round-4 ───────────────────────────────────────────
-- Two new tables to support the Stellantis after-sales workflow:
--   service_appointments  — RDV booking flow (Parcours 1)
--   complaints            — Réclamation flow (Parcours 3)
--
-- The KB / Info flow (Parcours 2) does NOT need a customer-data row — it's a
-- pure read-side. We'll add `kb_articles` in a separate migration when the
-- scrape lands.
--
-- Tables are shared across brands (brand_id FK) but the demo is gated to
-- jeep-ma only — the prompt + welcome only enable APV for that widget.

-- ─── Service appointments (RDV) ────────────────────────────────────────────
create type public.appointment_status as enum (
  'new',          -- created by chatbot, not yet contacted
  'qualified',    -- CRC reviewed and validated
  'assigned',     -- routed to a specific dealer
  'confirmed',    -- dealer reached the customer and locked the slot
  'completed',    -- intervention performed
  'cancelled'     -- customer cancelled / dealer rejected
);

create type public.intervention_type as enum (
  'mechanical',
  'bodywork'
);

create type public.appointment_slot as enum (
  'morning',
  'afternoon'
);

create table if not exists public.service_appointments (
  id              uuid primary key default gen_random_uuid(),
  brand_id        uuid not null references public.brands(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  ref_number      text not null unique,                       -- 'RDV-2026-0427-001'

  -- Customer
  full_name       text not null,
  phone           text not null,                              -- normalized E.164ish
  email           text not null,

  -- Vehicle
  vehicle_brand   text not null,                              -- one of the Stellantis brands
  vehicle_model   text not null,
  vin             text not null,                              -- 17 chars, exclude I/O/Q

  -- Intervention
  intervention_type public.intervention_type not null,
  city            text not null,
  preferred_date  date not null,
  preferred_slot  public.appointment_slot not null,
  comment         text,

  -- Compliance
  cndp_consent_at timestamptz not null,
  source          text not null default 'chatbot',            -- 'chatbot' / 'crc' / future channels

  status          public.appointment_status not null default 'new',
  notes           text,                                       -- internal CRC notes
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_appts_brand on public.service_appointments(brand_id, created_at desc);
create index if not exists idx_appts_status on public.service_appointments(brand_id, status);
create index if not exists idx_appts_ref on public.service_appointments(ref_number);
create index if not exists idx_appts_vin on public.service_appointments(vin);

drop trigger if exists trg_appts_touch on public.service_appointments;
create trigger trg_appts_touch before update on public.service_appointments
  for each row execute function public.touch_updated_at();

alter table public.service_appointments enable row level security;
-- service-role only (no anon policy = anon blocked, matches existing tables)

-- ─── Complaints (Réclamation) ──────────────────────────────────────────────
create type public.complaint_status as enum (
  'new',
  'qualified',     -- CRC qualified (urgency / legitimacy / dedup)
  'assigned',      -- routed to concerned site
  'in_progress',   -- under treatment
  'resolved',
  'closed_no_resolution'
);

create table if not exists public.complaints (
  id              uuid primary key default gen_random_uuid(),
  brand_id        uuid not null references public.brands(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  ref_number      text not null unique,                       -- 'REL-2026-0427-001'

  -- Customer
  full_name       text not null,
  phone           text not null,
  email           text not null,

  -- Vehicle
  vehicle_brand   text not null,
  vehicle_model   text not null,
  vin             text not null,

  -- Concerned intervention
  intervention_type public.intervention_type not null,
  site            text not null,                              -- atelier / city where the issue happened
  service_date    date,                                       -- date of the original intervention if known

  -- Reason
  reason          text not null,                              -- min 20 chars per spec
  attachment_url  text,                                       -- optional photo / doc

  -- Compliance
  cndp_consent_at timestamptz not null,
  source          text not null default 'chatbot',

  status          public.complaint_status not null default 'new',
  crc_notes       text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_complaints_brand on public.complaints(brand_id, created_at desc);
create index if not exists idx_complaints_status on public.complaints(brand_id, status);
create index if not exists idx_complaints_ref on public.complaints(ref_number);
create index if not exists idx_complaints_vin on public.complaints(vin);

drop trigger if exists trg_complaints_touch on public.complaints;
create trigger trg_complaints_touch before update on public.complaints
  for each row execute function public.touch_updated_at();

alter table public.complaints enable row level security;


-- ════════════════════════════════════════════════════════════════
-- supabase/migrations/00005_lead_email.sql
-- ════════════════════════════════════════════════════════════════
-- ─── Lead email capture ────────────────────────────────────────────────────
-- Clients reported the chat doesn't ask for an email during test-drive /
-- showroom-visit booking. We're adding it as an OPTIONAL field (the bot can
-- still book without one if the customer refuses). Mirrored in `leads`
-- (dealer-facing record) and `conversations` (admin transcript view's lead
-- summary). Salesforce already accepts email — just needed the storage path.

alter table public.leads
  add column if not exists email  text;

alter table public.conversations
  add column if not exists lead_email     text,
  add column if not exists captured_email timestamptz;



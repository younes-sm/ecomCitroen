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

# Jeep Maroc Chatbot (NARA) — Production Report

**Date:** 2026-06-25
**Scope:** Prod widget on `chatbot.jeep.ma` (embedded in jeep.com footer)
**Data window:** 3 days (2026-06-23 → 06-25), brand `jeep-ma`
**Source:** Supabase project `payayakinqiyhywupxjt`

---

## 1. Executive summary

The chatbot is **functional and converting on chat** — the core sales flow (discover → recommend → collect → book) works end-to-end and produced **3 real test-drive leads in 3 days** (after removing duplicates). The main problems are (a) **reliability/data-quality bugs** that inflated and corrupted the records (duplicate leads, missing transcripts, tool-syntax leaks), (b) a **very high voice-abandonment rate** (visitors open the call and leave before speaking), and (c) **voice converts 0 leads** — all 3 leads came from chat. Most reliability bugs were fixed this session; the highest-value remaining work is the **post-booking conversation loop**, the **voice open→speak drop-off**, and **voice not converting at all**.

| Metric (3 days) | Value |
|---|---|
| Conversations | **59** (45 voice · 14 chat) |
| Engaged (≥1 message) | 28 |
| Empty (opened & abandoned) | **31** (all voice) |
| **Real leads** (after dedup) | **3** test-drive · 1 service appointment · 0 complaints |
| `book_test_drive` tool fires | 11 (re-fires → only 3 unique leads, see §3 dup bug) |
| Lead source | **3/3 from chat · 0 from voice** |
| Lead rate (of engaged) | **~11%** (3/28) |
| Languages | Darija 24 · French 14 · English 10 · Arabic 11 |

---

## 2. What's good ✅

- **Core sales funnel works on chat.** Discovery → model recommendation (with price + image) → CNDP consent → `book_test_drive` completes reliably. The 3 confirmed leads (Younès, khalid, Manal) all came through **chat**.
- **Chat conversion is reasonable** (~11% of engaged, and all 3 leads came from just 14 chat sessions — chat is the productive channel).
- **Multilingual in the wild** — real traffic in Darija, French, Arabic, English; the agent handles all four.
- **Salesforce is the reliable system of record.** Leads/cases push to Stellantis CRM independently of Supabase, so lead delivery survives DB issues.
- **Tool coverage is being used** — `show_model_image` (36), `request_input` (37), `find_showrooms` (6), `open_financing` (4), `book_test_drive` (11), plus APV (`book_service_appointment`, `submit_complaint`).
- **Good guardrails already in place** — CNDP two-gate consent, stalled-booking server-side recovery, image-without-CTA recovery, maison-dedup.

---

## 3. Issues observed in the prod test conversations 🔍

The concrete problems seen in real test sessions. **Evidence source** is marked: 🗄️ **DB** = confirmed in the transcripts/data fetched from `payayakinqiyhywupxjt` (this 3-day window); 📸 **Screenshot** = seen in a screenshot during testing but **not present in the fetched DB** (likely the old Supabase project or an unpersisted live test).

| # | Issue | Severity | Source | Status |
|---|---|---|---|---|
| 1 | **Duplicate leads** — Younès booking created 8 identical lead rows (re-fired `book_test_drive`) | Critical | 🗄️ DB | ✅ fixed (dedup) |
| 2 | **Post-booking loop** — after booking, *"Et le financement"* → agent repeats *"Dans quelle ville…"* 6+× and re-fires the tool | Critical | 🗄️ DB | ⚠️ open |
| 3 | **Voice converts 0 leads** — 45 voice sessions, 0 bookings (all 3 leads were chat) | Critical | 🗄️ DB | ⚠️ open |
| 4 | **Voice opened then abandoned** — 31 voice calls closed in 1–27s with no speech | High | 🗄️ DB | ⚠️ open |
| 5 | **Wrong brand** — Jeep chat recommended Citroën `c3-aircross` as "Rihla" | High | 📸 Screenshot | ✅ fixed (Jeep fallback) |
| 6 | **Tool syntax leaked** — `"phone"}`, `<call:default_api:request_input{…}>` shown to user | High | 📸 Screenshot | ✅ fixed (sanitizer) |
| 7 | **Invalid phones accepted** — `08100299`, `0654` | High | 📸 Screenshot | ✅ fixed (validation) |
| 8 | **Name asked 2–3×** — "nom et prénom" → "prénom" → "nom de famille" | High | 🗄️ DB | ✅ fixed (collected-state guard) |
| 9 | **Empty-response fallback** — *"oui"* → canned *"Comment puis-je vous aider…"* | Medium | 🗄️ DB | ✅ fixed (retry + no thinking) |
| 10 | **Showrooms re-listed after CNDP consent** | Medium | 📸 Screenshot | ✅ fixed (suppress on consent turn) |
| 11 | **Hallucinated name** — addressed Younès as "Lucie" | Medium | 🗄️ DB | ⚠️ open |
| 12 | **Financing never answered** — repeated *"Et le financement"*, agent only opens page / pushes essai | Medium | 🗄️ DB | ⚠️ open |
| 13 | **Missing agent turns** in some transcripts (chat fire-and-forget; voice best-effort) | Medium | 🗄️ DB | ✅ fixed for chat |

**Tally:** 9 confirmed in the fetched DB · 4 from screenshots (not in this DB). 8 fixed (pending deploy) · 5 open (#2, #3, #4, #11, #12).
*Full evidence + transcript quotes: [prod-test-conversation-issues.md](prod-test-conversation-issues.md).*

---

## 4. Issues found & fixed this session 🛠️

| Area | Problem | Fix |
|---|---|---|
| **Voice** | Agent repeated its turn / talked over the user (echo loop — browser AEC doesn't cancel Web-Audio output) | Half-duplex mic gating (mute mic while agent speaks) |
| **Chat** | Empty model turns → canned *"Comment puis-je vous aider…"* after "oui" | Retry-on-empty + disabled `thinking` (the empty-turn cause) |
| **Chat model** | Hard-coded model, stale comment | `RIHLA_CHAT_MODEL` env var (now `gemini-3.5-flash`) |
| **Performance** | Widget + every chat turn blocked ~7s on Supabase (`getBrandContext`) | Brand context + showrooms served **local-first** (no DB in request path); transcript writes moved off the hot path |
| **Chat UX** | Tool calls leaked as text (`{"field":"phone"}`, `<call:default_api:request_input{…}>`) | Hardened FE sanitizer for all leak formats |
| **Lead quality** | No Moroccan phone validation (`0654`, `08100299` accepted) | Client-side validation: `06/07`+8 digits or `+212`; tells user the correct format |
| **Flow** | Agent re-asked the name 2–3× (and phone) | Broadened state-detection + injected "ALREADY COLLECTED — do not re-ask" block per turn |
| **CNDP** | After consent, agent re-showed the showroom list | Suppress `find_showrooms` on a consent-confirm turn |
| **Persistence** | Assistant turns missing from transcripts (fire-and-forget after stream close was frozen on serverless) | Use Next `after()` so writes complete |
| **Data** | **Duplicate leads** (same customer ×8) from re-fired `book_test_drive` | Per-conversation idempotency in `captureLeadFromBooking` |
| **Branding** | A Jeep chat once recommended Citroën `c3-aircross` as "Rihla" (fell back to Citroën) | Fallback + default brand changed to **Jeep/NARA** |
| **Security** | Base URL exposed a multi-brand demo selector + Citroën storefront + admin | `middleware.ts` lockdown — only `/w/jeep-ma` + APIs public; admin password-gated |
| **Session** | Conversation lost on every page navigation (footer iframe reloads) | Persist + restore chat transcript via `localStorage` (chat only) |
| **Bug** | Hydration mismatch from reading `localStorage` during render | Restore in a post-mount effect (SSR-safe) |

> ⚠️ **All of the above is committed locally but NOT yet deployed to `chatbot.jeep.ma`.** A redeploy is required for any of it to take effect. Current prod data reflects the *old* code.

---

## 5. What to improve 🔧 (prioritized)

### P0 — Highest impact

1. **Post-booking conversation loop.** After a successful booking, a follow-up question (e.g. *"Et le financement ?"*) makes the agent restart the test-drive flow — repeatedly re-asking the city and re-firing `book_test_drive` (this is what produced the 8 duplicate Younès leads). The dedup fix stops duplicate *rows*, but the agent still loops conversationally and even hallucinated a wrong name ("Lucie"). **Fix the behavior:** once a booking is confirmed, answer follow-ups (financing, hours, another model) instead of re-entering data collection.

2. **Voice converts 0 leads + huge drop-off.** Voice had **45 sessions and produced 0 leads**; 31 were abandoned in 1–27s before any speech, and even the engaged voice calls didn't book. Voice is currently the **worst-performing channel** despite being the majority of traffic. Investigate the open→speak friction (mic permission, connect latency, unclear "you can speak now" cue) AND why engaged voice calls don't reach a booking. A visible "connecting…/listening…" state + text fallback would help. Until fixed, chat is carrying all conversions.

### P1 — Data quality & tracking

3. ~~**Lead ↔ conversation status mismatch.**~~ ✅ Resolved by the lead-dedup fix + cleanup — now 3 leads = 3 `closed_lead` conversations, consistent.
4. **Apply the same dedup to APV.** `book_service_appointment` / `submit_complaint` mint a new `ref_number` per call — same re-fire risk as leads. Add per-conversation idempotency proactively.
5. **Voice transcript gaps.** The opening greeting and some turns aren't always persisted for voice (best-effort). Make voice persistence reliable (mirror the `after()` approach where applicable).

### P2 — Polish

6. **Locale code inconsistency.** Voice stores `fr`/`ar`/`en`/`darija`; chat stores `fr-MA`/`ar-MA`/`en-MA`. Normalize so dashboard grouping is clean.
7. **Supabase health.** The old project was ~7s/query. The new project should be in a region close to the deployment and on a paid tier — keeps the admin dashboard fast (the chatbot no longer depends on it, but the dashboard reads it).
8. **Hallucinated names** (e.g. "Lucie"). Tighten the prompt to always use the captured `firstName` (the "ALREADY COLLECTED" block helps; verify in voice too).
9. **Production hardening (longer term).** The Google API key is shipped to the browser for the voice WebSocket — move to an ephemeral-token proxy so the key can't be extracted and used to drain the concurrent-session quota.

---

## 6. Cost & capacity notes

- **Chat** runs on `gemini-3.5-flash` (REST) — bounded by RPM/TPM, not Live sessions.
- **Voice** runs on `gemini-3.1-flash-live-preview` — bounded by **concurrent Live sessions** (per Google Cloud project; check AI Studio for the exact tier limit). Audio-only calls are capped at ~15 min by Google.
- Rough per-call cost (voice): audio output ($12/1M tok @ 25 tok/s) dominates; a ~2-min booking call ≈ $0.05–0.06. Chat turns are cheap (~$0.001–0.01).

---

## 7. Suggested next steps

1. **Deploy** the committed batch to `chatbot.jeep.ma` (fixes duplicates, persistence, leaks, lockdown, speed).
2. Run the **cleanup SQL** to collapse existing duplicate leads.
3. Fix the **post-booking loop** (P0-1) and **investigate voice drop-off** (P0-2).
4. Re-pull metrics after a few days: `pnpm exec tsx scripts/report-conversations.ts 7`.

*Reports generated via `scripts/report-conversations.ts` and `scripts/dump-transcripts.ts`.*

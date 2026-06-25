# Issues Found in Prod Test Conversations

**Window:** 2026-06-23 → 06-25 · brand `jeep-ma` · 59 conversations (45 voice / 14 chat)
**Source:** real transcripts + Supabase data from `chatbot.jeep.ma`

Only issues actually observed in the test conversations are listed here (symptoms, with evidence). Status = whether a fix already landed in code this session (not yet deployed).

**Evidence source** is marked per issue:
- 🗄️ **DB** — confirmed in the transcripts/data fetched from `payayakinqiyhywupxjt` (this window).
- 📸 **Screenshot** — observed in a screenshot during the session but **NOT present in the fetched transcripts** (likely the old Supabase project or an unpersisted live test). Real, but not verified against this DB.

---

## Critical

### 1. Duplicate leads (same customer ×8) — 🗄️ DB
- **Seen:** Younès booking created **8 identical lead rows** (avenger / Bouskoura / samedi matin) in the leads dashboard.
- **Cause:** the agent re-fired `book_test_drive` on multiple turns; each call inserted a new lead.
- **Status:** ✅ fixed (per-conversation dedup) — real leads now 3, not 11.

### 2. Post-booking loop — 🗄️ DB
- **Seen (Younès chat):** after the booking succeeded, the user asked *"Et le financement"* repeatedly; NARA got stuck repeating *"Très bien. Dans quelle ville préférez-vous l'essai routier ?"* 6+ times and re-firing the booking tool.
- **Impact:** confusing dead-end + the duplicate leads above.
- **Status:** ⚠️ open — agent should answer follow-ups after a booking, not restart data collection.

### 3. Voice converts 0 leads — 🗄️ DB
- **Seen:** 45 voice sessions → **0 bookings**. All 3 leads came from chat.
- **Status:** ⚠️ open — needs investigation (engaged voice calls don't reach a booking).

---

## High

### 4. Voice opened then abandoned — 🗄️ DB
- **Seen:** 31/59 conversations are voice calls closed in **1–27s with no speech** (rapid clusters, e.g. `06-25 11:24` ×4).
- **Cause:** conversation row is created at connect, before speaking; visitors open and leave.
- **Status:** ⚠️ open — reduce open→speak friction (mic permission / "you can speak now" cue).

### 5. Wrong brand in a Jeep chat — 📸 Screenshot (not in fetched DB)
- **Seen:** a Jeep conversation recommended Citroën **`c3-aircross`** and used agent name **"Rihla"** (not NARA).
- **Cause:** brand didn't resolve → fell back to Citroën catalog.
- **Status:** ✅ fixed (fallback + default brand → Jeep/NARA).

### 6. Tool syntax leaked into the chat bubble — 📸 Screenshot (not in fetched DB)
- **Seen:**
  - `"phone"}`
  - `<call:default_api:request_input{field:email}?>Je note votre numéro…`
  - `Action: open model slug=c3-aircross` shown to user
- **Status:** ✅ fixed (hardened sanitizer for all leak formats).

### 7. Invalid phone numbers accepted — 📸 Screenshot (not in fetched DB)
- **Seen:** `08100299` (8 digits, wrong prefix) and `0654` (4 digits) accepted as the mobile.
- **Status:** ✅ fixed (Moroccan validation + correct-format message).

### 8. Name asked repeatedly — 🗄️ DB
- **Seen (APV):** *"Tapez votre nom et prénom"* → later *"Tapez votre prénom"* → later *"Tapez votre nom de famille"* — same person asked 2–3×.
- **Status:** ✅ fixed (state detection + "already collected" guard).

---

## Medium

### 9. Empty-response fallback after "oui" — 🗄️ DB
- **Seen:** after a recommendation, the user said *"oui"* and got the canned *"Comment puis-je vous aider à partir de là ?"* / *"Got it. How can I help from here?"*.
- **Status:** ✅ fixed (retry-on-empty + thinking disabled).

### 10. Showrooms re-listed after CNDP consent — 📸 Screenshot (not in fetched DB)
- **Seen:** user said *"oui je confirme"* to the consent question → the showroom cards reappeared instead of a booking confirmation (lead still saved).
- **Status:** ✅ fixed (suppress `find_showrooms` on a consent-confirm turn).

### 11. Hallucinated customer name — 🗄️ DB
- **Seen (Younès chat):** in the post-booking loop, NARA addressed the customer as **"Lucie"**.
- **Status:** ⚠️ open (partially mitigated by the "already collected" name block; verify in voice).

### 12. Financing question never answered — 🗄️ DB
- **Seen (Younès chat):** user asked *"Et le financement / mensualités"* several times; agent only opened the financing page / pushed the essai, never gave figures.
- **Status:** ⚠️ open — decide whether NARA should answer financing or only hand off.

### 13. Missing agent turns in transcripts — 🗄️ DB
- **Seen:** some conversations stored only USER messages; voice greeting + some turns not persisted.
- **Status:** ✅ fixed for chat (`after()` persistence); voice persistence still best-effort.

---

## Summary

| Status | Count | Issues |
|---|---|---|
| ✅ Fixed (pending deploy) | 8 | #1, #5, #6, #7, #8, #9, #10, #13(chat) |
| ⚠️ Open | 5 | #2 post-booking loop · #3 voice 0 leads · #4 voice abandonment · #11 hallucinated name · #12 financing answers |

> All fixes are committed locally but **not yet on prod** — these symptoms persist on `chatbot.jeep.ma` until redeploy.

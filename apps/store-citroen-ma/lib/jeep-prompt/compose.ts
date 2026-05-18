// Compose the Jeep system prompt by routing on intent. Loads ONLY the flow
// module the customer's intent matches — discovery turns get neither sales
// nor APV flow rules, so the agent stays light and asks before committing.
//
// Intent precedence:
//   explicit `intent` arg > classifier(history) > "discovery" (default)
//
// Common modules (persona, language, turn-shape, cndp, data, closing) are
// always loaded. Per-turn token budget targets:
//   discovery   ≈ 6k tokens   (persona + language + turn-shape + cndp + data + closing)
//   sales       ≈ 7.5k        (+ sales-flow)
//   apv-rdv     ≈ 8k          (+ apv-rdv-flow)
//   apv-complaint ≈ 7.5k      (+ apv-complaint-flow)
//
// Compare against the legacy monolithic prompt which sat at ~25k per turn.

import { persona } from "./01-persona";
import { LANGUAGE } from "./02-language";
import { TURN_SHAPE } from "./03-turn-shape";
import { CNDP } from "./04-cndp";
import { DATA } from "./05-data";
import { SALES_FLOW } from "./06-sales-flow";
import { APV_RDV_FLOW } from "./07-apv-rdv-flow";
import { APV_COMPLAINT_FLOW } from "./08-apv-complaint";
import { CLOSING } from "./09-closing";
import { GUARDRAILS } from "./10-guardrails";
import { classifyIntent, type ClassifierMessage, type Intent } from "./classifier";

export type ComposeOptions = {
  todayIso: string;
  todayHumanFr: string;
  /** Optional explicit intent override — bypasses the classifier when set. */
  intent?: Intent;
  /** Conversation history for classification. Only used when `intent` is omitted. */
  history?: ClassifierMessage[];
  /**
   * `chat` (default) loads only the matching flow module — minimal per-turn
   * token cost, since chat re-composes the prompt every turn.
   *
   * `voice` loads ALL flow modules at once. The voice WebSocket sends the
   * system instruction ONCE at session start with no history, so we can't
   * re-classify mid-call — the model needs every flow's rules available
   * upfront. Without this the model walks an APV customer through the
   * SALES field list (no VIN) or vice versa.
   */
  mode?: "chat" | "voice";
};

export type ComposeResult = {
  prompt: string;
  intent: Intent;
};

export function composeJeepPrompt(opts: ComposeOptions): ComposeResult {
  const mode = opts.mode ?? "chat";
  const intent = opts.intent ?? classifyIntent(opts.history);

  const sections: string[] = [
    persona({ todayIso: opts.todayIso, todayHumanFr: opts.todayHumanFr }),
    LANGUAGE,
    TURN_SHAPE,
    CNDP,
    DATA,
    GUARDRAILS,
    CLOSING,
  ];

  if (mode === "voice") {
    // Voice — load all flows so the model has rules for whatever path
    // the customer takes after the opener. The intent classifier is
    // useless here because the WebSocket sends the prompt once with no
    // history.
    sections.push(VOICE_INTENT_ROUTER, SALES_FLOW, APV_RDV_FLOW, APV_COMPLAINT_FLOW);
  } else if (intent === "sales") sections.push(SALES_FLOW);
  else if (intent === "apv-rdv") sections.push(APV_RDV_FLOW);
  else if (intent === "apv-complaint") sections.push(APV_COMPLAINT_FLOW);
  else {
    // chat + discovery — let the agent ASK the customer for their intent
    // before committing. The next turn's classifier will route correctly
    // once the customer's first sentence carries a clear signal.
    sections.push(DISCOVERY_HINT);
  }

  return {
    prompt: sections.join("\n\n"),
    intent,
  };
}

const VOICE_INTENT_ROUTER = `
## Intent routing — pick the right flow from the customer's first message

Three flows are loaded below. **Pick exactly one** based on the customer's first substantive message, then follow that flow's field-collection order strictly. Never mix the field lists.

  • **SALES** flow — for customers who want to BUY / TEST DRIVE / VISIT a maison. Triggers: "essai", "test drive", "بغيت نشري", "j'ai besoin d'acheter", "I want to buy", "visite", "زيارة". Collects: \`firstName · phone · email · model · city · maison · slot\`. NEVER asks for a VIN.

  • **APV-RDV** flow — for customers who want service / repair on their existing Jeep. Triggers: "vidange", "révision", "service rapide", "panne", "voyant", "ma voiture est en panne", "rendez-vous atelier", "بغيت rendez-vous ف l'atelier", "الطوموبيل ديالي ما خدماش". Collects: \`firstName · phone · email · VIN · model · interventionType · city · maison · date · slot\`. **ALWAYS asks for the VIN** before city — the dossier needs the chassis number to identify the car. Without VIN the APV ticket is unworkable.

  • **APV-Réclamation** flow — for customers filing a formal complaint about a previous service or experience. Triggers: "réclamation", "porter plainte", "mécontent", "كنشكي". Collects: \`firstName · phone · email · VIN · model · interventionType · site · serviceDate · reason\`.

If the customer's first message mentions BOTH a model name AND a service trigger ("j'ai un Avenger et je veux faire la vidange"), the SERVICE trigger wins — go APV-RDV, not SALES. The model name is captured as \`vehicleModel\` for the APV ticket.

If the customer's first message is ambiguous, ask ONCE: "Vous voulez tester ou acheter une Jeep, ou bien il s'agit d'un rendez-vous atelier ?" — never assume.

## CRITICAL FOR VOICE — never announce a booking without firing the tool

In voice mode, the most-flagged production bug is the **fake confirmation**: agent says "موعدك مسجل" / "votre demande est enregistrée" / "your appointment is registered" but never calls \`book_service_appointment\` / \`book_test_drive\` / \`book_showroom_visit\` / \`submit_complaint\`. The data NEVER reaches Salesforce. The customer thinks it succeeded; nothing happened. This is a CRITICAL FAILURE.

**Hard rule for every voice turn**: if you are about to say ANY of these confirmation phrases, the SAME response MUST also fire one of the four booking tools:
  - "موعدك مسجل" / "تم تسجيل الطلب" / "الطلب ديالك مسجل" / "كنصيفط ل la maison"
  - "Votre demande est enregistrée" / "C'est noté" / "Je transmets votre demande"
  - "Your request is registered" / "Your appointment is saved" / "A commercial will call you back"
  - "Un commercial vous rappellera" — without a tool call this is meaningless because no commercial knows about the customer.

The expected sequence inside the SAME response, after the CNDP-yes:
  1. Short pre-tool sentence: "ممتاز Younes، كنصيفط الطلب ديالك ل la maison."
  2. **Tool call** — \`book_service_appointment\` for APV-RDV, with EVERY field collected from the conversation: \`fullName\` · \`phone\` · \`email\` · \`vehicleBrand="Jeep"\` · \`vehicleModel\` · \`vin\` · \`interventionType\` · \`city\` · \`preferredDate\` (YYYY-MM-DD) · \`preferredSlot\` · \`cndpConsent=true\`.
  3. Post-tool sentence reading the reference number digit-by-digit ("ريفيرونص ديالك هي ر د ف — ٢٠٢٦٠٥١٨ — ٠٤٢"), then "anything else?".

If you produced the post-tool sentence WITHOUT the tool call, you have failed this step. Re-anchor: stop, ask for the missing field, then fire the tool. NEVER announce a booking that didn't happen.

## Mandatory CNDP gates before ANY booking tool fires

The two gates from the CNDP module are non-negotiable: **recap turn → CNDP question turn → tool call**. Never compress them into one turn, never skip the recap, never call the tool without asking the CNDP question. The customer's explicit "واخا" / "oui" / "yes" to the CNDP question is what sets \`cndpConsent=true\`.

If the customer says no to CNDP, do NOT call the tool, do NOT say "demande enregistrée" — fire the rejection script (see CNDP module) and head to the CRC 3858 closing.

## Speech-recognition failures — re-ask, never invent

Voice STT occasionally produces gibberish: the customer speaks Arabic/Darija but the transcript comes through as Korean ("지진 속보를 확인해"), Portuguese ("Aí, é?"), German ("Man ist Auto", "das Surfen sehen"), or other unrelated languages. These are mistranscriptions, NOT the customer's actual words.

Detection — the user message is a gibberish transcription when any of these hold:
  • The text is in a script (Korean, Cyrillic, CJK) that does not match the conversation language.
  • The text is short Portuguese / German / Italian / Spanish unrelated to cars or the question asked, mid-Arabic / Darija / French conversation.
  • The text doesn't fit ANY expected answer pattern for the field you just asked about.

Action when you detect gibberish:
  ✓ Re-ask the same question gently, once:
    - FR: "Désolé, je n'ai pas bien entendu. Pourriez-vous répéter ?"
    - Darija: "سمح ليا، ما سمعتش مزيان. عاود قولها عافاك ؟"
    - AR: "عذرًا، لم أسمع جيدًا. هل يمكنكم الإعادة ؟"
    - EN: "Sorry, I didn't catch that. Could you repeat?"

Forbidden — never invent the customer's answer to plug a gibberish reply:
  ✗ Treat gibberish as a yes to CNDP and fire the booking tool.
  ✗ Treat gibberish after "what city ?" as "Casablanca" by default.
  ✗ Treat gibberish after a maison list as a maison pick.
  ✗ Treat gibberish after "what date ?" as "tomorrow".
  ✗ Treat gibberish as a successful re-ask of the VIN (the previous VIN may have been invalid — don't pretend it was confirmed).

## Don't auto-pick a maison after listing — wait for the customer

In multi-maison cities (Casablanca = 3, Marrakech = 2), after you list the maisons and ask "which one suits you?", **WAIT for the customer's explicit answer** before moving to the date. Banned: in the very next turn, saying "let's book at Maniss Auto" without the customer naming it. The customer's words ARE the picker.

If the customer's reply is gibberish or doesn't name a maison, re-ask once: "Désolé, laquelle préférez-vous ?" / "أي وحدة فيهم تناسبك ؟".

## Don't infer the date from a time alone

If the customer answers with only a time ("11h", "à 10 heures", "10 dalsbaH"), they have NOT given you a date. Ask explicitly: "C'est pour quel jour ?" / "أي يوم ؟" / "What day?". Never default to "today" or "tomorrow" — most service appointments are several days out.

## Tool result interpretation in voice — ok=true is ALWAYS a success

The voice route returns this exact shape from \`book_service_appointment\` / \`submit_complaint\` / \`book_test_drive\` / \`book_showroom_visit\`:
  \`{ ok: true, refNumber: "RDV-20260518-042", message: "Appointment saved. Reference: RDV-20260518-042." }\`

\`ok: true\` means the request reached Salesforce. Your post-tool sentence MUST confirm warmly and read the reference number digit-by-digit:
  ✓ FR: "Parfait Younes, votre demande est enregistrée. Référence : R, D, V, 2, 0, 2, 6, 0, 5, 1, 8 — 0, 4, 2. Un commercial de la maison Jeep vous rappellera pour confirmer le créneau."
  ✓ Darija: "مزيان Younes، الطلب ديالك مسجل. الريفيرونص : R D V 2 0 2 6 0 5 1 8 — 0 4 2. commercial من la maison Jeep غيعاود ليك باش يأكد."

NEVER say "وقع واحد المشكل" / "il y a eu un problème" / "there was an issue" when \`ok: true\` — that's a flat-out lie to the customer. The data IS in Salesforce. Failures are only when \`ok: false\` is explicitly returned.
`;

const DISCOVERY_HINT = `
## Discovery mode — ask before committing to a flow

Until the customer reveals their intent (buy / test drive / showroom visit / service appointment / complaint), stay in discovery mode:

  • Answer model / pricing / spec questions using the data tables.
  • Show car images via \`show_model_image(slug)\` the first time you mention a model.
  • List showrooms via \`find_showrooms(city)\` when a city is named.
  • After any price or spec, propose the natural next step (essai routier) — see CLOSING module.

If the customer's intent is genuinely ambiguous and you need to pick a flow, ask ONCE with a clear two-choice question:
  ✓ FR: "Vous voulez tester ou acheter une Jeep, ou bien il s'agit d'un rendez-vous atelier ?"
  ✓ Darija: "بغيتي تجرب ولا تشري شي Jeep، ولا غير rendez-vous ف l'atelier ؟"
  ✓ AR: "هل ترغبون في تجربة أو شراء سيارة Jeep، أم في حجز rendez-vous للصيانة ؟"
  ✓ EN: "Are you looking to try or buy a Jeep, or is it a service appointment?"

Do NOT collect identity fields (name, phone, email, VIN) in discovery mode. The collection order is defined in the SALES or APV flow modules and loads once the intent is clear.
`;

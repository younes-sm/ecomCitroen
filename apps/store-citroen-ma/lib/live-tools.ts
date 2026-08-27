// Gemini Live tool declarations for the voice agent.
//
// These live here — NOT in the client hook — because the Live session now runs
// in CONSTRAINED mode (BidiGenerateContentConstrained). In that mode Google
// treats the EPHEMERAL TOKEN's config as authoritative and DISCARDS whatever
// `setup` the browser sends. Verified against the live endpoint: a token that
// locked only model+modality ignored the browser's systemInstruction and tools
// entirely (the agent answered as generic Gemini and never called a tool),
// while a token carrying them honoured both.
//
// So the tool list must be baked into the token server-side, in
// /api/rihla/voice/token. Keeping it out of the client bundle is also a win:
// the tool surface is no longer published to every visitor.

import type { ToolListUnion } from "@google/genai";

// The declarations below use plain "OBJECT" / "STRING" literals (the wire
// format Gemini expects) rather than the SDK's `Type` enum, so the shape is
// asserted once here instead of enum-ifying ~17 tools by hand.
export const LIVE_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "configure_car",
        description: "Change the color, trim or angle of the car on the current page. MUST be called when user asks to change color (بدل اللون, mets en rouge).",
        parameters: {
          type: "OBJECT",
          properties: {
            slug: { type: "STRING", enum: ["c3-aircross", "c5-aircross", "berlingo"] },
            color: { type: "STRING" },
            trim: { type: "STRING" },
          },
        },
      },
      {
        name: "open_model",
        description: "Open a model detail page (بغيت نشوف, montre-moi).",
        parameters: {
          type: "OBJECT",
          properties: { slug: { type: "STRING", enum: ["c3-aircross", "c5-aircross", "berlingo"] } },
          required: ["slug"],
        },
      },
      {
        name: "start_reservation",
        description: "Open the reservation page to book this car.",
        parameters: {
          type: "OBJECT",
          properties: { slug: { type: "STRING" } },
          required: ["slug"],
        },
      },
      {
        name: "open_financing",
        description: "Open the financing advisor page or run a financing simulation.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "open_dealers",
        description: "Open the dealer locator page.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "calculate_financing",
        description: "Calculate monthly payment for a car. Call when user asks about price, mensualité, budget.",
        parameters: {
          type: "OBJECT",
          properties: {
            vehiclePrice: { type: "NUMBER" },
            downPayment: { type: "NUMBER" },
            termMonths: { type: "NUMBER" },
            annualRatePct: { type: "NUMBER" },
          },
          required: ["vehiclePrice"],
        },
      },
      {
        name: "show_model_image",
        description: "Display a photo of a specific model inline in the chat. Call when you recommend a model or the user asks to see one.",
        parameters: {
          type: "OBJECT",
          properties: {
            slug: { type: "STRING", description: "The model slug (e.g. 'wrangler', 'c3-aircross', '5008')." },
            caption: { type: "STRING", description: "Optional one-line caption shown under the image." },
          },
          required: ["slug"],
        },
      },
      {
        name: "show_model_video",
        description: "Display a video preview card for a model — opens YouTube search in a new tab. Use when user asks for a video, walk-around, or review.",
        parameters: {
          type: "OBJECT",
          properties: {
            slug: { type: "STRING", description: "The model slug." },
            caption: { type: "STRING", description: "Optional one-line caption." },
          },
          required: ["slug"],
        },
      },
      {
        name: "open_brand_page",
        description: "Open the official brand-site page for a model in a new browser tab. Use when the user wants to see more details, specs, or configure on the official site.",
        parameters: {
          type: "OBJECT",
          properties: {
            slug: { type: "STRING", description: "The model slug." },
          },
          required: ["slug"],
        },
      },
      {
        name: "book_test_drive",
        description: "Book a TEST DRIVE for a qualified lead. MANDATORY : you MUST call this tool the moment the customer says 'oui' / 'yes' / any affirmative TO THE CNDP CONSENT QUESTION (loi 09-08). NEVER respond with confirmation text alone ('Parfait, je transmets votre demande...') without ALSO calling this tool in the SAME turn — that would silently drop the lead, which is the #1 voice bug clients have flagged. Fill firstName, phone, email (if provided), city, preferredSlot, showroomName from the conversation history. CNDP consent is implicit in the customer's just-given 'oui'.",
        parameters: {
          type: "OBJECT",
          properties: {
            slug: { type: "STRING" },
            firstName: { type: "STRING" },
            phone: { type: "STRING" },
            email: { type: "STRING", description: "Customer email — optional. Ask once after phone; accept if customer prefers not to share." },
            city: { type: "STRING" },
            preferredSlot: { type: "STRING" },
            showroomName: { type: "STRING", description: "The exact showroom the customer chose from find_showrooms (e.g. 'Peugeot Riyadh — King Fahd Rd'). Verbatim." },
          },
          required: ["slug", "firstName", "phone"],
        },
      },
      {
        name: "book_showroom_visit",
        description: "Schedule a SHOWROOM VISIT (the user wants to come see the cars in person, not test-drive). MANDATORY : call this the moment the customer says 'oui' to the CNDP question. NEVER emit confirmation text without ALSO calling this tool in the same turn — that drops the lead silently.",
        parameters: {
          type: "OBJECT",
          properties: {
            slug: { type: "STRING" },
            firstName: { type: "STRING" },
            phone: { type: "STRING" },
            email: { type: "STRING", description: "Customer email — optional. Ask once after phone." },
            city: { type: "STRING" },
            preferredSlot: { type: "STRING" },
            showroomName: { type: "STRING", description: "The exact showroom the customer chose. Verbatim." },
          },
          required: ["firstName", "phone"],
        },
      },
      {
        name: "find_showrooms",
        description: "List nearby showrooms / dealers. CALL THIS whenever the user names a city ('I'm in Riyadh', 'Casablanca', 'Jeddah') or asks where to find the cars / book a visit / find a service centre. Renders a card list with names, addresses, phones, hours. After calling, briefly summarize ('I found 3 in Riyadh — would you like to visit one?').",
        parameters: {
          type: "OBJECT",
          properties: {
            city: { type: "STRING", description: "City name as the user said it. Empty/undefined to list all showrooms." },
          },
        },
      },
      {
        name: "end_call",
        description: "END THE CALL — call this IMMEDIATELY after your closing line whenever the user signals they're done. Triggers (any language, partial match): 'bye', 'goodbye', 'thanks', 'thank you', 'au revoir', 'merci', 'à bientôt', 'bonne journée', 'salut', 'شكرا', 'شكراً', 'بسلامة', 'في أمان الله', 'مع السلامة', 'يالله', 'يالاه', 'صافي', 'خلاص', 'تمام', 'تسلم', 'الله يعطيك العافية'. ALSO call after a successful book_test_drive + farewell. Never continue after a farewell — end_call is the only valid response.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "request_input",
        description: "MANDATORY in voice — open the on-screen keyboard whenever you ask the customer to type a sensitive field (name, phone, email, VIN). Voice dictation is refused for these 4 fields. Call on the SAME turn as your text instruction ('Tapez votre prénom, …'). For VIN, this also surfaces the carte-grise camera + upload buttons.",
        parameters: {
          type: "OBJECT",
          properties: {
            field: { type: "STRING", enum: ["name", "phone", "email", "vin"] },
          },
          required: ["field"],
        },
      },
      // ─── APV (after-sales) — Jeep widget only. Never call for other brands. ───
      {
        name: "lookup_vin",
        description: "APV ONLY. Look up a customer by VIN to pre-fill the form. Call as soon as the customer says their VIN (17 alphanumeric chars).",
        parameters: {
          type: "OBJECT",
          properties: { vin: { type: "STRING" } },
          required: ["vin"],
        },
      },
      {
        name: "book_service_appointment",
        description: "APV ONLY. MANDATORY : call this tool the moment the customer says 'oui' / 'yes' / any affirmative to the CNDP question. NEVER emit confirmation text ('Parfait, je transmets...') without ALSO calling this tool in the SAME turn — that drops the lead silently. Set cndpConsent=true (the customer just gave it).",
        parameters: {
          type: "OBJECT",
          properties: {
            fullName: { type: "STRING" },
            phone: { type: "STRING" },
            email: { type: "STRING" },
            vehicleBrand: { type: "STRING" },
            vehicleModel: { type: "STRING" },
            vin: { type: "STRING" },
            interventionType: { type: "STRING", enum: ["service_rapide", "mechanical", "bodywork"] },
            city: { type: "STRING" },
            preferredDate: { type: "STRING" },
            preferredSlot: { type: "STRING", enum: ["morning", "afternoon"] },
            comment: { type: "STRING" },
            cndpConsent: { type: "BOOLEAN" },
          },
          required: ["fullName", "phone", "email", "vehicleBrand", "vehicleModel", "vin", "interventionType", "city", "preferredDate", "preferredSlot", "cndpConsent"],
        },
      },
      {
        name: "submit_complaint",
        description: "APV ONLY. MANDATORY : call this the moment the customer says 'oui' to the CNDP question. NEVER emit confirmation text without ALSO calling this tool in the same turn — that drops the complaint silently. Set cndpConsent=true. vin / vehicleModel / interventionType are OPTIONAL — only fill them for a complaint about a vehicle or a service/repair; OMIT them for a complaint about staff behaviour, reception, pricing, or wait time.",
        parameters: {
          type: "OBJECT",
          properties: {
            fullName: { type: "STRING" },
            phone: { type: "STRING" },
            email: { type: "STRING" },
            vehicleBrand: { type: "STRING" },
            vehicleModel: { type: "STRING" },
            vin: { type: "STRING" },
            interventionType: { type: "STRING", enum: ["service_rapide", "mechanical", "bodywork"] },
            site: { type: "STRING" },
            serviceDate: { type: "STRING" },
            reason: { type: "STRING" },
            attachmentUrl: { type: "STRING" },
            cndpConsent: { type: "BOOLEAN" },
          },
          required: ["fullName", "phone", "email", "vehicleBrand", "site", "reason", "cndpConsent"],
        },
      },
    ],
  },
] as unknown as ToolListUnion;

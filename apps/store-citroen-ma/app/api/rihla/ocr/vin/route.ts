// OCR endpoint for VIN extraction from a Moroccan carte grise photo or upload.
// Used by the chat / voice widget when the agent asks for the chassis number.
//
// Why a dedicated route: voice transcription corrupts a 17-char alphanumeric
// VIN, and typing 17 chars on mobile is painful. Customers carry their carte
// grise in their wallet — snapping it is the path of least friction.
//
// Pipeline:
//   1. Receive a JPEG / PNG / WebP image (multipart form, field "image").
//   2. Send it to Gemini 2.5 Flash with a tight VIN-extraction prompt.
//   3. Validate the result is 17 alphanumeric characters.
//   4. Return { vin, confidence } — the widget shows a preview and lets the
//      user confirm before sending it to the agent via [FIELD_TYPED].

import { NextRequest } from "next/server";
import { GoogleGenAI } from "@google/genai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Accept ANY 17 alphanumeric characters. We deliberately do NOT enforce the
// "no I/O/Q" ISO rule — Moroccan carte grise chassis numbers in the field do
// contain those letters, and rejecting them lost real customers. Read what's
// printed, return 17 characters.
const VIN_REGEX = /^[A-Z0-9]{17}$/;
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB
const ALLOWED_MIME = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic"]);

const SYSTEM_PROMPT = `You are an OCR assistant. Extract the VIN (numéro de châssis) from a photo of a Moroccan carte grise (vehicle registration card).

The VIN is exactly 17 alphanumeric characters (letters A-Z and digits 0-9). Read EXACTLY what is printed on the card. Do NOT reject or alter any character — if the card shows an O, a Q, or an I, return it as-is. There is no forbidden-character rule. Your only job is to transcribe the 17 characters faithfully.

On a Moroccan carte grise the VIN appears on a line labeled one of: "N° de série", "Numéro de série", "N° du châssis", "Châssis", "Chassis", "VIN", "رقم الهيكل", "السلسلة".

Reply with a JSON object only, no prose:
{ "vin": "<17-char VIN or null>", "confidence": "high" | "medium" | "low", "reason": "<short explanation if vin is null or low confidence>" }

Rules:
- If you can read 17 unambiguous characters [A-Z0-9], return them as vin with confidence "high". Letters I, O, Q are perfectly valid — never flag them, never return null because of them.
- If the photo is blurry, partial, or you have to guess any character, return your best guess with confidence "medium" or "low".
- If the photo doesn't look like a vehicle registration card, return vin: null with a short reason.
- Strip any spaces, dashes, or punctuation from the VIN before returning.
- NEVER invent characters. If a character is unreadable, prefer confidence "low" with your best guess over silently guessing.`;

type VinExtractionResult = {
  vin: string | null;
  confidence: "high" | "medium" | "low";
  reason?: string;
};

export async function POST(req: NextRequest) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return Response.json(
      { ok: false, error: "GOOGLE_API_KEY not configured" },
      { status: 500 }
    );
  }

  let imageBuffer: Buffer;
  let mimeType: string;
  try {
    const form = await req.formData();
    const file = form.get("image");
    if (!(file instanceof File)) {
      return Response.json(
        { ok: false, error: "missing 'image' field (expected a file)" },
        { status: 400 }
      );
    }
    if (file.size > MAX_BYTES) {
      return Response.json(
        { ok: false, error: `image too large (max ${MAX_BYTES / 1024 / 1024} MB)` },
        { status: 413 }
      );
    }
    mimeType = file.type || "image/jpeg";
    if (!ALLOWED_MIME.has(mimeType.toLowerCase())) {
      return Response.json(
        { ok: false, error: `unsupported MIME type: ${mimeType}` },
        { status: 415 }
      );
    }
    imageBuffer = Buffer.from(await file.arrayBuffer());
  } catch (err) {
    return Response.json(
      { ok: false, error: `failed to parse image: ${(err as Error).message}` },
      { status: 400 }
    );
  }

  console.log(
    `[ocr/vin] → received image type=${mimeType} bytes=${imageBuffer.length}`
  );

  const ai = new GoogleGenAI({ apiKey });

  let parsed: VinExtractionResult;
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            { text: SYSTEM_PROMPT },
            { inlineData: { mimeType, data: imageBuffer.toString("base64") } },
          ],
        },
      ],
      config: {
        temperature: 0,
        responseMimeType: "application/json",
      },
    });
    const text = response.text ?? "";
    parsed = JSON.parse(text) as VinExtractionResult;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ocr/vin] ✗ Gemini call failed: ${msg}`);
    return Response.json(
      { ok: false, error: `OCR call failed: ${msg.slice(0, 140)}` },
      { status: 502 }
    );
  }

  // Sanity-check + canonicalize the VIN.
  let vin = parsed.vin?.toUpperCase().replace(/[^A-Z0-9]/g, "") ?? null;
  let confidence = parsed.confidence ?? "low";
  if (vin && !VIN_REGEX.test(vin)) {
    console.warn(`[ocr/vin] extracted "${vin}" failed regex — downgrading`);
    confidence = "low";
  }

  console.log(
    `[ocr/vin] ✓ extracted vin=${vin ?? "(null)"} confidence=${confidence}${parsed.reason ? ` reason=${parsed.reason}` : ""}`
  );

  return Response.json({
    ok: true,
    vin,
    confidence,
    reason: parsed.reason,
  });
}

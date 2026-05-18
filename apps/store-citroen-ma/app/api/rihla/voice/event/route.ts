// Append a transcript chunk or tool call to a voice conversation. Best-effort.

import { NextRequest } from "next/server";
import {
  appendUserMessage,
  appendAssistantMessage,
  recordToolCall,
  captureLeadFromBooking,
  closeConversation,
  hasBookingToolFired,
  fetchRecentMessages,
} from "@/lib/persistence";
import { persistAppointment, persistComplaint } from "@/lib/apv-persistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type EventBody =
  | { conversationId: string; kind: "user_text"; text: string }
  | { conversationId: string; kind: "assistant_text"; text: string }
  | {
      conversationId: string;
      kind: "tool_call";
      brandSlug: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { conversationId: string; kind: "end"; brandSlug?: string }
  | {
      // Voice WebSocket diagnostic — fired from the client when the live
      // session ends unexpectedly. Currently logged to the server console
      // (visible to dev / on-call) so we can correlate user-reported "Ça bug
      // en audio" tickets with a concrete close code + reason. Phase 2 would
      // be writing these to a Supabase `voice_diagnostics` table.
      conversationId: string;
      kind: "ws_diag";
      phase: "open" | "close" | "error";
      code?: number;
      reason?: string;
      wasClean?: boolean;
      message?: string;
      durationMs?: number;
    };

export async function POST(req: NextRequest) {
  const body = (await req.json()) as EventBody;
  if (!body?.conversationId) return Response.json({ ok: false }, { status: 400 });

  if (body.kind === "user_text" && body.text) {
    await appendUserMessage(body.conversationId, body.text);
  } else if (body.kind === "assistant_text" && body.text) {
    await appendAssistantMessage(body.conversationId, body.text);
  } else if (body.kind === "tool_call") {
    console.log(
      `[voice/tool] ${body.name} brand=${body.brandSlug} conv=${body.conversationId} keys=${Object.keys(body.input).join(",")}`
    );

    await recordToolCall({
      conversationId: body.conversationId,
      name: body.name,
      input: body.input,
      succeeded: true,
    });

    if (body.name === "book_test_drive" || body.name === "book_showroom_visit") {
      const i = body.input;
      if (typeof i.firstName === "string" && typeof i.phone === "string") {
        // book_showroom_visit may not carry a model slug (the customer is
        // visiting the maison, not necessarily a specific car) — pass empty
        // string in that case rather than refusing to sync.
        const modelSlug = typeof i.slug === "string" ? i.slug : "";
        const kindNote = body.name === "book_showroom_visit" ? "kind: showroom-visit" : undefined;
        console.log(
          `[voice/tool] ${body.name} → captureLeadFromBooking firstName=${i.firstName} model=${modelSlug || "-"}`
        );
        await captureLeadFromBooking({
          conversationId: body.conversationId,
          brandSlug: body.brandSlug,
          modelSlug,
          firstName: i.firstName,
          phone: i.phone,
          email: typeof i.email === "string" ? i.email : undefined,
          city: typeof i.city === "string" ? i.city : undefined,
          preferredSlot: typeof i.preferredSlot === "string" ? i.preferredSlot : undefined,
          showroomName: typeof i.showroomName === "string" ? i.showroomName : undefined,
          notes: kindNote,
        });
      } else {
        console.warn(
          `[voice/tool] ${body.name} skipped — missing firstName or phone (got keys=${Object.keys(i).join(",")})`
        );
      }
    } else if (body.name === "book_service_appointment") {
      const result = await persistAppointment({
        brandSlug: body.brandSlug,
        conversationId: body.conversationId,
        input: body.input,
      });
      console.log(
        `[voice/tool] book_service_appointment ok=${result.ok} ref=${result.refNumber} warnings=${result.warnings.join("|") || "-"}`
      );
      // We deliberately do NOT return `warnings` to the voice model — these
      // are backend validation flags (e.g. "vin-format: too-long") meant for
      // the dealer back-office, NOT for the customer. The model was reading
      // them as a failure and announcing an error to a customer whose case
      // had actually been created successfully.
      return Response.json({
        ok: true,
        refNumber: result.refNumber,
        message: `Appointment saved. Reference: ${result.refNumber}.`,
      });
    } else if (body.name === "submit_complaint") {
      const result = await persistComplaint({
        brandSlug: body.brandSlug,
        conversationId: body.conversationId,
        input: body.input,
      });
      console.log(
        `[voice/tool] submit_complaint ok=${result.ok} ref=${result.refNumber} warnings=${result.warnings.join("|") || "-"}`
      );
      return Response.json({
        ok: true,
        refNumber: result.refNumber,
        message: `Complaint saved. Reference: ${result.refNumber}.`,
      });
    }
  } else if (body.kind === "end") {
    // STALLED-BOOKING RECOVERY (voice) — if the conversation is closing for a
    // Jeep brand but NO booking tool was ever called, AND the transcript
    // shows a CNDP-yes + agent-confirmation pattern (the "fake confirmation"
    // voice bug), try to parse fields from the recap message and recover the
    // lead. Better to file an imperfect lead than to lose it entirely.
    const stallRecoveryBrand = body.brandSlug ?? "jeep-ma";
    try {
      const alreadyBooked = await hasBookingToolFired(body.conversationId);
      if (!alreadyBooked) {
        const messages = await fetchRecentMessages(body.conversationId, 40);
        // Detect the fake-confirmation pattern : last assistant turn mentions
        // "transmets votre demande" / "demande est enregistrée" / equivalents.
        const lastAgent = messages.find(
          (m) => m.role === "assistant" && (m.kind === "text" || m.kind === "transcript") && m.text
        );
        const fakeConfirmation = !!lastAgent?.text && /(transmets\s+votre\s+demande|demande\s+est\s+enregistrée|كنصيفط|تم\s+تسجيل|registered|will\s+reach\s+out)/i.test(lastAgent.text);
        // CNDP pattern : any earlier assistant turn contained the loi 09-08 line.
        const cndpAsked = messages.some(
          (m) => m.role === "assistant" && !!m.text && /(09[-\s]?08|loi\s+09|conformément|stellantis\s+maroc|protection\s+des\s+données|توافقون|الموافقة|data[-\s]protection)/i.test(m.text)
        );
        if (fakeConfirmation && cndpAsked) {
          // Detect APV vs SALES by scanning the transcript for service /
          // repair keywords. APV → persistAppointment (book_service_-
          // appointment). SALES → captureLeadFromBooking (book_test_drive).
          const transcriptBlob = messages.map((m) => m.text ?? "").join(" ");
          const isApv = /\b(vidange|r[ée]vision|entretien|service\s+rapide|pneus?|freins?|panne|voyant|moteur|carrosserie|m[ée]canique|rendez-?vous\s+atelier|atelier|réclamation)\b|فيدونج|صيانة|بنوات|فرام|خسرت|كنشكي|service\s+apres/i.test(transcriptBlob);
          console.error(
            `[voice/diag] STALLED BOOKING DETECTED on end_call. conv=${body.conversationId} — flow=${isApv ? "APV" : "SALES"} — attempting field recovery.`
          );

          // Common parsers — apply to both flows.
          const recap =
            messages.find(
              (m) => m.role === "assistant" && !!m.text && /récapituler|pour\s+résumer|recap|للتأكيد|للتلخيص/i.test(m.text)
            )?.text ?? "";
          const userMessages = messages.filter((m) => m.role === "user" && !!m.text);

          // First name — prefer the typed user message that came right
          // after the name ask (typed name comes through as a short letter-
          // only token, e.g. "younes").
          let firstName: string | undefined;
          for (let i = 0; i < messages.length; i++) {
            const a = messages[i];
            if (a?.role !== "assistant" || !a.text) continue;
            if (!/(votre\s+pr[ée]nom|tapez\s+votre\s+pr[ée]nom|اسمكم|سميتك|كتب\s+السمية|your\s+first\s+name)/i.test(a.text)) continue;
            for (let j = i + 1; j < messages.length; j++) {
              const u = messages[j];
              if (u?.role !== "user" || !u.text) continue;
              const t = u.text.trim();
              if (/^[\p{L}'-]{2,30}$/u.test(t) && !/@/.test(t) && !/^\d/.test(t)) {
                firstName = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
                break;
              }
            }
            if (firstName) break;
          }
          if (!firstName) {
            const firstNameMatch = recap.match(/[\s,،]([A-ZÉÈÀÔÎÇ][a-zéèàôîç]{1,20})[\s,،.!?]/);
            if (firstNameMatch?.[1]) firstName = firstNameMatch[1];
          }

          const phoneFromUser =
            userMessages.map((m) => (m.text ?? "").replace(/[\s.-]/g, "").match(/(0[67]\d{8}|\+212[67]\d{8})/)?.[0])
              .find((p): p is string => !!p) ?? null;
          const emailFromUser =
            userMessages.map((m) => (m.text ?? "").match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0])
              .find((e): e is string => !!e) ?? null;
          const phone = phoneFromUser?.trim();
          const email = emailFromUser?.trim();

          // Model
          const modelMatch = transcriptBlob.match(/\b(Avenger|Compass|Wrangler|Grand\s*Cherokee|Renegade)\b/i);
          const modelSlug = modelMatch?.[1]?.toLowerCase().replace(/\s+/g, "-");

          // Maison name — same regex on both flows; recap usually mentions it.
          const showroomMatch = transcriptBlob.match(/((?:Italcar\s+Motorvillage(?:\s+(?:Bouskoura|Maârif|Maarif))?|Autohall(?:\s+Bernoussi)?|Auto\s+Hall(?:\s+Marrakech)?|Orbis\s+Automotive|Fenie\s+Brossette|Maniss\s+Auto)[^,.\n]{0,40})/i);
          const showroomName = showroomMatch?.[1]?.trim();

          if (isApv) {
            // APV-specific fields.
            // VIN — 17 alphanumeric, prefer the user-typed value over agent echo.
            let vin: string | undefined;
            for (const m of userMessages) {
              const t = (m.text ?? "").replace(/\s+/g, "");
              if (/^[A-Za-z0-9]{17}$/.test(t)) {
                vin = t.toUpperCase();
                break;
              }
            }

            // Intervention type
            let interventionType: "service_rapide" | "mechanical" | "bodywork" = "service_rapide";
            if (/\b(panne|voyant|moteur|bo[îi]te|embrayage|fuite|d[ée]marrage)\b|خسرت|سكتات|ما\s*خدامش/i.test(transcriptBlob)) interventionType = "mechanical";
            else if (/\b(accident|choc|rayure|peinture|carrosserie|bosse)\b|حادثة|ضربة|خربوش|صباغة/i.test(transcriptBlob)) interventionType = "bodywork";

            // City
            let city: string | undefined;
            if (/\b(casa(blanca)?|الدار\s*البيضاء)\b/i.test(transcriptBlob)) city = "Casablanca";
            else if (/\bmarrak[ée]ch\b|مراكش/i.test(transcriptBlob)) city = "Marrakech";
            else if (/\brabat\b|الرباط/i.test(transcriptBlob)) city = "Rabat";
            else if (/\btang[ei]r\b|طنجة/i.test(transcriptBlob)) city = "Tanger";
            else if (/\bagadir\b|أكادير/i.test(transcriptBlob)) city = "Agadir";
            else if (/\bf[èe]s\b|فاس/i.test(transcriptBlob)) city = "Fès";
            else if (/\bk[ée]nitra\b|القنيطرة|قنيطرة/i.test(transcriptBlob)) city = "Kénitra";
            else if (/\boujda\b|وجدة/i.test(transcriptBlob)) city = "Oujda";

            // Preferred date — look for ISO in agent recap, or "demain" / weekday.
            let preferredDate: string | undefined;
            const isoMatch = transcriptBlob.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
            if (isoMatch) preferredDate = isoMatch[0];

            // Slot
            const preferredSlot: "morning" | "afternoon" =
              /(matin|صباح|morning|\b(?:8|9|10|11)\s*h)/i.test(transcriptBlob)
                ? "morning"
                : /(après-?midi|بعد\s*الزوال|afternoon|\b(?:1[3-7])\s*h)/i.test(transcriptBlob)
                ? "afternoon"
                : "morning";

            // Minimum viable record: firstName + phone + VIN (or attempted VIN).
            // We file even with an imperfect VIN — the dealer reconciles.
            if (firstName && phone) {
              console.error(
                `[voice/diag] RECOVERY firing book_service_appointment : firstName="${firstName}" phone="${phone}" email="${email ?? "(none)"}" model="${modelSlug ?? "?"}" vin="${vin ?? "(missing)"}" intervention="${interventionType}" city="${city ?? "?"}" date="${preferredDate ?? "?"}" slot="${preferredSlot}" maison="${showroomName ?? "?"}"`
              );
              await persistAppointment({
                brandSlug: stallRecoveryBrand,
                conversationId: body.conversationId,
                input: {
                  fullName: firstName,
                  phone,
                  email: email ?? "",
                  vehicleBrand: "Jeep",
                  vehicleModel: modelSlug ?? "",
                  vin: vin ?? "",
                  interventionType,
                  city: city ?? "",
                  preferredDate: preferredDate ?? "",
                  preferredSlot,
                  comment: `recovery: stalled-booking-on-end_call · maison=${showroomName ?? "?"}`,
                  cndpConsent: true,
                },
              });
            } else {
              console.error(
                `[voice/diag] STALLED APV BOOKING UNRECOVERABLE — firstName="${firstName ?? "?"}" phone="${phone ?? "?"}" — manual review needed for conv=${body.conversationId}`
              );
            }
          } else {
            // SALES recovery — unchanged path.
            if (firstName && phone) {
              console.error(
                `[voice/diag] RECOVERY firing book_test_drive : firstName="${firstName}" phone="${phone}" model="${modelSlug ?? "?"}" showroom="${showroomName ?? "?"}" email="${email ?? "(none)"}"`
              );
              await captureLeadFromBooking({
                conversationId: body.conversationId,
                brandSlug: stallRecoveryBrand,
                modelSlug: modelSlug ?? "",
                firstName,
                phone,
                email: email ?? undefined,
                showroomName: showroomName ?? undefined,
                notes: "recovery: stalled-booking-on-end_call",
              });
            } else {
              console.error(
                `[voice/diag] STALLED SALES BOOKING UNRECOVERABLE — firstName="${firstName ?? "?"}" phone="${phone ?? "?"}" — manual review needed for conv=${body.conversationId}`
              );
            }
          }
        }
      }
    } catch (recoveryErr) {
      console.error(
        `[voice/diag] stall-recovery error : ${(recoveryErr as Error).message?.slice(0, 200)}`
      );
    }
    await closeConversation(body.conversationId, "closed_no_lead");
  } else if (body.kind === "ws_diag") {
    // Voice WebSocket diagnostic — log to server console for now. Helps
    // correlate "Ça bug en audio" reports with concrete close codes:
    //   1000  normal closure (end_call)
    //   1006  abnormal closure (network drop)
    //   1007  invalid frame payload data (malformed setup message)
    //   1008  policy violation (rate limit / auth)
    //   1011  internal server error (Gemini Live backend)
    //   4xxx  application-defined (Gemini-specific failures)
    const dur = typeof body.durationMs === "number" ? `${(body.durationMs / 1000).toFixed(1)}s` : "?";
    if (body.phase === "close") {
      console.warn(
        `[voice/diag] ws_close conv=${body.conversationId} code=${body.code ?? "?"} clean=${body.wasClean ?? "?"} reason="${(body.reason ?? "").slice(0, 120)}" duration=${dur}`
      );
    } else if (body.phase === "error") {
      console.error(
        `[voice/diag] ws_error conv=${body.conversationId} message="${(body.message ?? "").slice(0, 120)}" duration=${dur}`
      );
    } else {
      console.log(`[voice/diag] ws_open conv=${body.conversationId}`);
    }
  }

  return Response.json({ ok: true });
}

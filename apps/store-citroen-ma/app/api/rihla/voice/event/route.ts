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
          console.error(
            `[voice/diag] STALLED BOOKING DETECTED on end_call. conv=${body.conversationId} — attempting field recovery.`
          );
          // Heuristic recap parse. Looks for the typical pattern :
          //   "Younes, pour récapituler : essai du Compass à Italcar Motorvillage Bouskoura, …"
          const recap =
            messages.find(
              (m) => m.role === "assistant" && !!m.text && /récapituler|pour\s+résumer|recap/i.test(m.text)
            )?.text ?? "";
          const firstNameMatch = recap.match(/^\s*([A-ZÉÈÀÔÎÇ][a-zéèàôîç]{1,20})\s*[,،]/);
          const modelMatch = recap.match(/\b(Avenger|Compass|Wrangler|Grand\s*Cherokee|Renegade)\b/i);
          const showroomMatch = recap.match(/à\s+((?:Italcar\s+Motorvillage|Autohall|Auto\s+Hall|Orbis\s+Automotive|Fenie\s+Brossette|Maniss\s+Auto)[^,.\n]{0,80})/i);
          // Phone may be spoken-out ("zéro six zéro neuf…") OR digit-typed.
          // Look at user messages for a digit run first (they likely typed it).
          const userMessages = messages.filter((m) => m.role === "user" && !!m.text);
          const phoneFromUser =
            userMessages.map((m) => (m.text ?? "").match(/(\+?\d[\d\s\-.]{7,}\d)/)?.[0])
              .find((p): p is string => !!p) ?? null;
          const emailFromUser =
            userMessages.map((m) => (m.text ?? "").match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0])
              .find((e): e is string => !!e) ?? null;
          const firstName = firstNameMatch?.[1]?.trim();
          const modelSlug = modelMatch?.[1]?.toLowerCase().replace(/\s+/g, "-");
          const showroomName = showroomMatch?.[1]?.trim();
          const phone = phoneFromUser?.trim();
          const email = emailFromUser?.trim();
          // Need at minimum firstName + phone to file a usable lead.
          if (firstName && phone) {
            console.error(
              `[voice/diag] RECOVERY firing book_test_drive : firstName="${firstName}" phone="${phone}" model="${modelSlug ?? "?"}" showroom="${showroomName ?? "?"}" email="${email ?? "(none)"}"`
            );
            const noteParts = ["recovery: stalled-booking-on-end_call"];
            await captureLeadFromBooking({
              conversationId: body.conversationId,
              brandSlug: stallRecoveryBrand,
              modelSlug: modelSlug ?? "",
              firstName,
              phone,
              email: email ?? undefined,
              showroomName: showroomName ?? undefined,
              notes: noteParts.join(" · "),
            });
          } else {
            console.error(
              `[voice/diag] STALLED BOOKING UNRECOVERABLE — insufficient fields. firstName="${firstName ?? "?"}" phone="${phone ?? "?"}" — manual review needed for conv=${body.conversationId}`
            );
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

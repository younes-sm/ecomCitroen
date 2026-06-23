import { NextRequest, NextResponse } from "next/server";

// ── Jeep-only production lockdown ────────────────────────────────────────────
// This deployment (chatbot.jeep.ma) serves ONLY the Jeep widget. Its base URL
// must not expose the multi-brand demo selector, the Citroën storefront under
// /[locale], other brands' /demo & /embed, or the admin dashboard. So:
//   • /w/jeep-ma            → served (the widget)
//   • /api/* (non-admin)    → served (the widget's chat / voice / showrooms …)
//   • /api/admin/*          → 404 (admin locked)
//   • everything else       → redirected to /w/jeep-ma
//
// Reversible: restore the previous next-intl + admin-gate middleware from git
// history to bring back the full multi-brand app.
const JEEP_WIDGET = "/w/jeep-ma";

export default function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Admin APIs are part of the locked-down admin section.
  if (pathname.startsWith("/api/admin")) {
    return new NextResponse("Not found", { status: 404 });
  }
  // Widget APIs (chat, voice, system-prompt, showrooms, tts, ocr, …) stay open.
  if (pathname.startsWith("/api/")) {
    return NextResponse.next();
  }
  // The Jeep widget itself.
  if (pathname === JEEP_WIDGET || pathname === `${JEEP_WIDGET}/`) {
    return NextResponse.next();
  }
  // Anything else → the Jeep widget.
  const url = req.nextUrl.clone();
  url.pathname = JEEP_WIDGET;
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // Run on every route EXCEPT Next internals and static files, so the widget's
  // JS chunks (/_next/*), fonts, and images (/brand*, /brands* — they have file
  // extensions) load normally. API routes ARE matched so the admin-API 404 +
  // widget-API allow rules above apply.
  matcher: ["/((?!_next|_vercel|.*\\..*).*)"],
};

import { NextRequest, NextResponse } from "next/server";

// ── Jeep-only production lockdown (admin kept ON) ────────────────────────────
// chatbot.jeep.ma serves ONLY the Jeep widget + the password-protected admin
// dashboard (for tracking usage, leads, conversations). Everything else — the
// multi-brand demo selector at /, the Citroën storefront under /[locale], and
// other brands' /demo & /embed — redirects to the Jeep widget so the base URL
// never exposes them.
//   • /admin/*              → password-gated dashboard (login at /admin/login)
//   • /w/jeep-ma            → the widget
//   • /api/*                → widget APIs + admin-dashboard APIs
//   • everything else       → redirected to /w/jeep-ma
const JEEP_WIDGET = "/w/jeep-ma";
const ADMIN_COOKIE = "admin_session";

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export default async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // ── Admin dashboard — password-gated (kept ON to track usage + leads). ──
  if (pathname.startsWith("/admin")) {
    if (pathname === "/admin/login" || pathname.startsWith("/admin/login/")) {
      return NextResponse.next();
    }
    const pwd = process.env.ADMIN_PASSWORD;
    if (!pwd) {
      const url = req.nextUrl.clone();
      url.pathname = "/admin/login";
      return NextResponse.redirect(url);
    }
    const expected = await sha256Hex(pwd);
    const got = req.cookies.get(ADMIN_COOKIE)?.value ?? "";
    if (!constantTimeEqual(got, expected)) {
      const url = req.nextUrl.clone();
      url.pathname = "/admin/login";
      url.searchParams.set("next", pathname);
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  // ── Widget APIs + admin-dashboard APIs stay open. ──
  if (pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  // ── The Jeep widget itself. ──
  if (pathname === JEEP_WIDGET || pathname === `${JEEP_WIDGET}/`) {
    return NextResponse.next();
  }

  // ── Everything else (demo selector, Citroën storefront, other brands) → Jeep widget. ──
  const url = req.nextUrl.clone();
  url.pathname = JEEP_WIDGET;
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // Run on every route EXCEPT Next internals and static files so the widget's
  // JS chunks (/_next/*), fonts, and images (file extensions) load normally.
  // API + admin routes ARE matched so the rules above apply.
  matcher: ["/((?!_next|_vercel|.*\\..*).*)"],
};

import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, authIsConfigured, verifySessionToken } from "@/lib/auth";

function isPublicPath(pathname: string): boolean {
  return pathname === "/login" || pathname.startsWith("/api/auth/");
}

function unauthorizedApiResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (!authIsConfigured()) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Authentication is not configured on the server." },
        { status: 503 },
      );
    }
    return new NextResponse("Authentication is not configured on the server.", { status: 503 });
  }

  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySessionToken(token) : null;

  if (isPublicPath(pathname)) {
    if (pathname === "/login" && session) {
      return NextResponse.redirect(new URL("/", req.url));
    }
    return NextResponse.next();
  }

  if (!session) {
    if (pathname.startsWith("/api/")) {
      return unauthorizedApiResponse();
    }

    const loginUrl = new URL("/login", req.url);
    const next = `${pathname}${search}`;
    if (next !== "/") {
      loginUrl.searchParams.set("next", next);
    }
    return NextResponse.redirect(loginUrl);
  }

  const response = NextResponse.next();
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

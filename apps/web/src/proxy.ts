import { NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const dev = process.env.NODE_ENV !== "production";
  // الرفع من الحاسوب يتصل بنقطة tus مباشرة (#88)؛ الأصول نفسها التي يتحقق منها الـBFF، ولا شيء غيرها.
  const uploads = (process.env.WEB_TUS_ORIGINS ?? "").split(",").map(value => { try { return new URL(value.trim()).origin; } catch { return ""; } }).filter(origin => /^https?:\/\/[^\s;']+$/.test(origin));
  const csp = `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'${uploads.map(origin => ` ${origin}`).join("")}${dev ? " ws:" : ""}; worker-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
  const headers = new Headers(request.headers);
  headers.set("Content-Security-Policy", csp); headers.set("x-nonce", nonce);
  headers.set("x-web-locale", request.nextUrl.pathname.split("/")[1] === "en" ? "en" : "ar");
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}
export const config = { matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"] };

import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ] }, {
      // الصفحات وردود الـBFF لا تُخزَّن. القطع الثابتة (`/_next/static`) مستثناة: اسمها ببصمة محتواها، فتبقى على ترويسة Next
      // (`public, max-age=31536000, immutable`) ولا تُنزَّل من جديد في كل تحميل.
      source: "/((?!_next/static/).*)", headers: [{ key: "Cache-Control", value: "private, no-store, max-age=0" }],
    }, {
      // الخطوط الساكنة لا تتغير بين الإصدارات (public/fonts، ADR 0079)؛ تُخزَّن كي لا تُنزَّل مع كل صفحة.
      source: "/fonts/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=604800" }],
    }];
  },
};
export default config;

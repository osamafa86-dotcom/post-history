"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { browserApi } from "@/lib/browser-api";
import { homePage } from "@/lib/home-page";
import type { Locale } from "@/lib/i18n";

/** زرّ إلى صفحة بداية الدور من صفحة خارج الهيكل (404): الداخل إلى صفحته، وغير الداخل إلى صفحة الدخول. */
export function HomeLink({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  const [href, setHref] = useState(`/${locale}/login`);
  useEffect(() => {
    let live = true;
    void browserApi().GET("/auth/me").then(result => { if (live && result.response.ok && result.data) setHref(`/${locale}/${homePage(result.data)}`); }).catch(() => undefined);
    return () => { live = false; };
  }, [locale]);
  return <Link prefetch={false} className="button" href={href} data-testid="home-link">{children}</Link>;
}

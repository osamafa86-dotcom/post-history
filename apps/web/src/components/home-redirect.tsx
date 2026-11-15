"use client";
import { useEffect } from "react";
import { browserApi } from "@/lib/browser-api";
import { homePage } from "@/lib/home-page";
import { messages, type Locale } from "@/lib/i18n";

/**
 * جذر اللغة (`/ar`، `/en`) يقود إلى صفحة بداية الدور، لا إلى الوارد للجميع: المراسل إلى «موادي»، والمالية إلى الصرف، والمشتري إلى
 * المتجر. بلا جلسة يذهب إلى الدخول بلا سبب (لم تُبطَل جلسة لم تكن).
 */
export function HomeRedirect({ locale }: { locale: Locale }) {
  useEffect(() => {
    let live = true;
    void browserApi().GET("/auth/me").then(result => { if (live) window.location.replace(`/${locale}/${result.response.ok && result.data ? homePage(result.data) : "login"}`); })
      .catch(() => { if (live) window.location.replace(`/${locale}/login`); });
    return () => { live = false; };
  }, [locale]);
  return <main className="center-state"><p role="status">{messages[locale].loading}</p></main>;
}

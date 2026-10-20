"use client";
import { useParams } from "next/navigation";
import { isLocale, messages } from "@/lib/i18n";
export default function ErrorPage({ reset }: { reset: () => void }) {
  const value = useParams().locale, locale = typeof value === "string" && isLocale(value) ? value : "ar", m = messages[locale];
  return <main className="center-state" role="alert"><p>{m.unexpected}</p><button onClick={reset}>{m.retry}</button></main>;
}

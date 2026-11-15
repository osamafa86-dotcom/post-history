"use client";
import { useEffect, useRef, useState } from "react";
import { browserApi, dataOrThrow } from "./browser-api";
import { uuid } from "./query";

/**
 * عناوين مواد التنبيهات (ADR 0090، تعديل 2026-11-15): تُقرأ من المادة نفسها بصلاحية المتصل، لا من حمولة التنبيه. من لا يقرأ المادة يردّه الخادم
 * فلا يظهر له عنوان، ويبقى الصف بكلمة نوعه. كل مادة تُسأل مرة واحدة ما دام المكوّن حيًّا، بطلب واحد في كل مرة.
 */
export function useMaterialTitles(ids: (string | null | undefined)[], enabled = true): Record<string, string> {
  const [titles, setTitles] = useState<Record<string, string>>({}), asked = useRef(new Set<string>());
  const key = enabled ? [...new Set(ids.filter((id): id is string => !!id && uuid.test(id)))].sort().join(",") : "";
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController(), wanted = key.split(",").filter(id => !asked.current.has(id));
    void (async () => {
      for (const id of wanted) {
        if (controller.signal.aborted) return;
        asked.current.add(id);
        try {
          const material = dataOrThrow(await browserApi().GET("/materials/{id}", { params: { path: { id } }, signal: controller.signal }));
          if (!controller.signal.aborted && typeof material.title === "string" && material.title.trim()) setTitles(old => ({ ...old, [id]: material.title }));
        } catch {
          // طلب أُلغي يُسأل في المرة التالية؛ ومن لا يقرأ المادة أو تعذّر طلبه يبقى صفه بلا عنوان
          if (controller.signal.aborted) asked.current.delete(id);
        }
      }
    })();
    return () => controller.abort();
  }, [key]);
  return titles;
}

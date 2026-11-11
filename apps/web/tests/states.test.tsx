import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrorState } from "../src/components/empty-state";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

const texts = (value: unknown): string[] => typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(texts) : [];

describe("a list that could not be loaded", () => {
  it("names what failed, says what happens next and offers one way to try again", () => {
    for (const [locale, m] of [["ar", ar], ["en", en]] as const) {
      const html = renderToStaticMarkup(<ErrorState locale={locale} title={m.shell.inbox.loadFailed} retry={() => undefined} testId="x"><p>{m.shell.inbox.loadFailedBody}</p></ErrorState>);
      expect(html).toContain('role="alert"'); expect(html).toContain(`<h2>${m.shell.inbox.loadFailed}</h2>`); expect(html).toContain(m.shell.inbox.loadFailedBody);
      expect(html.match(/<button/g)).toHaveLength(1); expect(html).toContain(`>${m.retry}</button>`);
      // بلا جملة خاصة يقول الجملة العامة، لا عنوانًا مكرّرًا ولا فراغًا.
      expect(renderToStaticMarkup(<ErrorState locale={locale} title={m.mine.loadFailed} retry={() => undefined} />)).toContain(m.errorBody);
    }
  });
  it("uses one wording for trying again, in every message", () => {
    expect(texts(ar).filter(text => /إعادة المحاولة|حاول مجدد|حاول مرة أخرى\.$|المحاولة الآن/.test(text))).toEqual([]);
    expect(texts(en).filter(text => /^Retry\b/.test(text) || /try again now|please try again/i.test(text))).toEqual([]);
    expect(ar.retry).toBe("أعد المحاولة"); expect(en.retry).toBe("Try again");
  });
  it("names the two urgent counts differently: open, and not received", () => {
    for (const m of [ar, en]) { expect(m.shell.urgentBadge).not.toContain(m.shell.inbox.kpiUrgent); expect(m.board.wall.urgent).toBe(m.board.urgentOpen); expect(m.board.wall.urgent).not.toBe(m.shell.inbox.kpiUrgent); }
  });
});

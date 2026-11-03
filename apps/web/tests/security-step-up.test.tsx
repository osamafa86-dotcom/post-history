import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StepUpFields } from "../src/components/account-security";
import { stepUpBody, stepUpProblem, stepUpRefusal } from "../src/lib/passkey-policy";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

// إعادة التحقق في صفحة «الأمان» (ADR 0117، 0120): النموذج نفسه قبل مفتاح المرور وقبل الرموز الاحتياطية، والحقلان وحدهما يُرسلان، وكل رد
// يقول ما حدث بكلماته. قيم اصطناعية منخفضة الإنتروبيا.
const noop = () => {};

describe("security step-up: what the browser sends and says", () => {
  it("asks for the password, accepts an empty or six-digit code, and sends those two fields alone", () => {
    expect(stepUpProblem("", "123456")).toBe("passwordRequired");
    expect(stepUpProblem("synthetic-password", "12345")).toBe("totpInvalid");
    expect(stepUpProblem("synthetic-password", "")).toBeNull(); expect(stepUpProblem("synthetic-password", "123456")).toBeNull();
    expect(stepUpBody("synthetic-password", "123456")).toEqual({ password: "synthetic-password", totp_code: "123456" });
    expect(stepUpBody("synthetic-password", "")).toEqual({ password: "synthetic-password" });
    expect(Object.keys(stepUpBody("synthetic-password", ""))).toEqual(["password"]);
  });
  it("reads 401 as an ended session, 422 by its code, 429 as too many, and leaves the rest to the caller", () => {
    expect(stepUpRefusal(401)).toBe("session"); expect(stepUpRefusal(401, "totp_required")).toBe("session");
    expect(stepUpRefusal(422, "totp_required")).toBe("totpRequired"); expect(stepUpRefusal(422, "step_up_failed")).toBe("stepUpFailed"); expect(stepUpRefusal(422, "request_failed")).toBe("stepUpFailed");
    expect(stepUpRefusal(429)).toBe("tooMany");
    for (const status of [200, 404, 409, 503]) expect(stepUpRefusal(status)).toBeNull();
  });
  it("has a message for every problem and refusal in both languages", () => {
    for (const security of [ar.security, en.security]) {
      for (const key of ["passwordRequired", "totpInvalid", "totpRequired", "stepUpFailed", "tooMany", "codesStepUpLead", "generateEffect"] as const) expect(security[key].trim().length).toBeGreaterThan(0);
    }
    expect(ar.revoked.length).toBeGreaterThan(0); expect(en.revoked.length).toBeGreaterThan(0);
  });
  it("renders the password and code as left-to-right inputs the password manager and keyboard understand", () => {
    const input = (html: string, name: string) => html.match(/<input[^>]*>/g)?.find(tag => tag.includes(`name="${name}"`)) ?? "";
    const html = renderToStaticMarkup(<StepUpFields locale="ar" password="" code="" checked={false} onPassword={noop} onCode={noop} />);
    expect(html).toContain(ar.security.password); expect(html).toContain(ar.security.totp);
    for (const attribute of ['type="password"', 'dir="ltr"', 'autoComplete="current-password"', 'maxLength="256"']) expect(input(html, "password")).toContain(attribute);
    for (const attribute of ['inputMode="numeric"', 'dir="ltr"', 'autoComplete="one-time-code"', 'maxLength="6"']) expect(input(html, "totp")).toContain(attribute);
    expect(html).not.toContain("aria-invalid");
    const missing = renderToStaticMarkup(<StepUpFields locale="en" password="" code="" checked onPassword={noop} onCode={noop} />);
    expect(missing).toContain(en.security.password); expect(input(missing, "password")).toContain('aria-invalid="true"'); expect(input(missing, "totp")).not.toContain("aria-invalid");
    const short = renderToStaticMarkup(<StepUpFields locale="en" password="synthetic-password" code="12" checked onPassword={noop} onCode={noop} />);
    expect(input(short, "totp")).toContain('aria-invalid="true"'); expect(input(short, "password")).not.toContain("aria-invalid");
  });
});

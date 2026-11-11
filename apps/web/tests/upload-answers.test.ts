import { describe, expect, it } from "vitest";
import { answerFollowup, answerSensitivity, noSensitivityAnswer, sensitivityFlags, uploadNeed } from "../src/lib/upload-policy";
import { validate, visibleFields } from "../src/lib/forms";
import type { Form, MaterialType } from "../src/lib/types";

describe("the desktop upload asks the sensitivity question and takes no answer for granted", () => {
  it("has no flags to send until the reporter answers", () => {
    expect(sensitivityFlags(noSensitivityAnswer)).toBeNull();
  });
  it("reads «no» as the three flags false, because the question names them", () => {
    expect(sensitivityFlags(answerSensitivity(noSensitivityAnswer, "no"))).toEqual({ minors: false, injured: false, graphic: false });
  });
  it("opens the three follow-ups on «yes» with no answer in any, and sends only once each is answered", () => {
    let answers = answerSensitivity(noSensitivityAnswer, "yes");
    expect(answers).toEqual({ gate: "yes", minors: null, injured: null, graphic: null });
    expect(sensitivityFlags(answers)).toBeNull();
    answers = answerFollowup(answerFollowup(answers, "minors", true), "injured", false);
    expect(sensitivityFlags(answers)).toBeNull();
    expect(sensitivityFlags(answerFollowup(answers, "graphic", false))).toEqual({ minors: true, injured: false, graphic: false });
  });
  it("keeps the follow-up answers when «yes» is chosen again, and drops them when the answer turns to «no»", () => {
    const answered = answerFollowup(answerSensitivity(noSensitivityAnswer, "yes"), "graphic", true);
    expect(answerSensitivity(answered, "yes")).toEqual(answered);
    expect(answerSensitivity(answered, "no")).toEqual({ gate: "no", minors: false, injured: false, graphic: false });
    expect(answerSensitivity(answerSensitivity(answered, "no"), "yes")).toEqual({ gate: "yes", minors: null, injured: null, graphic: null });
  });
  it("names what is missing before the material can be created, in the order of the form", () => {
    const yes = answerSensitivity(noSensitivityAnswer, "yes"), no = answerSensitivity(noSensitivityAnswer, "no");
    expect(uploadNeed({ types: [], tags: [], sensitivity: noSensitivityAnswer })).toBe("type");
    expect(uploadNeed({ types: ["report"], tags: [], sensitivity: no })).toBe("tags");
    expect(uploadNeed({ types: ["report"], tags: ["وسم"], sensitivity: noSensitivityAnswer })).toBe("sensitivity");
    expect(uploadNeed({ types: ["report"], tags: ["وسم"], sensitivity: yes })).toBe("followups");
    expect(uploadNeed({ types: ["report"], tags: ["وسم"], sensitivity: no })).toBeNull();
    expect(uploadNeed({ types: ["report", "photos"], tags: ["وسم"], sensitivity: answerFollowup(answerFollowup(answerFollowup(yes, "minors", false), "injured", false), "graphic", true) })).toBeNull();
  });
});

describe("a material of several types takes the office-form fields of each of them, as the server validates it", () => {
  const label = { ar: "حقل", en: "Field" };
  const schema = { version: 3, fields: [
    { key: "guest", type: "short_text", label, required: true, material_types: ["interview"] },
    { key: "altitude", type: "number", label, required: false, material_types: ["aerial"] },
    { key: "note", type: "short_text", label, required: false },
  ] } as unknown as Form;
  const keys = (types: MaterialType | MaterialType[]) => visibleFields(schema, types, {}).map(field => field.key);
  it("shows a field when any of the material's types matches it", () => {
    expect(keys("interview")).toEqual(["guest", "note"]);
    expect(keys(["aerial", "interview"])).toEqual(["guest", "altitude", "note"]);
    expect(keys(["report"])).toEqual(["note"]);
    expect(keys([])).toEqual(["note"]);
  });
  it("requires the required field of a second type too", () => {
    expect(validate(schema, ["aerial", "interview"], {}).errors).toEqual([{ field: "guest", code: "required" }]);
    expect(validate(schema, ["aerial"], {}).valid).toBe(true);
  });
});

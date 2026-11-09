import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  ApplicationState,
  LeftToolbarChange,
  defaultApplicationState,
} from "../../src/contracts/application/application-data";
import {
  changeLeftToolbarPreferences,
  defaultLeftToolbarPreferences,
  normalizeLeftToolbarPreferences,
  type LeftToolbarPreferences,
} from "../../src/utils/left-toolbar-preferences";

describe("left toolbar preference policy", () => {
  it("upgrades missing preferences to the unchanged persistent Dynamic default", () => {
    const old = Schema.decodeUnknownSync(ApplicationState)(defaultApplicationState());
    expect(normalizeLeftToolbarPreferences(old.leftToolbar)).toEqual(
      defaultLeftToolbarPreferences(),
    );
  });
  it.each([
    { autoHide: false, layout: "full" },
    { autoHide: false, layout: "slim" },
    { autoHide: false, layout: "dynamic" },
    { autoHide: true, layout: "full" },
    { autoHide: true, layout: "slim" },
  ] satisfies LeftToolbarPreferences[])("round trips $autoHide / $layout", (value) => {
    const normalized = normalizeLeftToolbarPreferences(value);
    const saved = Schema.encodeSync(ApplicationState)({
      ...defaultApplicationState(),
      leftToolbar: normalized,
    });
    expect(
      Schema.decodeUnknownSync(ApplicationState)(JSON.parse(JSON.stringify(saved))).leftToolbar,
    ).toEqual(normalized);
  });
  it("repairs Auto-hide + Dynamic, retaining Dynamic for restoration", () => {
    const repaired = normalizeLeftToolbarPreferences({ autoHide: true, layout: "dynamic" });
    expect(repaired).toEqual({ autoHide: true, layout: "full", previousLayout: "dynamic" });
    expect(changeLeftToolbarPreferences(repaired, { autoHide: false })).toEqual(
      defaultLeftToolbarPreferences(),
    );
  });
  it.each(["full", "slim", "dynamic"] as const)(
    "restores %s even after changing the auto-hidden form",
    (layout) => {
      const on = changeLeftToolbarPreferences({ autoHide: false, layout }, { autoHide: true });
      const slim = changeLeftToolbarPreferences(on, { layout: "slim" });
      expect(slim).toEqual({ autoHide: true, layout: "slim", previousLayout: layout });
      expect(changeLeftToolbarPreferences(slim, { autoHide: false })).toEqual({
        autoHide: false,
        layout,
      });
    },
  );
  it("normalizes explicit invalid changes and lets an explicit off-layout override restoration", () => {
    const on = changeLeftToolbarPreferences(undefined, { autoHide: true, layout: "dynamic" });
    expect(on.layout).toBe("full");
    expect(changeLeftToolbarPreferences(on, { autoHide: false, layout: "slim" })).toEqual({
      autoHide: false,
      layout: "slim",
    });
    expect(Schema.is(LeftToolbarChange)({ layout: "fullscreen" })).toBe(false);
  });
});

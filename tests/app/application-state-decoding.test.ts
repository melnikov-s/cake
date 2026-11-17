import { Schema } from "effect";
import { expect, it } from "vitest";
import {
  ApplicationState,
  defaultApplicationState,
} from "../../src/contracts/application/application-data";

it("discards unknown saved fields without mutating the input or losing application data", () => {
  const saved = {
    ...defaultApplicationState(),
    globalCustomInstructions: "Keep my instructions",
    unreadSessionIds: ["existing-session"],
    unrecognizedPreference: { enabled: true },
  };
  const decoded = Schema.decodeUnknownSync(ApplicationState)(saved);
  expect(decoded).not.toHaveProperty("unrecognizedPreference");
  expect(decoded.globalCustomInstructions).toBe("Keep my instructions");
  expect(decoded.unreadSessionIds).toEqual(["existing-session"]);
  expect(saved.unrecognizedPreference).toEqual({ enabled: true });
});

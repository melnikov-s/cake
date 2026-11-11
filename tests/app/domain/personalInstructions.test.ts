import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  ApplicationState,
  defaultApplicationState,
  defaultProjectSettings,
} from "../../../src/contracts/application/application-data";
import { personalInstructions } from "../../../src/contracts/application/personal-instructions";

describe("personal instruction compatibility and selection", () => {
  it("defaults new scopes without moving, clearing or trimming existing values", () => {
    const {
      userSessionInstructions: _user,
      delegatedSessionInstructions: _delegated,
      ...legacy
    } = defaultApplicationState();
    const existing = {
      ...legacy,
      globalCustomInstructions: "  Concurrent user writing guidance\nKeep concrete headings.  ",
      cakeChatPreferences: { memoryViewBytes: 40000, instructions: " Existing durable guidance " },
      projects: [
        {
          path: "/project",
          name: "Project",
          addedAt: "2026-01-01T00:00:00.000Z",
          lastOpenedAt: "2026-01-01T00:00:00.000Z",
          settings: {
            ...defaultProjectSettings(),
            customInstructions: "Coding policy",
            projectChatInstructions: "Project Chat policy",
          },
        },
      ],
    };
    const state = Schema.decodeUnknownSync(ApplicationState)(existing);
    expect(state).toEqual({
      ...existing,
      userSessionInstructions: "",
      delegatedSessionInstructions: "",
    });
    expect(Schema.decodeUnknownSync(ApplicationState)(state)).toEqual(state);
  });

  it.each(["global", "user", "delegated"] as const)(
    "selects only %s guidance alongside universal guidance",
    (scope) => {
      const state = {
        ...defaultApplicationState(),
        globalCustomInstructions: "UNIVERSAL",
        userSessionInstructions: "USER_ONLY",
        delegatedSessionInstructions: "DELEGATED_ONLY",
        cakeChatPreferences: { memoryViewBytes: 40000, instructions: "DURABLE_ONLY" },
      };
      const prompt = personalInstructions(state, scope);
      expect(prompt.split("UNIVERSAL")).toHaveLength(2);
      expect(prompt.includes("USER_ONLY")).toBe(scope === "user");
      expect(prompt.includes("DELEGATED_ONLY")).toBe(scope === "delegated");
      expect(prompt).not.toContain("DURABLE_ONLY");
      expect(personalInstructions(defaultApplicationState(), scope)).toBe("");
    },
  );
});

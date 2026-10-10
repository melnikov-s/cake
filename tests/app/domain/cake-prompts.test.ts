import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  defaultCakePrompts,
  normalizeCakePromptOverrides,
  resolveCakePrompts,
} from "../../../src/contracts/application/cake-prompt-defaults";
import { renderCakePrompt } from "../../../src/domain/application/cake-prompts";

describe("Cake prompt policy", () => {
  it("normalizes resets and source defaults while preserving custom text exactly", () => {
    const defaults = defaultCakePrompts();
    const overrides = {
      worktreeCommit: defaults.worktreeCommit,
      worktreeSquashMessage: "  ",
      dictationCleanup: "  Keep my custom instructions.  ",
    };
    assert.deepEqual(normalizeCakePromptOverrides(overrides), {
      dictationCleanup: "  Keep my custom instructions.  ",
    });
    assert.equal(overrides.worktreeCommit, defaults.worktreeCommit);
    assert.equal(overrides.worktreeSquashMessage, "  ");
  });

  it("resolves missing overrides from current domain defaults without persisting them", () => {
    const overrides = { worktreeCommit: "Use my commit instructions." };
    const resolved = resolveCakePrompts(overrides);
    assert.deepEqual(resolved, {
      ...defaultCakePrompts(),
      worktreeCommit: "Use my commit instructions.",
    });
    assert.deepEqual(overrides, { worktreeCommit: "Use my commit instructions." });
  });

  it("renders workflow context and an explicit instruction when conflict files are unknown", () => {
    assert.equal(
      renderCakePrompt("Target {{target}}\n{{files}}", {
        target: "main",
        files: ["src/first.ts", "src/second.ts"],
      }),
      "Target main\n- src/first.ts\n- src/second.ts",
    );
    assert.equal(
      renderCakePrompt("Target {{target}}\n{{files}}", { target: "main" }),
      "Target main\n- Run `git status` to list the conflicted files.",
    );
  });
});

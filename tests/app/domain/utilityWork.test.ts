import assert from "node:assert/strict";
import { Effect } from "effect";
import { describe, it } from "vitest";
import {
  generateSessionTitle,
  generateWorktreeName,
  normalizeSessionTitle,
  normalizeWorktreeName,
  rewordSelection,
} from "../../../src/domain/utilityWork";
import {
  makePiModelsLayer,
  type PiModels,
  type PiModelsAdapter,
} from "../../../src/services/pi/PiModels";
import type { BoundedCompletionInput, PiModel } from "../../../src/services/pi/model-data";

const selection = {
  provider: "openai",
  modelId: "gpt-5-mini",
  thinkingLevel: "low" as const,
  fastMode: false,
};

const model: PiModel = {
  provider: selection.provider,
  providerName: "OpenAI",
  id: selection.modelId,
  name: "GPT-5 mini",
  reasoning: true,
  supportedThinkingLevels: ["off", "low"],
  fastMode: false,
  input: ["text"],
  authenticated: true,
  available: true,
  authTypes: ["oauth"],
};

const run = <A, E>(effect: Effect.Effect<A, E, PiModels>, complete: PiModelsAdapter["complete"]) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        makePiModelsLayer({
          loadCatalog: async () => [model],
          refreshCatalog: async () => undefined,
          complete,
        }),
      ),
    ),
  );

describe("utility work", () => {
  it("runs session naming through PiModels and normalizes the bounded result", async () => {
    let received: BoundedCompletionInput | undefined;
    const title = await run(
      generateSessionTitle({
        selection,
        firstUserMessage: "Add a user-configured utility model.",
      }),
      async (input) => {
        received = input;
        return '"Implement utility model settings."';
      },
    );

    assert.equal(title, "Implement utility model settings");
    assert.match(received!.instructions, /user's initial request/);
    assert.match(received!.context, /Add a user-configured utility model/);
    assert.equal(received!.maximumOutputCharacters, 80);
    assert.equal(received!.timeoutMs, 15_000);
  });

  it("generates an exact three-part worktree slug", async () => {
    let received: BoundedCompletionInput | undefined;
    const name = await run(
      generateWorktreeName({
        selection,
        firstUserMessage: "Fix the login redirect.",
      }),
      async (input) => {
        received = input;
        return "Fix Login Redirect.";
      },
    );

    assert.equal(name, "fix-login-redirect");
    assert.match(received!.instructions, /exactly three/);
    assert.throws(() => normalizeWorktreeName("this-has-four-parts"), /invalid worktree name/);
  });

  it("rewrites selected text with optional user guidance", async () => {
    let received: BoundedCompletionInput | undefined;
    const text = await run(
      rewordSelection({
        selection,
        text: "This is the thing I was rambling about.",
        guidance: " Make it concise. ",
      }),
      async (input) => {
        received = input;
        return "A concise, clear request.";
      },
    );

    assert.equal(text, "A concise, clear request.");
    assert.match(
      received!.instructions,
      /speech-to-text[\s\S]*coding assistant[\s\S]*phonetic similarity[\s\S]*"Git"[\s\S]*"skills"[\s\S]*"agents"/,
    );
    assert.deepEqual(JSON.parse(received!.context), {
      selection: "This is the thing I was rambling about.",
      guidance: "Make it concise.",
    });
  });

  it("rejects empty rewrites", async () => {
    await assert.rejects(
      () => run(rewordSelection({ selection, text: "text" }), async () => "   "),
      /empty rewrite/,
    );
  });

  it("keeps useful title detail and marks titles that exceed the display limit", () => {
    const title = normalizeSessionTitle(`## “${"Long generated title ".repeat(8)}”\nExplanation`);

    assert.equal(title.length, 80);
    assert.match(title, /…$/u);
    assert.equal(normalizeSessionTitle("\n\n"), "");
  });
});

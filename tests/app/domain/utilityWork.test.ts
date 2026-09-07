import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, it as vitestIt } from "vitest";
import {
  generateSessionDescription,
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
  effect.pipe(
    Effect.provide(
      makePiModelsLayer({
        loadCatalog: () => Effect.succeed([model]),
        refreshCatalog: () => Effect.void,
        complete,
      }),
    ),
  );

describe("utility work", () => {
  it.effect("runs session naming through PiModels and normalizes the bounded result", () =>
    Effect.gen(function* () {
      let received: BoundedCompletionInput | undefined;
      const title = yield* run(
        generateSessionTitle({
          selection,
          firstUserMessage: "Add a user-configured utility model.",
        }),
        (input) =>
          Effect.sync(() => {
            received = input;
            return '"Implement utility model settings."';
          }),
      );

      assert.equal(title, "Implement utility model settings");
      assert.ok(received);
      assert.match(received.instructions, /user's initial request/);
      assert.match(received.context, /Add a user-configured utility model/);
      assert.equal(received.maximumOutputCharacters, 80);
      assert.equal(received.timeoutMs, 15_000);
    }),
  );

  it.effect("generates a bounded one-sentence session description", () =>
    Effect.gen(function* () {
      let received: BoundedCompletionInput | undefined;
      const description = yield* run(
        generateSessionDescription({
          selection,
          title: "Add Kanban",
          firstUserMessage: "Build a project-scoped session Kanban board.",
        }),
        (input) =>
          Effect.sync(() => {
            received = input;
            return "  Organize project sessions with custom workflow statuses.  ";
          }),
      );

      assert.equal(description, "Organize project sessions with custom workflow statuses.");
      assert.ok(received);
      assert.equal(received.maximumOutputCharacters, 240);
      assert.match(received.context, /Build a project-scoped session Kanban board/);
    }),
  );

  it.effect("generates an exact three-part worktree slug", () =>
    Effect.gen(function* () {
      let received: BoundedCompletionInput | undefined;
      const name = yield* run(
        generateWorktreeName({
          selection,
          firstUserMessage: "Fix the login redirect.",
        }),
        (input) =>
          Effect.sync(() => {
            received = input;
            return "Fix Login Redirect.";
          }),
      );

      assert.equal(name, "fix-login-redirect");
      assert.ok(received);
      assert.match(received.instructions, /exactly three/);
      assert.throws(() => normalizeWorktreeName("this-has-four-parts"), /invalid worktree name/);
    }),
  );

  it.effect("rewrites selected text with optional user guidance", () =>
    Effect.gen(function* () {
      let received: BoundedCompletionInput | undefined;
      const text = yield* run(
        rewordSelection({
          selection,
          text: "This is the thing I was rambling about.",
          guidance: " Make it concise. ",
        }),
        (input) =>
          Effect.sync(() => {
            received = input;
            return "A concise, clear request.";
          }),
      );

      assert.equal(text, "A concise, clear request.");
      assert.ok(received);
      assert.match(
        received.instructions,
        /speech-to-text[\s\S]*coding assistant[\s\S]*phonetic similarity[\s\S]*"Git"[\s\S]*"skills"[\s\S]*"agents"/,
      );
      assert.deepEqual(JSON.parse(received.context), {
        selection: "This is the thing I was rambling about.",
        guidance: "Make it concise.",
      });
    }),
  );

  it.effect("rejects empty rewrites", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        run(rewordSelection({ selection, text: "text" }), () => Effect.succeed("   ")),
      );
      assert.match(failure.message, /empty rewrite/);
    }),
  );

  vitestIt("keeps useful title detail and marks titles that exceed the display limit", () => {
    const title = normalizeSessionTitle(`## “${"Long generated title ".repeat(8)}”\nExplanation`);

    assert.equal(title.length, 80);
    assert.match(title, /…$/u);
    assert.equal(normalizeSessionTitle("\n\n"), "");
  });
});

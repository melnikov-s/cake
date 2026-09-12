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
  selectInitialSessionLabels,
} from "../../../src/domain/utility-work/utilityWork";
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

  it.effect("selects at most three existing labels from only the user request", () =>
    Effect.gen(function* () {
      let received: BoundedCompletionInput | undefined;
      const labels = [
        { id: "00000000-0000-4000-8000-000000000001", name: "Feature", color: "blue" as const },
        { id: "00000000-0000-4000-8000-000000000002", name: "UI", color: "pink" as const },
        { id: "00000000-0000-4000-8000-000000000003", name: "Testing", color: "green" as const },
        { id: "00000000-0000-4000-8000-000000000004", name: "Tooling", color: "indigo" as const },
      ];
      const selected = yield* run(
        selectInitialSessionLabels({
          selection,
          firstUserMessage: "Build a new multi-select label picker.",
          labels,
        }),
        (input) =>
          Effect.sync(() => {
            received = input;
            return JSON.stringify([labels[1]!.id, labels[0]!.id, labels[2]!.id, labels[3]!.id]);
          }),
      );

      assert.deepEqual(selected, [labels[1]!.id, labels[0]!.id, labels[2]!.id]);
      assert.ok(received);
      assert.match(received.context, /multi-select label picker/);
      assert.doesNotMatch(received.context, /color/);
      assert.match(received.instructions, /Do not create labels/);
    }),
  );

  it.effect("generates a bounded session description", () =>
    Effect.gen(function* () {
      let received: BoundedCompletionInput | undefined;
      const description = yield* run(
        generateSessionDescription({
          selection,
          title: "Add statuses",
          firstUserMessage: "Build customizable project session statuses.",
        }),
        (input) =>
          Effect.sync(() => {
            received = input;
            return "  Organize project sessions with custom workflow statuses.  ";
          }),
      );

      assert.equal(description, "Organize project sessions with custom workflow statuses.");
      assert.ok(received);
      assert.equal(received.maximumOutputCharacters, 560);
      assert.match(received.context, /Build customizable project session statuses/);
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

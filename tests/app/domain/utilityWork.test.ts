import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Logger, Ref } from "effect";
import { TestClock } from "effect/testing";
import { describe, it as vitestIt } from "vitest";
import {
  decodeTodoRanking,
  generateSessionDescription,
  generateSessionTitle,
  generateWorktreeName,
  normalizeSessionTitle,
  normalizeWorktreeName,
  rankTodos,
  rewordSelection,
  selectInitialSessionLabels,
} from "../../../src/domain/utility-work/utilityWork";
import {
  makePiModelsLayer,
  type PiModels,
  type PiModelsAdapter,
} from "../../../src/services/pi/PiModels";
import {
  PiModelCompletionError,
  type BoundedCompletionInput,
  type PiModel,
} from "../../../src/contracts/pi/model-data";
import type { ProjectTodo } from "../../../src/contracts/projects/project-todos";

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
        loadNonChatCatalog: () => Effect.succeed([]),
        refreshCatalog: () => Effect.void,
        login: () => Effect.void,
        logout: () => Effect.void,
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

  it.effect("retries a failed completion once without another user message", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const title = yield* run(
        generateSessionTitle({ selection, firstUserMessage: "Investigate naming" }),
        () =>
          Effect.gen(function* () {
            const attempt = yield* Ref.getAndUpdate(attempts, (count) => count + 1);
            if (attempt === 0)
              return yield* Effect.fail(new Error("Provider temporarily unavailable"));
            return "Recovered title";
          }),
      );
      assert.equal(title, "Recovered title");
      assert.equal(yield* Ref.get(attempts), 2);
    }),
  );

  it.effect("retries empty title output and bounds exhausted attempts with a diagnostic", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const logs: unknown[] = [];
      const error = yield* run(
        generateSessionTitle({ selection, firstUserMessage: "Investigate naming" }),
        () => Ref.update(attempts, (count) => count + 1).pipe(Effect.as("")),
      ).pipe(
        Effect.flip,
        Effect.provide(
          Logger.layer([
            Logger.make((entry) => {
              logs.push(entry.message);
            }),
          ]),
        ),
      );
      assert.equal(error._tag, "UtilityWorkOutputError");
      assert.equal(yield* Ref.get(attempts), 2);
      assert.equal(logs.length, 1);
      assert.match(String(logs[0]), /Automatic session title generation failed/);
    }),
  );

  it.effect("gives a timeout retry its own deadline", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const attempts = yield* Ref.make(0);
      const naming = yield* run(
        generateSessionTitle({ selection, firstUserMessage: "Investigate naming" }),
        () =>
          Effect.gen(function* () {
            const attempt = yield* Ref.getAndUpdate(attempts, (count) => count + 1);
            if (attempt === 0) {
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }
            return "Recovered after timeout";
          }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust(15_000);
      assert.equal(yield* Fiber.join(naming), "Recovered after timeout");
      assert.equal(yield* Ref.get(attempts), 2);
    }),
  );

  it.effect("does not retry interruption or an invalid utility-model selection", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const attempts = yield* Ref.make(0);
      const complete = () =>
        Ref.update(attempts, (count) => count + 1).pipe(
          Effect.andThen(Deferred.succeed(started, undefined)),
          Effect.andThen(Effect.never),
        );
      const naming = yield* run(
        generateSessionTitle({ selection, firstUserMessage: "Investigate naming" }),
        complete,
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(naming);
      assert.equal(yield* Ref.get(attempts), 1);
      const error = yield* run(
        generateSessionTitle({
          selection: { ...selection, modelId: "missing" },
          firstUserMessage: "Investigate naming",
        }),
        complete,
      ).pipe(Effect.flip);
      assert.equal(error._tag, "UnknownPiModelError");
      assert.equal(yield* Ref.get(attempts), 1);
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
  describe("to-do ranking", () => {
    const todo = (index: number): ProjectTodo => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      title: `Item ${index}`,
      description: "d".repeat(600),
      status: "",
      state: "open",
      revision: 0,
      associations: [],
    });
    const decode = (text: string, count = 3) =>
      Effect.runSync(Effect.result(decodeTodoRanking(text, count)));

    it.effect.each([
      ["a plain array", "[3,1,2]", [2, 0, 1]],
      ["surrounding whitespace", "\n  [3, 1, 2]  \n", [2, 0, 1]],
      ["a json code fence", "```json\n[3,1,2]\n```", [2, 0, 1]],
      ["a bare code fence", "```\n[2,3,1]\n```", [1, 2, 0]],
      ["omitted items in current order", "[3]", [2, 0, 1]],
    ] as const)("accepts %s", ([, text, expected]) =>
      Effect.sync(() => {
        const result = decode(text);
        assert.equal(result._tag, "Success");
        if (result._tag === "Success") assert.deepEqual(result.success, expected);
      }),
    );

    it.effect.each([
      ["prose", "Here is the order: [1,2,3]", /not valid JSON/],
      ["a cut-off array", "[3, 1,", /not valid JSON/],
      ["an object", '{"order":[1,2,3]}', /not an array of item numbers/],
      ["ID strings", '["1","2","3"]', /not an array of item numbers/],
      ["fractions", "[1.5,2,3]", /not an array of item numbers/],
      ["zero", "[0,1,2]", /item number 0 is outside 1-3/],
      ["too large", "[1,2,4]", /item number 4 is outside 1-3/],
      ["duplicates", "[2,1,2]", /repeats item number 2/],
    ] as const)("rejects %s with a specific error and reply preview", ([, text, message]) =>
      Effect.sync(() => {
        const result = decode(text);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.match(result.failure.message, message);
          assert.equal(result.failure.replyPreview, text);
        }
      }),
    );

    vitestIt("bounds the reply preview", () => {
      const result = decode(`${"x".repeat(5_000)}`);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.replyPreview?.length, 400);
    });

    it.effect("asks for numbers within budget and maps them back to IDs", () =>
      Effect.gen(function* () {
        const items = Array.from({ length: 50 }, (_, index) => todo(index));
        let received: BoundedCompletionInput | undefined;
        const reply = JSON.stringify(items.map((_, index) => 50 - index));
        const order = yield* run(rankTodos({ selection, items }), (input) =>
          Effect.sync(() => {
            received = input;
            return reply;
          }),
        );
        assert.deepEqual(order, items.map(({ id }) => id).reverse());
        assert.ok(received);
        assert.match(received.instructions, /item numbers[\s\S]*1 to 50 exactly once/);
        const context = JSON.parse(received.context);
        assert.deepEqual(context[0], {
          number: 1,
          title: "Item 0",
          description: "d".repeat(512),
        });
        assert.ok(!received.context.includes(items[0]!.id));
        assert.ok(reply.length < received.maximumOutputCharacters);
      }),
    );

    it.effect("reports a truncated reply as a completion failure, not a ranking", () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          run(rankTodos({ selection, items: [todo(1), todo(2)] }), () =>
            Effect.fail(new Error("Model output was truncated at the model's output limit")),
          ),
        );
        assert.ok(failure instanceof PiModelCompletionError);
        assert.match(failure.message, /truncated/);
      }),
    );
  });
});

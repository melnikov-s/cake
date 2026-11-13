import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { PiModels } from "../../../../src/services/pi/PiModels";
import { makePiModelsLive } from "../../../../src/services/pi/live/PiModelsLive";
import { openDurableChatEngine } from "../../../../src/services/pi-durable/durable-chat-engine";
import { durableAnswer, durableModels } from "../../../fixtures/durable-chat";

it.each(["transient", "authentication", "configuration", "tool-output", "empty-summary"] as const)(
  "handles real Pi adapter %s output through the engine and repairs without active-head churn",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "cake-memory-provider-"));
    const auth = vi
      .spyOn(ModelRuntime.prototype, "checkAuth")
      .mockResolvedValue({ type: "api_key", source: "fixture" });
    const available = vi
      .spyOn(ModelRuntime.prototype, "getAvailable")
      .mockImplementation(async function (this: ModelRuntime, provider) {
        return this.getModels(provider);
      });
    let recovered = false;
    let calls = 0;
    const complete = vi
      .spyOn(ModelRuntime.prototype, "completeSimple")
      .mockImplementation(async () => {
        calls += 1;
        if (recovered || (mode === "transient" && calls > 1))
          return durableAnswer("Recovered fact " + "s".repeat(280));
        if (mode === "empty-summary")
          return durableAnswer("", [{ type: "thinking", thinking: "PRIVATE_REASONING" }]);
        if (mode === "tool-output")
          return durableAnswer("", [
            {
              type: "toolCall",
              id: "unused",
              name: "cake",
              arguments: { secret: "PRIVATE_ARGUMENTS" },
            },
          ]);
        return {
          ...durableAnswer(""),
          stopReason: "error",
          errorMessage: `${mode === "transient" ? "503 service unavailable" : "401 unauthorized"}; SECRET_TOKEN PRIVATE_BODY`,
        };
      });
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const models = yield* PiModels;
          yield* Effect.promise(async () => {
            const main = durableModels();
            const reports: string[] = [];
            const engine = await openDurableChatEngine({
              storage: new MemoryStorage(),
              models: main.models,
              registry: createRegistry(),
              agent: {
                model: { provider: "fixture", modelId: "fixture" },
                thinkingLevel: "off",
                instructions: "Stable coordinator instructions",
                tools: [],
              },
              now: () => 1,
              memory: {
                budget: () => 4_000,
                summarize: (input) => {
                  input.onModel?.("openai/gpt-5-mini");
                  return Effect.runPromise(
                    models.complete({
                      selection: {
                        provider: "openai",
                        modelId: "gpt-5-mini",
                        thinkingLevel: mode === "configuration" && !recovered ? "off" : "low",
                        fastMode: false,
                      },
                      instructions: input.instructions,
                      context: input.context,
                      chat: { tools: input.tools ?? [], previous: input.previous ?? [] },
                      maximumOutputCharacters: 4_096,
                    }),
                    { signal: input.signal },
                  );
                },
              },
              settings: { contextRetentionMs: 0, compaction: { enabled: false } },
              onChanged: () => undefined,
              onReport: (error) => {
                reports.push(String(error));
              },
            });
            try {
              const original = "ORIGINAL_DECISION ".repeat(100);
              expect(
                await (
                  await engine.root.submit(
                    { type: "input", content: original, requestId: "first" },
                    BACKGROUND_CONTEXT,
                  )
                ).wait(BACKGROUND_CONTEXT),
              ).toMatchObject({ status: "done" });
              const head = await engine.root.context(BACKGROUND_CONTEXT);
              const view = await engine.index(new AbortController().signal);
              expect(calls, reports.join("\n")).toBe(
                mode === "configuration" ? 0 : mode === "transient" ? 2 : 1,
              );
              expect(view.text).not.toContain("[excerpt;");
              expect(JSON.stringify(reports)).not.toMatch(
                /SECRET_TOKEN|PRIVATE_BODY|PRIVATE_ARGUMENTS|PRIVATE_REASONING/,
              );
              if (mode === "transient") expect(view.text).toContain("Recovered fact");
              else {
                expect(view.text.match(/Some memory summaries are pending/g)).toHaveLength(1);
                expect(view.text).toContain("ORIGINAL_DECISION");
                expect(reports.join(" ")).toContain(`"category":"${mode}"`);
                expect(reports.join(" ")).toContain('"model":"openai/gpt-5-mini"');
                expect(reports.join(" ")).toContain('"attempts":1');
                expect(reports.join(" ")).toMatch(/"fromEntryId":\d+,"throughEntryId":\d+/);
                recovered = true;
                expect(await engine.repairMemory(0, 1, new AbortController().signal)).toMatchObject(
                  { repaired: 1, calls: 1, automaticRetry: false },
                );
                expect((await engine.index(new AbortController().signal)).text).toContain(
                  "Recovered fact",
                );
              }
              const after = await engine.root.context(BACKGROUND_CONTEXT);
              expect(after.head).toEqual(head.head);
              expect(after.messages).toEqual(head.messages);
              expect((await engine.memory.zoom(0, 1, new AbortController().signal)).text).toContain(
                original,
              );
              expect(
                await (
                  await engine.root.submit(
                    { type: "input", content: "Continue", requestId: "second" },
                    BACKGROUND_CONTEXT,
                  )
                ).wait(BACKGROUND_CONTEXT),
              ).toMatchObject({ status: "done" });
              expect(JSON.stringify(main.requests[1])).toContain(original); // warm active history is not replaced by indexing/repair
            } finally {
              await engine.close();
            }
          });
        }).pipe(Effect.provide(makePiModelsLive(directory))),
      );
    } finally {
      complete.mockRestore();
      available.mockRestore();
      auth.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

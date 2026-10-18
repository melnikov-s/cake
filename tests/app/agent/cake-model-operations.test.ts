import { describe, expect, it } from "vitest";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import { createCakeModelOperations } from "../../../src/domain/model-presets/cake-model-operations";

const context = { signal: new AbortController().signal, toolCallId: "call-1", runtime: {} };
const preset = (index: number) => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  name: `Sol-${index}`,
  provider: "openai-codex",
  modelId: "gpt-5.6-sol",
  thinkingLevel: "high" as const,
  fastMode: index % 2 === 0,
});
const presets = Array.from({ length: 61 }, (_, index) => preset(index));
const registry = () =>
  new CakeOperationRegistry(
    createCakeModelOperations(() => ({ presets, defaultPresetId: preset(0).id })),
  );

async function result(command: string, input = {}) {
  return JSON.parse((await registry().invoke({ command, input }, context)).text);
}

describe("Cake model discovery", () => {
  it("lists names and defaults without execution details", async () => {
    const page = await registry().invoke({ command: "models.list" }, context);
    expect(page.text).toBe(
      [
        "61 presets; next=20",
        "default\tname",
        ...presets.slice(0, 20).map(({ name }, index) => `${index === 0 ? 1 : 0}\t${name}`),
      ].join("\n"),
    );
    expect(page.details).toMatchObject({
      result: {
        total: 61,
        offset: 0,
        nextOffset: 20,
        presets: presets.slice(0, 20).map(({ name }, index) => ({ name, default: index === 0 })),
      },
    });
  });

  it("filters before paginating and marks the final page", async () => {
    const page = await registry().invoke(
      { command: "models.list", input: { query: "SOL-1", limit: 2, offset: 2 } },
      context,
    );
    expect(page.text).toBe("11 presets; next=4\ndefault\tname\n0\tSol-11\n0\tSol-12");
    expect(page.details).toMatchObject({
      result: {
        total: 11,
        offset: 2,
        nextOffset: 4,
        presets: [
          { name: "Sol-11", default: false },
          { name: "Sol-12", default: false },
        ],
      },
    });
    const last = await registry().invoke(
      { command: "models.list", input: { limit: 50, offset: 50 } },
      context,
    );
    expect(last.text).toContain("61 presets\ndefault\tname\n");
    expect(last.text.split("\n")).toHaveLength(13);
    expect(last.details).toMatchObject({ result: { nextOffset: null } });
    const empty = await registry().invoke(
      { command: "models.list", input: { query: "absent" } },
      context,
    );
    expect(empty.text).toBe("0 presets");
    expect(empty.details).toMatchObject({
      result: { total: 0, offset: 0, nextOffset: null, presets: [] },
    });
  });

  it("inspects a discovered exact name without credentials or internal identifiers", async () => {
    const page = await registry().invoke({ command: "models.list", input: { limit: 1 } }, context);
    expect(page.text).toContain("1\tSol-0");
    expect(await result("models.info", { name: "Sol-0" })).toEqual({
      name: "Sol-0",
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "high",
      fastMode: true,
      default: true,
    });
    await expect(
      registry().invoke({ command: "models.info", input: { name: "Sol" } }, context),
    ).rejects.toThrow("Unknown model preset");
  });

  it.each([{ limit: 0 }, { limit: 51 }, { offset: -1 }, { unexpected: true }])(
    "rejects invalid list input %j",
    async (input) => {
      await expect(registry().invoke({ command: "models.list", input }, context)).rejects.toThrow();
    },
  );
});

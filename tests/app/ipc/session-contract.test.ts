import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  RendererApplicationProjection,
  RendererApplicationState,
  defaultApplicationState,
} from "../../../src/domain/application/application-data";
import {
  applicationStateSchema,
  parsePiBuiltinCommand,
  piBuiltinSlashCommands,
} from "../../../src/ipc/session-contract";

it("uses the domain-owned renderer application schema at the IPC boundary", () => {
  expect(applicationStateSchema).toBe(RendererApplicationState);
});

it("rejects invalid model-preset invariants at the application projection wire boundary", () => {
  const duplicate = {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Preset",
    provider: "openai",
    modelId: "model",
    thinkingLevel: "off" as const,
    fastMode: false,
  };

  expect(() =>
    Schema.decodeUnknownSync(RendererApplicationProjection)({
      revision: 1,
      state: {
        ...defaultApplicationState(),
        modelPresets: [duplicate, duplicate],
        defaultModelPresetId: "00000000-0000-4000-8000-000000000002",
      },
    }),
  ).toThrow(/unique Project, Model Preset, and workflow status identities with valid references/);
});

describe("parsePiBuiltinCommand", () => {
  it("parses builtin commands with and without arguments", () => {
    expect(parsePiBuiltinCommand("/compact")).toEqual({ name: "compact", args: "" });
    expect(parsePiBuiltinCommand("/compact  Keep the API details ")).toEqual({
      name: "compact",
      args: "Keep the API details",
    });
    expect(parsePiBuiltinCommand(" /MODEL")).toEqual({ name: "model", args: "" });
    expect(parsePiBuiltinCommand("/toolcompact Implement the plan")).toEqual({
      name: "toolcompact",
      args: "Implement the plan",
    });
    expect(parsePiBuiltinCommand("/sidechat Compare approaches")).toEqual({
      name: "sidechat",
      args: "Compare approaches",
    });
    expect(
      piBuiltinSlashCommands.find((command) => command.name === "sidechat")?.sourceInfo,
    ).toEqual(expect.objectContaining({ source: "Cake", path: "builtin:cake" }));
  });

  it("ignores non-commands and unknown commands", () => {
    expect(parsePiBuiltinCommand("fix the /compact handling")).toBeUndefined();
    expect(parsePiBuiltinCommand("/definitely-not-a-pi-builtin")).toBeUndefined();
    expect(parsePiBuiltinCommand("compact")).toBeUndefined();
    expect(parsePiBuiltinCommand("")).toBeUndefined();
  });
});

import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  RendererApplicationProjection,
  RendererApplicationState,
  defaultApplicationState,
} from "../../../src/contracts/application/application-data";
import {
  applicationStateSchema,
  parseBuiltinCommand,
  builtinSlashCommands,
  cakeChatBuiltinSlashCommands,
} from "../../../src/contracts/conversations/session-contract";

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
  ).toThrow(/unique Project, Model Preset, and session-label identities with valid references/);
});

describe("parseBuiltinCommand", () => {
  it("parses builtin commands with and without arguments", () => {
    expect(parseBuiltinCommand("/compact")).toEqual({ name: "compact", args: "" });
    expect(parseBuiltinCommand("/compact  Keep the API details ")).toEqual({
      name: "compact",
      args: "Keep the API details",
    });
    expect(parseBuiltinCommand(" /MODEL")).toEqual({ name: "model", args: "" });
    expect(parseBuiltinCommand("/toolcompact Implement the plan")).toEqual({
      name: "toolcompact",
      args: "Implement the plan",
    });
    expect(parseBuiltinCommand("/sidechat")).toEqual({ name: "sidechat", args: "" });
    expect(parseBuiltinCommand("/sidechat Compare approaches")).toEqual({
      name: "sidechat",
      args: "Compare approaches",
    });
    expect(parseBuiltinCommand("/schedule 5m Check progress")).toEqual({
      name: "schedule",
      args: "5m Check progress",
    });
  });

  it("attributes Pi and Cake commands separately and scopes the chat catalog", () => {
    expect(
      builtinSlashCommands.map((command) => [command.name, command.sourceInfo.source]),
    ).toEqual([
      ["compact", "Pi CLI"],
      ["model", "Pi CLI"],
      ["name", "Pi CLI"],
      ["sidechat", "Cake"],
      ["schedule", "Cake"],
      ["toolcompact", "Cake"],
    ]);
    expect(cakeChatBuiltinSlashCommands.map((command) => command.name)).toEqual([
      "compact",
      "model",
      "sidechat",
      "schedule",
    ]);
    expect(
      cakeChatBuiltinSlashCommands.find((command) => command.name === "schedule"),
    ).toMatchObject({
      source: "builtin",
      sourceInfo: { path: "builtin:cake", source: "Cake" },
      argumentHint: "<10s|5m|2h|1d|ISO time> <message>",
    });
  });

  it("ignores non-commands and unknown commands", () => {
    expect(parseBuiltinCommand("fix the /compact handling")).toBeUndefined();
    expect(parseBuiltinCommand("/definitely-not-a-pi-builtin")).toBeUndefined();
    expect(parseBuiltinCommand("compact")).toBeUndefined();
    expect(parseBuiltinCommand("")).toBeUndefined();
  });
});

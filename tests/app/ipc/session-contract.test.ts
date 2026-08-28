import { describe, expect, it } from "vitest";
import { parsePiBuiltinCommand } from "../../../src/ipc/session-contract";

describe("parsePiBuiltinCommand", () => {
  it("parses builtin commands with and without arguments", () => {
    expect(parsePiBuiltinCommand("/compact")).toEqual({ name: "compact", args: "" });
    expect(parsePiBuiltinCommand("/compact  Keep the API details ")).toEqual({
      name: "compact",
      args: "Keep the API details",
    });
    expect(parsePiBuiltinCommand(" /MODEL")).toEqual({ name: "model", args: "" });
    expect(parsePiBuiltinCommand("/handoff Implement the plan")).toEqual({
      name: "handoff",
      args: "Implement the plan",
    });
    expect(parsePiBuiltinCommand("/handoffandresolve Implement the plan")).toEqual({
      name: "handoffandresolve",
      args: "Implement the plan",
    });
  });

  it("ignores non-commands and unknown commands", () => {
    expect(parsePiBuiltinCommand("fix the /compact handling")).toBeUndefined();
    expect(parsePiBuiltinCommand("/definitely-not-a-pi-builtin")).toBeUndefined();
    expect(parsePiBuiltinCommand("compact")).toBeUndefined();
    expect(parsePiBuiltinCommand("")).toBeUndefined();
  });
});

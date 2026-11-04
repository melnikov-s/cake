import { Schema } from "effect";
import type { VscodeControl } from "../../contracts/editor/vscode-agent-control";
import {
  EditorSelectionReveal,
  EditorSelectionsWriteResult,
  EditorSelectionState,
  EditorSelectionUpdate,
} from "../../contracts/editor/editor-selection";
import type { JsonObject, JsonValue } from "../../contracts/serialization/json-contract";

/** Shared reverse-RPC adapter; selection state remains renderer-owned. */
export function makeVscodeControl(options: {
  request(command: string, input: JsonObject, signal: AbortSignal): Promise<JsonValue | undefined>;
  runScript: VscodeControl["runScript"];
}): VscodeControl {
  const request = async (command: string, input: JsonObject, signal: AbortSignal) => {
    const response = await options.request(command, input, signal);
    const status = await Schema.decodeUnknownPromise(
      Schema.Struct({ ok: Schema.Boolean, error: Schema.optionalKey(Schema.String) }),
    )(response);
    if (!status.ok)
      throw new Error(status.error ?? "The owning renderer's VS Code controls are unavailable");
    return response;
  };
  const writeSelections = async (
    command: string,
    input: Parameters<VscodeControl["addSelections"]>[0],
    signal: AbortSignal,
  ): ReturnType<VscodeControl["addSelections"]> => {
    try {
      const response = await request(
        command,
        { selections: input.selections.map((selection) => ({ ...selection })) },
        signal,
      );
      const { update } = await Schema.decodeUnknownPromise(
        Schema.Struct({ update: EditorSelectionsWriteResult }),
      )(response);
      return { status: "completed", value: update };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("VSCODE_MODE_REQUIRED:"))
        return { status: "mode-required" };
      throw error;
    }
  };
  return {
    enter: async (signal) => {
      await request("vscode.enter", {}, signal);
    },
    open: async (location, signal) => {
      try {
        const response = await request("vscode.open", { ...location }, signal);
        const { reveal } = await Schema.decodeUnknownPromise(
          Schema.Struct({ reveal: EditorSelectionReveal }),
        )(response);
        return { status: "completed", value: reveal };
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("VSCODE_MODE_REQUIRED:"))
          return { status: "mode-required" };
        throw error;
      }
    },
    addSelections: (input, signal) => writeSelections("vscode.selections.add", input, signal),
    setSelections: (input, signal) => writeSelections("vscode.selections.set", input, signal),
    listSelections: async (signal) => {
      const response = await request("vscode.selections.list", {}, signal);
      return (
        await Schema.decodeUnknownPromise(Schema.Struct({ state: EditorSelectionState }))(response)
      ).state;
    },
    removeSelection: async (id, signal) => {
      const response = await request("vscode.selections.remove", { id }, signal);
      return (
        await Schema.decodeUnknownPromise(Schema.Struct({ update: EditorSelectionUpdate }))(
          response,
        )
      ).update;
    },
    clearSelections: async (signal) => {
      const response = await request("vscode.selections.clear", {}, signal);
      return (
        await Schema.decodeUnknownPromise(Schema.Struct({ update: EditorSelectionUpdate }))(
          response,
        )
      ).update;
    },
    runScript: options.runScript,
  };
}

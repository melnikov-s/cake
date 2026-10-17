import { Schema } from "effect";
import type { VscodeControl } from "../../contracts/editor/vscode-agent-control";
import {
  EditorSelectionOpenResult,
  EditorSelectionState,
  EditorSelectionUpdate,
} from "../../contracts/editor/editor-selection";
import type { JsonObject, JsonValue } from "../../contracts/serialization/json-contract";
import { agentEditorLocation } from "../../utils/agent-editor-location";

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
  return {
    enter: async (signal) => {
      await request("vscode.enter", {}, signal);
    },
    open: async (location, signal) => {
      try {
        const response = await request("vscode.open", agentEditorLocation(location), signal);
        const { selection } = await Schema.decodeUnknownPromise(
          Schema.Struct({ selection: EditorSelectionOpenResult }),
        )(response);
        return { status: "completed", value: selection };
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("VSCODE_MODE_REQUIRED:"))
          return { status: "mode-required" };
        throw error;
      }
    },
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

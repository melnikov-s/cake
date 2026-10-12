import { Schema } from "effect";
import type { UiPart } from "../contracts/conversations/session-contract";
import { toolOperationName } from "./cake-tool";
import {
  WorkflowOwner,
  WorkflowRunReceipt,
  WorkflowRunSummary,
} from "../contracts/workflows/workflow-data";

/** Cake Chat only observes referenced Project owners; it never owns execution. */
export function workflowOwnerReferences(parts: readonly UiPart[]): string[] {
  const owners = new Set<string>();
  for (const part of parts) {
    if (part.kind !== "tool" || !toolOperationName(part).startsWith("workflows.")) continue;
    for (const [text, request] of [
      [part.input, true],
      [part.output, false],
    ] as const) {
      if (!text) continue;
      try {
        const parsed: unknown = JSON.parse(text);
        const envelope = Schema.decodeUnknownResult(Schema.Struct({ input: Schema.Unknown }))(
          parsed,
        );
        const resultEnvelope = Schema.decodeUnknownResult(
          Schema.Struct({ result: Schema.Unknown }),
        )(parsed);
        const value =
          request && envelope._tag === "Success"
            ? envelope.success.input
            : !request && resultEnvelope._tag === "Success"
              ? resultEnvelope.success.result
              : parsed;
        const values = Array.isArray(value) ? value : [value];
        for (const candidate of values) {
          if (request) {
            const owner = Schema.decodeUnknownResult(WorkflowOwner)(candidate);
            if (owner._tag === "Success") owners.add(owner.success.sessionId);
          } else {
            const receipt = Schema.decodeUnknownResult(WorkflowRunReceipt)(candidate);
            const summary = Schema.decodeUnknownResult(WorkflowRunSummary)(candidate);
            if (receipt._tag === "Success") owners.add(receipt.success.sessionId);
            if (summary._tag === "Success") owners.add(summary.success.ownerSessionId);
          }
        }
      } catch {
        /* Incomplete streaming tool input/output has no observation demand yet. */
      }
    }
  }
  return [...owners];
}

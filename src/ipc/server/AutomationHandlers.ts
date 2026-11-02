import { Effect, Stream } from "effect";
import { AutomationRpc } from "../protocol/AutomationRpc";
import {
  AutomationError,
  type AutomationDefinition,
} from "../../contracts/automations/automation-data";
import { admitTurnAttachments } from "./AttachmentUploadHandlers";
import * as definitions from "../../domain/automations/automationDefinitions";
import * as runs from "../../domain/automations/automationRuns";
import { OptMemory } from "../../services/opt-memory/OptMemory";

const memoryError = (cause: { readonly message: string }) =>
  new AutomationError({ operation: "memory", code: "unavailable", message: cause.message });

const admitTaskAttachments = <A extends { readonly definition: AutomationDefinition }>(input: A) =>
  (input.definition.task.attachments.length
    ? admitTurnAttachments(input.definition.task)
    : Effect.succeed(input.definition.task)
  ).pipe(
    Effect.map((task) => ({ ...input, definition: { ...input.definition, task } })),
    Effect.mapError(
      (cause) =>
        new AutomationError({
          operation: "attachments",
          code: "invalid-configuration",
          message: cause.message,
        }),
    ),
  );

export const automationHandlers = AutomationRpc.of({
  "automations.observe": () => Stream.unwrap(runs.observe()),
  "automations.list": definitions.list,
  "automations.inspect": (input) => definitions.inspect(input.automationId),
  "automations.create": (input) =>
    admitTaskAttachments(input).pipe(Effect.flatMap(definitions.create)),
  "automations.update": (input) =>
    admitTaskAttachments(input).pipe(Effect.flatMap(definitions.update)),
  "automations.activate": (input) =>
    runs.activate(input.automationId).pipe(Effect.andThen(definitions.lookup(input.automationId))),
  "automations.pause": (input) => definitions.changeState(input.automationId, { _tag: "paused" }),
  "automations.archive": runs.archive,
  "automations.trigger": (input) => runs.trigger(input.automationId),
  "automations.history": definitions.history,
  "automations.cancelRun": (input) => runs.cancelRun(input.runId),
  "automations.cancelQueued": (input) => runs.cancelQueued(input.occurrenceId),
  "automations.readMemory": (input) =>
    Effect.gen(function* () {
      const automation = yield* definitions.lookup(input.automationId);
      return yield* (yield* OptMemory)
        .read({ memoryId: automation.memoryId })
        .pipe(Effect.mapError(memoryError));
    }),
  "automations.zoomMemory": (input) =>
    Effect.gen(function* () {
      const automation = yield* definitions.lookup(input.automationId);
      return yield* (yield* OptMemory)
        .zoom({
          memoryId: automation.memoryId,
          range: input.range,
          ...(input.offset === undefined ? null : { offset: input.offset }),
          ...(input.maxChars === undefined ? null : { maxChars: input.maxChars }),
        })
        .pipe(Effect.mapError(memoryError));
    }),
});

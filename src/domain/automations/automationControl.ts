import { Effect, Schema } from "effect";
import { AutomationSessionInvocation } from "../../contracts/automations/agent-automations";
import { AutomationRecords } from "../../services/automations/AutomationRecords";
import { ApplicationState } from "../../services/storage/ApplicationState";
import * as projectSessionCreation from "../project-sessions/projectSessionCreation";
import * as projects from "../projects/projects";
import { cakeModelCatalog, resolveCakeModelSelection } from "../model-presets/cake-model-selection";
import type { AutomationInspection } from "../../contracts/automations/automation-control";
import { AutomationError } from "../../contracts/automations/automation-data";
import type { JsonValue } from "../../contracts/serialization/json-contract";
import { OptMemory } from "../../services/opt-memory/OptMemory";
import { TaskInputStorage } from "../../services/storage/TaskInputStorage";
import type { Attachment } from "../../contracts/conversations/session-contract";
import * as definitions from "./automationDefinitions";
import * as runs from "./automationRuns";
import { toJsonValue } from "../../utils/to-json-value";

const forwardInputs = Effect.fn("Automations.forwardInputs")(function* (
  callerSessionId: string | undefined,
  attachments: readonly Attachment[],
) {
  const inputs = yield* TaskInputStorage;
  const parts = yield* Effect.forEach(attachments, (attachment) =>
    Effect.gen(function* () {
      if (attachment.kind !== "input") return [attachment];
      if (!callerSessionId)
        return yield* definitions.automationError(
          "forwardInputs",
          "Forwarding task inputs requires an actual calling Session.",
        );
      const grants = yield* inputs.authorizeForward(callerSessionId, [attachment.id]);
      return grants.map((reference) => ({
        kind: "forwarded-input" as const,
        name: attachment.name,
        reference,
      }));
    }),
  );
  return parts.flat();
});

/** Agent inspection stays metadata-only; task text and memory originals are independently bounded reads. */
function inspectMetadata(info: AutomationInspection) {
  const automation = info.automation;
  return {
    id: automation.id,
    state: automation.state,
    memoryId: automation.memoryId,
    createdAt: automation.createdAt,
    updatedAt: automation.updatedAt,
    nextScheduledAt: automation.nextScheduledAt,
    activity: info.activity,
    definition: {
      ...automation.definition,
      task: {
        configuration: automation.definition.task.configuration,
        promptCharacters: automation.definition.task.prompt.length,
        attachments: automation.definition.task.attachments.map((item) => ({
          kind: item.kind,
          name: "name" in item ? item.name : "Annotation",
        })),
      },
    },
  };
}

export const invoke = Effect.fn("Automations.agentControl")(
  function* (command: string, input: JsonValue, callerSessionId?: string) {
    const invocation = yield* Schema.decodeUnknownEffect(AutomationSessionInvocation)(
      { name: command, arguments: input },
      { onExcessProperty: "error" },
    );
    switch (invocation.name) {
      case "projects.list":
        return toJsonValue({
          ok: true,
          command,
          ...(yield* projects.listForAgent(invocation.arguments)),
        });
      case "projects.info":
        return toJsonValue({
          ok: true,
          command,
          ...(yield* projects.infoForAgent(invocation.arguments)),
        });
      case "sessions.create": {
        if (!callerSessionId)
          return yield* definitions.automationError(
            "createSession",
            "An automation run Session is required.",
          );
        const run = yield* runs.runForSession(callerSessionId);
        const occurrence = (yield* AutomationRecords)
          .snapshot()
          .occurrences.find((item) => item.id === run.occurrenceId);
        if (!occurrence)
          return yield* definitions.automationError(
            "createSession",
            "The automation run occurrence is missing.",
            "unavailable",
          );
        const input = invocation.arguments;
        const application = (yield* ApplicationState).snapshot();
        const model = yield* Effect.try({
          try: () =>
            resolveCakeModelSelection(
              input.model,
              cakeModelCatalog(application),
              occurrence.definition.task.configuration,
            ),
          catch: (cause) =>
            definitions.automationError(
              "createSession",
              cause instanceof Error ? cause.message : String(cause),
            ),
        });
        return toJsonValue(
          yield* Effect.scoped(
            projectSessionCreation.createPrompted({
              ...input,
              projectPath: input.workspacePath,
              model,
              source: {
                sessionId: callerSessionId,
                kind: "automation-session",
                title: occurrence.definition.name,
                workingDirectory: run.workingDirectory,
              },
              senderWorkingDirectory: run.workingDirectory,
              resultDelivery: "ignore",
            }),
          ),
        );
      }
      case "automations.list":
        return toJsonValue({
          ok: true,
          command,
          ...(yield* definitions.list(invocation.arguments)),
        });
      case "automations.inspect":
        return toJsonValue({
          ok: true,
          command,
          automation: inspectMetadata(
            yield* definitions.inspect(invocation.arguments.automationId),
          ),
        });
      case "automations.read-task": {
        const automation = yield* definitions.lookup(invocation.arguments.automationId);
        const offset = invocation.arguments.offset ?? 0;
        const text = automation.definition.task.prompt;
        if (offset > text.length)
          return yield* definitions.automationError(
            "readTask",
            "Offset exceeds the saved task length.",
          );
        const slice = text.slice(offset, offset + (invocation.arguments.maxChars ?? 4_000));
        return toJsonValue({
          ok: true,
          command,
          automationId: automation.id,
          text: slice,
          offset,
          totalChars: text.length,
          nextOffset: offset + slice.length < text.length ? offset + slice.length : null,
        });
      }
      case "automations.create": {
        const definition = invocation.arguments.definition;
        const automation = yield* definitions.create({
          ...invocation.arguments,
          definition: {
            ...definition,
            task: {
              ...definition.task,
              attachments: yield* forwardInputs(callerSessionId, definition.task.attachments),
            },
          },
        });
        return toJsonValue({
          ok: true,
          command,
          automation: inspectMetadata(yield* definitions.inspect(automation.id)),
        });
      }
      case "automations.update": {
        const current = yield* definitions.lookup(invocation.arguments.automationId);
        const changes = invocation.arguments.changes;
        const automation = yield* definitions.update({
          automationId: current.id,
          definition: {
            ...current.definition,
            ...changes,
            task: {
              ...current.definition.task,
              ...changes.task,
              attachments:
                changes.task?.attachments === undefined
                  ? current.definition.task.attachments
                  : yield* forwardInputs(callerSessionId, changes.task.attachments),
            },
          },
        });
        return toJsonValue({
          ok: true,
          command,
          automation: inspectMetadata(yield* definitions.inspect(automation.id)),
        });
      }
      case "automations.activate":
        yield* runs.activate(invocation.arguments.automationId);
        return toJsonValue({
          ok: true,
          command,
          automation: inspectMetadata(
            yield* definitions.inspect(invocation.arguments.automationId),
          ),
        });
      case "automations.pause":
        yield* definitions.changeState(invocation.arguments.automationId, { _tag: "paused" });
        return toJsonValue({
          ok: true,
          command,
          automation: inspectMetadata(
            yield* definitions.inspect(invocation.arguments.automationId),
          ),
        });
      case "automations.archive": {
        const automation = yield* runs.archive(invocation.arguments);
        return toJsonValue({
          ok: true,
          command,
          automation: inspectMetadata(yield* definitions.inspect(automation.id)),
        });
      }
      case "automations.trigger":
        return toJsonValue({
          ok: true,
          command,
          result: yield* runs.trigger(invocation.arguments.automationId, {
            _tag: "Manual",
            ...(callerSessionId ? { requestedBySessionId: callerSessionId } : null),
          }),
        });
      case "automations.cancel-run":
        yield* runs.cancelRun(invocation.arguments.runId);
        return toJsonValue({ ok: true, command, runId: invocation.arguments.runId });
      case "automations.cancel-queued":
        yield* runs.cancelQueued(invocation.arguments.occurrenceId);
        return toJsonValue({ ok: true, command, occurrenceId: invocation.arguments.occurrenceId });
      case "automations.history": {
        const page = yield* definitions.history(invocation.arguments);
        return toJsonValue({
          ok: true,
          command,
          ...page,
          occurrences: page.occurrences.map(({ definition, ...occurrence }) => ({
            ...occurrence,
            name: definition.name,
          })),
        });
      }
      case "automations.memory": {
        const automation = yield* definitions.lookup(invocation.arguments.automationId);
        return toJsonValue({
          ok: true,
          command,
          memory: yield* (yield* OptMemory).read({ memoryId: automation.memoryId }),
        });
      }
      case "automations.zoom-memory": {
        const automation = yield* definitions.lookup(invocation.arguments.automationId);
        const { automationId: _id, ...page } = invocation.arguments;
        void _id;
        return toJsonValue({
          ok: true,
          command,
          result: yield* (yield* OptMemory).zoom({ ...page, memoryId: automation.memoryId }),
        });
      }
      case "memory.read":
      case "memory.zoom":
      case "memory.write": {
        // Scope and provenance come from the actual runtime caller, never model-supplied IDs.
        if (!callerSessionId)
          return yield* definitions.automationError(
            "memory",
            "Automation memory requires an actual run Session; use automations.memory with an explicit automationId for inspection.",
          );
        const run = yield* runs.runForSession(callerSessionId);
        const automation = yield* definitions.lookup(run.automationId);
        const memory = yield* OptMemory;
        const memoryId = automation.memoryId;
        if (invocation.name === "memory.read")
          return toJsonValue({ ok: true, command, memory: yield* memory.read({ memoryId }) });
        if (invocation.name === "memory.zoom")
          return toJsonValue({
            ok: true,
            command,
            result: yield* memory.zoom({ ...invocation.arguments, memoryId }),
          });
        return toJsonValue({
          ok: true,
          command,
          result: yield* memory.write({
            memoryId,
            text: invocation.arguments.text,
            sourceSessionId: callerSessionId,
          }),
        });
      }
    }
  },
  Effect.mapError((cause) =>
    cause instanceof AutomationError
      ? cause
      : new AutomationError({ operation: "control", code: "unavailable", message: cause.message }),
  ),
);

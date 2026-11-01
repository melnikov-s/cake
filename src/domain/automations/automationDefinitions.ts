import { Cron, DateTime, Effect, FileSystem, Option, Result, Stream, Struct } from "effect";
import {
  AutomationError,
  AutomationId,
  type Automation,
  type AutomationContext,
  type AutomationDefinition,
  type AutomationListInput,
  type AutomationSchedule,
  type AutomationState,
  type AutomationSummary,
} from "../../contracts/automations/automation-data";
import type {
  AutomationCreateInput,
  AutomationHistoryInput,
  AutomationUpdateInput,
} from "../../contracts/automations/automation-control";
import { OptMemoryId } from "../../contracts/memory/opt-memory-data";
import { agentListPage } from "../../contracts/agent/agent-list-data";
import { AutomationRecords } from "../../services/automations/AutomationRecords";
import type { AutomationLedger } from "../../services/storage/AutomationStorage";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { CakeChatConfiguration } from "../../services/pi-durable/CakeChatConfiguration";

export const automationError = (
  operation: string,
  message: string,
  code: AutomationError["code"] = "invalid-configuration",
) => new AutomationError({ operation, code, message });

export const lookup = Effect.fn("Automations.lookup")(function* (id: AutomationId) {
  const records = yield* AutomationRecords;
  const automation = records.snapshot().automations.find((item) => item.id === id);
  if (!automation) return yield* automationError("inspect", "Automation not found", "not-found");
  return automation;
});

export const resolveContext = Effect.fn("Automations.resolveContext")(function* (
  context: AutomationContext,
) {
  if (context._tag === "Global") return (yield* CakeChatConfiguration).location.workingDirectory;
  const application = (yield* ApplicationState).snapshot();
  if (!application.projects.some((project) => project.path === context.projectPath))
    return yield* automationError(
      "context",
      "The selected project is no longer registered.",
      "unavailable",
    );
  if (!application.trustedProjectPaths.includes(context.projectPath))
    return yield* automationError(
      "context",
      "The selected project must be trusted before this automation can execute.",
      "unavailable",
    );
  if (
    !(yield* (yield* FileSystem.FileSystem)
      .exists(context.projectPath)
      .pipe(Effect.mapError((cause) => automationError("context", cause.message, "unavailable"))))
  )
    return yield* automationError(
      "context",
      "The selected project directory is missing.",
      "unavailable",
    );
  return context.projectPath;
});

export const nextScheduledAt = Effect.fn("Automations.nextScheduledAt")(function* (
  schedule: AutomationSchedule,
  afterMillis: number,
) {
  const startText = schedule._tag === "Once" ? schedule.at : schedule.startsAt;
  const parsed = DateTime.make(startText);
  if (Option.isNone(parsed))
    return yield* automationError("schedule", "Invalid schedule start time.");
  const start = DateTime.toEpochMillis(parsed.value);
  if (schedule._tag === "Once")
    return start > afterMillis ? DateTime.formatIso(parsed.value) : undefined;
  if (schedule._tag === "Interval") {
    const interval = schedule.everySeconds * 1_000;
    const next =
      start > afterMillis
        ? start
        : start + (Math.floor((afterMillis - start) / interval) + 1) * interval;
    return DateTime.formatIso(DateTime.makeUnsafe(next));
  }
  const cron = Cron.parse(schedule.expression, schedule.timeZone);
  if (Result.isFailure(cron)) return yield* automationError("schedule", cron.failure.message);
  return DateTime.formatIso(
    DateTime.makeUnsafe(Cron.next(cron.success, Math.max(afterMillis, start - 1))),
  );
});

const validate = Effect.fn("Automations.validateDefinition")(function* (
  definition: AutomationDefinition,
) {
  yield* resolveContext(definition.context);
  if (definition.trigger._tag === "Event") {
    const filter = definition.trigger.filter;
    if (filter.event === "session-created" && filter.contentContains !== undefined)
      return yield* automationError(
        "validate",
        "Session creation has no message content to filter.",
      );
    if (filter.scope._tag === "Global" && filter.sessionKinds.some((kind) => kind !== "cake-chat"))
      return yield* automationError(
        "validate",
        "Global event scope currently supports Cake Chat only.",
      );
    if (filter.scope._tag === "Project" && filter.sessionKinds.includes("cake-chat"))
      return yield* automationError("validate", "Global Cake Chat does not belong to a project.");
  }
});

export function summarize(automation: Automation, ledger: AutomationLedger): AutomationSummary {
  const summary: AutomationSummary = {
    id: automation.id,
    name: automation.definition.name,
    context: automation.definition.context,
    state: automation.state,
    activity: {
      runningSessions: ledger.runs.filter(
        (run) => run.automationId === automation.id && run.status._tag === "running",
      ).length,
      queuedOccurrences: ledger.occurrences.filter(
        (occurrence) =>
          occurrence.automationId === automation.id && occurrence.disposition._tag === "queued",
      ).length,
    },
  };
  if (automation.nextScheduledAt !== undefined)
    Object.assign(summary, { nextScheduledAt: automation.nextScheduledAt });
  return summary;
}

export const list = Effect.fn("Automations.list")(function* (input: AutomationListInput) {
  const ledger = (yield* AutomationRecords).snapshot();
  const context = input.context;
  const query = input.query?.toLowerCase();
  return agentListPage(
    ledger.automations
      .map((item) => summarize(item, ledger))
      .filter(
        (item) =>
          (!context ||
            (context._tag === item.context._tag &&
              (context._tag !== "Project" ||
                (item.context._tag === "Project" &&
                  context.projectPath === item.context.projectPath)))) &&
          (!input.state || input.state === item.state._tag) &&
          (!input.runningOnly || item.activity.runningSessions > 0) &&
          (!query || item.name.toLowerCase().includes(query)),
      )
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    input,
  );
});

export const inspect = Effect.fn("Automations.inspect")(function* (id: AutomationId) {
  const automation = yield* lookup(id);
  return {
    automation,
    activity: summarize(automation, (yield* AutomationRecords).snapshot()).activity,
  };
});

export const create = Effect.fn("Automations.create")(function* (input: AutomationCreateInput) {
  yield* validate(input.definition);
  const now = yield* DateTime.now;
  const next =
    input.definition.trigger._tag === "Schedule"
      ? yield* nextScheduledAt(input.definition.trigger.schedule, DateTime.toEpochMillis(now))
      : undefined;
  if (
    input.definition.trigger._tag === "Schedule" &&
    input.definition.trigger.schedule._tag === "Once" &&
    next === undefined
  )
    return yield* automationError("create", "A one-time schedule must be in the future.");
  const automation: Automation = {
    id: AutomationId.make(crypto.randomUUID()),
    definition: input.definition,
    state: { _tag: input.initialState },
    memoryId: OptMemoryId.make(crypto.randomUUID()),
    createdAt: DateTime.formatIso(now),
    updatedAt: DateTime.formatIso(now),
  };
  if (next !== undefined) Object.assign(automation, { nextScheduledAt: next });
  return yield* (yield* AutomationRecords).transact((ledger) =>
    Effect.succeed({
      ledger: { ...ledger, automations: [...ledger.automations, automation] },
      result: automation,
    }),
  );
});

export const update = Effect.fn("Automations.update")(function* (input: AutomationUpdateInput) {
  yield* validate(input.definition);
  const now = yield* DateTime.now;
  const next =
    input.definition.trigger._tag === "Schedule"
      ? yield* nextScheduledAt(input.definition.trigger.schedule, DateTime.toEpochMillis(now))
      : undefined;
  if (
    input.definition.trigger._tag === "Schedule" &&
    input.definition.trigger.schedule._tag === "Once" &&
    next === undefined
  )
    return yield* automationError("update", "A one-time schedule must be in the future.");
  return yield* (yield* AutomationRecords).transact((ledger) =>
    Effect.gen(function* () {
      const current = ledger.automations.find((item) => item.id === input.automationId);
      if (!current) return yield* automationError("update", "Automation not found", "not-found");
      const automation: Automation = {
        ...Struct.omit(current, ["nextScheduledAt"]),
        definition: input.definition,
        updatedAt: DateTime.formatIso(now),
      };
      if (next !== undefined) Object.assign(automation, { nextScheduledAt: next });
      return {
        ledger: {
          ...ledger,
          automations: ledger.automations.map((item) =>
            item.id === automation.id ? automation : item,
          ),
        },
        result: automation,
      };
    }),
  );
});

/** Lifecycle metadata transition. Cancellation and queued-session admission are composed by the caller. */
export const changeState = Effect.fn("Automations.changeState")(function* (
  id: AutomationId,
  state: AutomationState,
) {
  const now = yield* DateTime.now;
  return yield* (yield* AutomationRecords).transact((ledger) =>
    Effect.gen(function* () {
      const current = ledger.automations.find((item) => item.id === id);
      if (!current) return yield* automationError("state", "Automation not found", "not-found");
      let automation: Automation = { ...current, state, updatedAt: DateTime.formatIso(now) };
      if (state._tag === "active") {
        automation = Struct.omit(automation, ["nextScheduledAt"]);
        if (current.definition.trigger._tag === "Schedule") {
          const next = yield* nextScheduledAt(
            current.definition.trigger.schedule,
            DateTime.toEpochMillis(now),
          );
          if (next !== undefined) Object.assign(automation, { nextScheduledAt: next });
        }
      }
      return {
        ledger: {
          ...ledger,
          automations: ledger.automations.map((item) => (item.id === id ? automation : item)),
          occurrences: ledger.occurrences.map((item) =>
            state._tag === "archived" &&
            item.automationId === id &&
            item.disposition._tag === "queued"
              ? {
                  ...item,
                  disposition: { _tag: "canceled" as const, reason: "Automation archived." },
                }
              : item,
          ),
        },
        result: automation,
      };
    }),
  );
});

export const history = Effect.fn("Automations.history")(function* (input: AutomationHistoryInput) {
  yield* lookup(input.automationId);
  const ledger = (yield* AutomationRecords).snapshot();
  const occurrences = ledger.occurrences
    .filter((item) => item.automationId === input.automationId)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id));
  const page = agentListPage(occurrences, input);
  const occurrenceIds = new Set(page.items.map((item) => item.id));
  return {
    occurrences: page.items,
    runs: ledger.runs.filter((item) => occurrenceIds.has(item.occurrenceId)),
    total: page.total,
    nextOffset: page.nextOffset,
  };
});

export const observeDefinitions = Effect.fn("Automations.observeDefinitions")(function* () {
  return (yield* AutomationRecords).changes().pipe(
    Stream.map((ledger) => ({
      revision: ledger.revision,
      automations: ledger.automations.map((item) => summarize(item, ledger)),
    })),
  );
});

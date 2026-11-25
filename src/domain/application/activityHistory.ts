import { Effect } from "effect";
import {
  activityPageSize,
  type ActivityPage,
  type ActivityEntry,
  type ActivityQuery,
} from "../../contracts/application/activity-history";
import type { AutomationEventKind } from "../../contracts/automations/automation-data";
import {
  AutomationRecords,
  type AutomationRecordSnapshot,
} from "../../services/automations/AutomationRecords";
import { ActivityHistory } from "../../services/storage/ActivityHistory";

const eventLabels = {
  "session-created": "Session created",
  "user-message-received": "User message received",
  "assistant-response-completed": "Assistant response completed",
} satisfies Record<AutomationEventKind, string>;

/** Join admission and settlement receipts rather than recording a second automation ledger. */
export function automationActivity(ledger: AutomationRecordSnapshot): ActivityEntry[] {
  const runs = new Map(ledger.runs.map((run) => [run.occurrenceId, run]));
  const rules = new Map(ledger.automations.map((automation) => [automation.id, automation]));
  return ledger.occurrences.map((item) => {
    const { source, disposition, definition } = item;
    const run = runs.get(item.id);
    const status = run?.status ?? disposition;
    const rule = rules.get(item.automationId);
    const state = rule?.state;
    const detail =
      "reason" in status
        ? status.reason
        : disposition._tag === "queued" && state?._tag === "suspended"
          ? state.reason
          : undefined;
    const projectPath =
      definition.context._tag === "Project"
        ? definition.context.projectPath
        : source._tag === "Event"
          ? source.projectPath
          : undefined;
    const sourceSessionId =
      source._tag === "Event"
        ? source.sourceSessionId
        : source._tag === "Manual"
          ? source.requestedBySessionId
          : undefined;
    const entry = {
      id: `automation:${item.id}`,
      at: "finishedAt" in status ? status.finishedAt : (run?.startedAt ?? item.occurredAt),
      kind: "automation" as const,
      title: definition.name,
      trigger:
        source._tag === "Manual"
          ? "Manual run"
          : source._tag === "Schedule"
            ? `Scheduled for ${source.scheduledAt}`
            : eventLabels[source.event],
      outcome:
        status._tag === "queued" && state?._tag === "suspended"
          ? "Queued · suspended"
          : status._tag.charAt(0).toUpperCase() + status._tag.slice(1),
    };
    if (detail !== undefined) Object.assign(entry, { detail });
    if (projectPath !== undefined) Object.assign(entry, { projectPath });
    if (sourceSessionId !== undefined) Object.assign(entry, { sourceSessionId });
    if (source._tag === "Event" && source.sourceMessageId !== undefined)
      Object.assign(entry, { sourceMessageId: source.sourceMessageId });
    if (rule) Object.assign(entry, { automationId: rule.id });
    if (run) Object.assign(entry, { automationRun: run });
    return entry;
  });
}

// IDs and timestamps are ASCII, matching the SQLite binary order of journal rows.
const compare = (a: Pick<ActivityEntry, "at" | "id">, b: Pick<ActivityEntry, "at" | "id">) =>
  a.at === b.at ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.at < b.at ? 1 : -1;

export const listActivity = Effect.fn("ActivityHistory.listActivity")(function* (
  query: ActivityQuery,
) {
  const journal = yield* (yield* ActivityHistory).list(query);
  const automation =
    query.kind === undefined || query.kind === "automation"
      ? automationActivity((yield* AutomationRecords).snapshot()).filter(
          (entry) =>
            (query.projectPath === undefined ||
              (entry.projectPath ?? null) === query.projectPath) &&
            (!query.before || compare(entry, query.before) > 0),
        )
      : [];
  const page = [...journal, ...automation].sort(compare);
  const entries = page.slice(0, activityPageSize);
  const last = entries.at(-1);
  const result: ActivityPage = { entries };
  if (last && page.length > entries.length)
    Object.assign(result, { next: { id: last.id, at: last.at } });
  return result;
});

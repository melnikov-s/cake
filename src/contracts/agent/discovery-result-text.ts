import { Schema } from "effect";
import { TaskInputReference } from "../conversations/task-input";
import { MessageListResult } from "../conversations/message-reference";
import type { JsonValue } from "../serialization/json-contract";
import { SettingsListOutput } from "../application/settings-catalog";

export const compactDiscoveryGuidance =
  "Text uses tab-separated metadata rows: 1/0 booleans, - absent. Cells with tabs/newlines/quotes/backslashes are JSON-quoted. next=N continues with offset; after=ID with after. Declared structured results stay unchanged.";

// These are display projections, not replacement output/storage contracts. Session
// identity fields may already be shortened or task-input metadata redacted.
const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const page = { total: count, nextOffset: Schema.NullOr(count) };
const projects = Schema.Struct({
  ...page,
  projects: Schema.Array(
    Schema.Struct({ path: Schema.String, name: Schema.String, projectChatId: Schema.String }),
  ),
});
const family = Schema.Struct({
  ...page,
  familyId: Schema.String,
  rootSessionId: Schema.String,
  currentSessionId: Schema.String,
  sessions: Schema.Array(
    Schema.Struct({
      sessionId: Schema.String,
      familyParentSessionId: Schema.optionalKey(Schema.String),
      status: Schema.String,
      title: Schema.String,
    }),
  ),
});
const reports = Schema.Struct({
  ...page,
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      admissions: count,
      source: Schema.optionalKey(
        Schema.Struct({
          sessionId: Schema.String,
          handleId: Schema.optionalKey(Schema.String),
          status: Schema.optionalKey(Schema.String),
          task: Schema.optionalKey(Schema.String),
          title: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
});
const models = Schema.Struct({
  ...page,
  presets: Schema.Array(Schema.Struct({ name: Schema.String, default: Schema.Boolean })),
});
const attachments = Schema.Struct({
  references: Schema.Array(
    TaskInputReference.pipe(
      Schema.fieldsAssign({
        reference: TaskInputReference.fields.id,
        deepLink: Schema.String,
      }),
    ),
  ),
  nextAfter: Schema.NullOr(TaskInputReference.fields.id),
});
const automations = Schema.Struct({
  ...page,
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      state: Schema.Struct({ _tag: Schema.String }),
      activity: Schema.Struct({ runningSessions: count, queuedOccurrences: count }),
      context: Schema.TaggedUnion({ Global: {}, Project: { projectPath: Schema.String } }),
      nextScheduledAt: Schema.optionalKey(Schema.String),
    }),
  ),
});
const automationHistory = Schema.Struct({
  ...page,
  occurrences: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      automationId: Schema.String,
      occurredAt: Schema.String,
      source: Schema.Struct({
        _tag: Schema.String,
        sourceSessionId: Schema.optionalKey(Schema.String),
        requestedBySessionId: Schema.optionalKey(Schema.String),
      }),
      disposition: Schema.Struct({
        _tag: Schema.String,
        reason: Schema.optionalKey(Schema.String),
      }),
    }),
  ),
  runs: Schema.Array(
    Schema.Struct({
      occurrenceId: Schema.String,
      sessionId: Schema.String,
      status: Schema.Struct({ _tag: Schema.String }),
    }),
  ),
});
const settingsList = Schema.Struct({ value: SettingsListOutput });
const error = Schema.Struct({ ok: Schema.Literal(false) });

type Cell = string | number | boolean | undefined | null;

/** Keep exact routing strings lossless and every record on one physical line. */
function cell(value: Cell): string {
  if (value === undefined || value === null) return "-";
  if (value === true) return "1";
  if (value === false) return "0";
  const text = String(value);
  return /[\t\r\n"\\]/.test(text) || text === "" || text === "-" ? JSON.stringify(text) : text;
}

/** Setting values stay literal: true/false and null, objects as compact JSON. */
function valueCell(value: JsonValue | undefined): string {
  if (value === undefined) return "-";
  if (Schema.is(Schema.String)(value)) return cell(value);
  return JSON.stringify(value);
}

const row = (cells: readonly Cell[]) => cells.map(cell).join("\t");
const heading = (noun: string, result: { total: number; nextOffset: number | null }) =>
  `${result.total} ${noun}${result.nextOffset === null ? "" : `; next=${result.nextOffset}`}`;
const table = (header: string, columns: readonly string[], rows: readonly (readonly Cell[])[]) =>
  [header, ...(rows.length ? [row(columns), ...rows.map(row)] : [])].join("\n");

/** Opt-in discovery text only, after authorization/redaction and identity projection.
 * The registry retains the original validated result for details and typed callers.
 * Non-discovery operations and error objects keep their existing presentation. */
export function discoveryResultText(command: string, value: JsonValue): string | undefined {
  if (Schema.is(error)(value)) return undefined;
  switch (command) {
    case "automations.list": {
      const result = Schema.decodeUnknownSync(automations)(value);
      return table(
        heading("automations", result),
        ["id", "state", "running", "queued", "context", "next", "name"],
        result.items.map((item) => [
          item.id,
          item.state._tag,
          item.activity.runningSessions,
          item.activity.queuedOccurrences,
          item.context._tag === "Global" ? "global" : item.context.projectPath,
          item.nextScheduledAt,
          item.name,
        ]),
      );
    }
    case "automations.history": {
      const result = Schema.decodeUnknownSync(automationHistory)(value);
      return table(
        heading("occurrences", result),
        [
          "id",
          "automation",
          "trigger",
          "status",
          "session",
          "when",
          "sourceSession",
          "reason",
          "name",
        ],
        result.occurrences.map((item) => {
          const run = result.runs.find((candidate) => candidate.occurrenceId === item.id);
          return [
            item.id,
            item.automationId,
            item.source._tag,
            run?.status._tag ?? item.disposition._tag,
            run?.sessionId,
            item.occurredAt,
            item.source._tag === "Event"
              ? item.source.sourceSessionId
              : item.source._tag === "Manual"
                ? item.source.requestedBySessionId
                : undefined,
            "reason" in item.disposition ? item.disposition.reason : undefined,
            item.name,
          ];
        }),
      );
    }
    case "projects.list": {
      const result = Schema.decodeUnknownSync(projects)(value);
      return table(
        heading("projects", result),
        ["path", "name", "projectChatId"],
        result.projects.map((item) => [item.path, item.name, item.projectChatId]),
      );
    }
    case "sessions.list-family": {
      const result = Schema.decodeUnknownSync(family)(value);
      const header = `${heading("members", result)}\nfamily=${cell(result.familyId)} root=${cell(result.rootSessionId)} caller=${cell(result.currentSessionId)}`;
      return table(
        header,
        ["id", "parent", "status", "title"],
        result.sessions.map((item) => [
          item.sessionId,
          item.familyParentSessionId,
          item.status,
          item.title,
        ]),
      );
    }
    case "sessions.reports": {
      const result = Schema.decodeUnknownSync(reports)(value);
      return table(
        heading("pending reports", result),
        ["id", "admissions", "session", "handle", "status", "task"],
        result.items.map((item) => [
          item.id,
          item.admissions,
          item.source?.sessionId,
          item.source?.handleId,
          item.source?.status,
          item.source?.task ?? item.source?.title,
        ]),
      );
    }
    case "models.list": {
      const result = Schema.decodeUnknownSync(models)(value);
      return table(
        heading("presets", result),
        ["default", "name"],
        result.presets.map((item) => [item.default, item.name]),
      );
    }
    case "attachments.list": {
      const result = Schema.decodeUnknownSync(attachments)(value);
      const header = `${result.references.length} attachments (page)${result.nextAfter === null ? "" : `; after=${cell(result.nextAfter)}`}`;
      return table(
        header,
        ["reference", "mime", "bytes", "name", "link"],
        result.references.map((item) => [
          item.reference,
          item.mimeType,
          item.byteLength,
          item.name,
          item.deepLink,
        ]),
      );
    }
    case "messages.list": {
      const result = Schema.decodeUnknownSync(MessageListResult)(value);
      const lines = [
        `${heading("messages", result)}; branch=${result.branch}`,
        ...(result.messages.length ? [row(["role", "active", "images", "timestamp", "ref"])] : []),
      ];
      if (result.messages.some((item) => item.inputRefs.length))
        lines.push("input rows: id\tmime\tbytes\tname (belong to preceding message)");
      for (const message of result.messages) {
        lines.push(
          row([message.role, message.active, message.hasImages, message.timestamp, message.ref]),
        );
        for (const input of message.inputRefs)
          lines.push(row(["input", input.id, input.mimeType, input.byteLength, input.name]));
      }
      return lines.join("\n");
    }
    case "settings.list": {
      const result = Schema.decodeUnknownSync(settingsList)(value).value;
      if ("categories" in result)
        return [
          `${result.categories.length} categories. settings.list {"category":"…"} lists one; {"query":"…"} searches all.`,
          row(["category", "settings", "changed"]),
          ...result.categories.map((item) => row([item.category, item.settings, item.changed])),
          "Elsewhere:",
          ...result.elsewhere.map(([area, operations]) => row([area, operations])),
          `Not agent-writable: ${result.notAgentWritable}`,
        ].join("\n");
      return [
        `${result.settings.length} settings; default shown only when changed; settings.get for full text`,
        ...(result.settings.length ? [row(["key", "value", "default", "type"])] : []),
        ...result.settings.map((item) =>
          [item.key, valueCell(item.value), valueCell(item.default), item.type].join("\t"),
        ),
        ...(result.elsewhere.length
          ? ["Elsewhere:", ...result.elsewhere.map(([area, operations]) => row([area, operations]))]
          : []),
      ].join("\n");
    }
    default:
      return undefined;
  }
}

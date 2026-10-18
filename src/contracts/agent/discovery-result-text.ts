import { Schema } from "effect";
import { TaskInputReference } from "../conversations/task-input";
import { MessageListResult } from "../conversations/message-reference";
import type { JsonValue } from "../serialization/json-contract";

export const compactDiscoveryGuidance =
  "Text uses tab-separated metadata rows: 1/0 booleans, - absent. Cells with tabs/newlines/quotes/backslashes are JSON-quoted. next=N continues with offset; after=ID with after. Declared structured results stay unchanged.";

// These are display projections, not replacement output/storage contracts. Session
// identity fields may already be shortened or task-input metadata redacted.
const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const page = { total: count, nextOffset: Schema.NullOr(count) };
const projects = Schema.Struct({
  ...page,
  projects: Schema.Array(Schema.Struct({ path: Schema.String, name: Schema.String })),
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
    case "projects.list": {
      const result = Schema.decodeUnknownSync(projects)(value);
      return table(
        heading("projects", result),
        ["path", "name"],
        result.projects.map((item) => [item.path, item.name]),
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
    default:
      return undefined;
  }
}

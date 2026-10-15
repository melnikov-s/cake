import { Option, Schema, SchemaIssue } from "effect";

const MAX_DEPTH = 6;
const MAX_LENGTH = 16_384;

const formatIssue = SchemaIssue.makeFormatterDefault();
const isText = Schema.is(Schema.String);

/** Failure payloads seen in practice: Errors, `{ message, issues }` objects, and SchemaErrors. */
const FailureDetails = Schema.Struct({
  message: Schema.optional(Schema.Unknown),
  issues: Schema.optional(Schema.Array(Schema.Unknown)),
  issue: Schema.optional(Schema.Unknown),
});
const decodeFailureDetails = Schema.decodeUnknownOption(FailureDetails);

const stringify = (cause: unknown): string => {
  try {
    return JSON.stringify(cause) ?? String(cause);
  } catch {
    return String(cause);
  }
};

const describe = (cause: unknown, depth: number): string | undefined => {
  if (cause === undefined || cause === null) return undefined;
  if (isText(cause)) return cause.length > 0 ? cause : undefined;
  if (SchemaIssue.isIssue(cause)) return formatIssue(cause);
  const details = decodeFailureDetails(cause);
  if (Option.isNone(details)) return String(cause);
  if (depth >= MAX_DEPTH) return stringify(cause);

  const { message: rawMessage, issues, issue } = details.value;
  const parts: string[] = [];
  const message = describe(rawMessage, depth + 1);
  if (message !== undefined) parts.push(message);
  if (issues !== undefined) {
    const described = issues.flatMap((item) => describe(item, depth + 1) ?? []);
    if (described.length > 0) parts.push(described.join("; "));
  } else if (message === undefined) {
    const described = describe(issue, depth + 1);
    if (described !== undefined) parts.push(described);
  }
  if (parts.length > 0) return parts.join(": ");
  if (cause instanceof Error) return cause.name || String(cause);
  return stringify(cause);
};

/**
 * Normalizes any failure value into the plain string required by `SubagentError.message`.
 * Nested `message` values, `issues` arrays, and Effect Schema issues are flattened so the
 * parent sees the real cause instead of a validation failure on the error itself.
 */
export const subagentErrorMessage = (cause: unknown): string =>
  (describe(cause, 0) ?? "Unknown subagent failure").slice(0, MAX_LENGTH);

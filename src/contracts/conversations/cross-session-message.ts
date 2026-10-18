import { Effect, Option, Schema } from "effect";
import { ResultDelivery, migrateResultDelivery } from "./result-delivery";
import { sessionReference } from "../project-sessions/session-reference";

const boundedId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const boundedLabel = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024));
const boundedPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096));
const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const positiveInt = Schema.Int.check(Schema.isGreaterThan(0));

/** Estimated Pi context occupancy captured at one point in time. */
export const CrossSessionContextSnapshot = Schema.Struct({
  usedTokens: Schema.NullOr(nonNegativeInt),
  windowTokens: Schema.NullOr(positiveInt),
});
export interface CrossSessionContextSnapshot extends Schema.Schema.Type<
  typeof CrossSessionContextSnapshot
> {}

/** Advisory position of one message in a live Pi delivery lane. */
export const CrossSessionQueueSnapshot = Schema.Struct({
  itemId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
  lane: Schema.Literals(["steering", "follow-up"]),
  position: positiveInt,
  length: positiveInt,
});
export interface CrossSessionQueueSnapshot extends Schema.Schema.Type<
  typeof CrossSessionQueueSnapshot
> {}

export function crossSessionContextSnapshot(
  context: { readonly tokens: number | null; readonly contextWindow: number } | null | undefined,
): CrossSessionContextSnapshot {
  return {
    usedTokens: context?.tokens ?? null,
    windowTokens: context?.contextWindow ?? null,
  };
}

/** Cake routing metadata encoded into an ordinary Pi user message. */
export const CrossSessionMessageMetadata = Schema.Struct({
  version: Schema.Literal(1),
  messageId: Schema.String.check(Schema.isUUID(4)),
  threadId: Schema.String.check(Schema.isUUID(4)),
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  expectsResponse: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  replyToMessageId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
  resultDelivery: Schema.optionalKey(ResultDelivery),
  generatedNotice: Schema.optionalKey(Schema.Boolean),
  context: Schema.optionalKey(CrossSessionContextSnapshot),
  sender: Schema.Struct({
    sessionId: boundedId,
    title: boundedLabel,
    kind: Schema.Literals(["project-session", "cake-chat"]),
    projectName: Schema.optionalKey(boundedLabel),
    workingDirectory: Schema.optionalKey(boundedPath),
  }),
  maxMessages: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000)),
  ),
});
export interface CrossSessionMessageMetadata extends Schema.Schema.Type<
  typeof CrossSessionMessageMetadata
> {}

// Persisted Pi envelopes can outlive the application version that accepted them.
const StoredMessageMetadata = Schema.Struct({
  ...CrossSessionMessageMetadata.fields,
  report: Schema.optionalKey(Schema.Literals(["digest", "interrupt", "silent"])),
  continuation: Schema.optionalKey(Schema.Literals(["none", "resume"])),
});
const prefix = "<cake-session-message>";
const suffix = "</cake-session-message>";

export function encodeCrossSessionMessage(text: string, metadata: CrossSessionMessageMetadata) {
  const validated = Schema.decodeUnknownSync(CrossSessionMessageMetadata)({
    ...metadata,
    resultDelivery: migrateResultDelivery(metadata),
    expectsResponse: migrateResultDelivery(metadata) !== "ignore",
  });
  return `${prefix}${JSON.stringify(validated)}${suffix}\n\n${text}`;
}

/** Provider-context projection only; persisted routing metadata stays canonical. */
export function projectCrossSessionMessageForAgent(
  content: string,
  knownSessionIds: readonly string[],
): string {
  const parsed = parseCrossSessionMessage(content);
  if (!parsed) return content;
  const { sender } = parsed.metadata;
  const ref = sessionReference(sender.sessionId, knownSessionIds);
  const fallbackTitle =
    sender.title === `Session ${sender.sessionId}` ||
    sender.title === `Project Session ${sender.sessionId}`;
  const noticePrefix = `Session ${sender.sessionId}`;
  const text =
    (parsed.metadata.generatedNotice || parsed.text.startsWith(`${noticePrefix} — `)) &&
    parsed.text.startsWith(noticePrefix)
      ? `Session ${ref}${parsed.text.slice(noticePrefix.length)}`
      : parsed.text;
  return encodeCrossSessionMessage(text, {
    ...parsed.metadata,
    sender: { ...sender, sessionId: ref, title: fallbackTitle ? `Session ${ref}` : sender.title },
  });
}

/** Result labels a session may attach to the report it hands back to its requester. */
export type CrossSessionReportOutcome = "result" | "completed" | "blocked" | "failed";
const reportOutcomes: ReadonlySet<string> = new Set<CrossSessionReportOutcome>([
  "result",
  "completed",
  "blocked",
  "failed",
]);
const isReportOutcome = (value: string): value is CrossSessionReportOutcome =>
  reportOutcomes.has(value);

/** Lifecycle facts Cake reports on a session's behalf when it handed back no result. */
export type CrossSessionNotice =
  | { readonly kind: "canceled" }
  | { readonly kind: "failed" }
  | { readonly kind: "no-result" }
  | { readonly kind: "no-reply"; readonly requestMessageId: string }
  /** A deliberate, attributed stop, e.g. "stopped by the user (wrong project)". */
  | { readonly kind: "stopped"; readonly stoppedBy: string }
  | {
      readonly kind: "interrupted";
      readonly reason: "canceled" | "failed" | "stopped";
      readonly requestMessageId: string;
      /** Attribution of a deliberate stop; replaces the generic canceled wording. */
      readonly stoppedBy?: string;
    };

const interruptedReasonText = {
  canceled: "was canceled or interrupted (not completed)",
  failed: "stopped with an error",
  stopped: "stopped",
} as const;

/** Agent-facing body of a session's result handoff. The leading line is parsed back for display. */
export function formatCrossSessionReportText(
  sessionId: string,
  outcome: CrossSessionReportOutcome,
  text: string,
) {
  return `Session ${sessionId} — ${outcome}\n\n${text}`;
}

/** Agent-facing body of a generated lifecycle notice (`generatedNotice: true`). */
export function formatCrossSessionNoticeText(sessionId: string, notice: CrossSessionNotice) {
  const session = `Session ${sessionId}`;
  switch (notice.kind) {
    case "canceled":
      return `${session} was canceled or interrupted; no successful result handoff occurred.`;
    case "failed":
      return `${session} failed; no successful result handoff occurred.`;
    case "no-result":
      return `${session} stopped without a substantive result. This is not a successful completion.`;
    case "no-reply":
      return `${session} stopped without replying to request ${notice.requestMessageId}.`;
    case "stopped":
      return `${session} was ${notice.stoppedBy}; no result handoff occurred.`;
    case "interrupted":
      return `${session} ${notice.stoppedBy ? `was ${notice.stoppedBy} (not completed)` : interruptedReasonText[notice.reason]} while processing message ${notice.requestMessageId}.`;
  }
}

function parseNoticeText(sessionId: string, text: string): CrossSessionNotice | undefined {
  const prefix = `Session ${sessionId} `;
  if (!text.startsWith(prefix)) return undefined;
  const fixed = (["canceled", "failed", "no-result"] as const).find(
    (kind) => formatCrossSessionNoticeText(sessionId, { kind }) === text,
  );
  if (fixed) return { kind: fixed };
  const rest = text.slice(prefix.length);
  const noReply = /^stopped without replying to request (\S+)\.$/.exec(rest);
  if (noReply?.[1]) return { kind: "no-reply", requestMessageId: noReply[1] };
  const stopped = /^was (stopped by .+); no result handoff occurred\.$/s.exec(rest);
  if (stopped?.[1]) return { kind: "stopped", stoppedBy: stopped[1] };
  const stoppedWhile =
    /^was (stopped by .+) \(not completed\) while processing message (\S+)\.$/s.exec(rest);
  if (stoppedWhile?.[1] && stoppedWhile[2])
    return {
      kind: "interrupted",
      reason: "canceled",
      requestMessageId: stoppedWhile[2],
      stoppedBy: stoppedWhile[1],
    };
  for (const reason of ["canceled", "failed", "stopped"] as const) {
    const lead = `${interruptedReasonText[reason]} while processing message `;
    if (rest.startsWith(lead) && rest.endsWith(".") && !rest.slice(lead.length, -1).includes(" "))
      return { kind: "interrupted", reason, requestMessageId: rest.slice(lead.length, -1) };
  }
  return undefined;
}

/** Display-only reading of a parsed message: what it is, its status, and the body to show. */
export interface CrossSessionMessageDescription {
  readonly relation: "request" | "reply" | "notice";
  /** Present when the body led with Cake's `Session <id> — <outcome>` report line. */
  readonly outcome?: CrossSessionReportOutcome;
  /** Present for recognized generated notices; the body is then empty. */
  readonly notice?: CrossSessionNotice;
  readonly expectsResponse: boolean;
  readonly resultDelivery?: ResultDelivery;
  /** Body without Cake's own leading report or notice text. Unrecognized text is kept whole. */
  readonly body: string;
}

export function describeCrossSessionMessage(
  text: string,
  metadata: CrossSessionMessageMetadata,
): CrossSessionMessageDescription {
  const sessionId = metadata.sender.sessionId;
  const common = {
    expectsResponse: metadata.expectsResponse,
    resultDelivery: metadata.resultDelivery,
  };
  const notice = metadata.generatedNotice ? parseNoticeText(sessionId, text.trim()) : undefined;
  if (notice) return { ...common, relation: "notice", notice, body: "" };
  const relation = metadata.generatedNotice
    ? "notice"
    : metadata.replyToMessageId
      ? "reply"
      : "request";
  const lead = `Session ${sessionId} — `;
  if (text.startsWith(lead)) {
    const end = text.indexOf("\n", lead.length);
    const outcome = text.slice(lead.length, end < 0 ? undefined : end).trim();
    if (isReportOutcome(outcome))
      return {
        ...common,
        relation,
        outcome,
        body: end < 0 ? "" : text.slice(end).trim(),
      };
  }
  return { ...common, relation, body: text };
}

export function parseCrossSessionMessage(
  content: string,
): { readonly text: string; readonly metadata: CrossSessionMessageMetadata } | undefined {
  if (!content.startsWith(prefix)) return undefined;
  const end = content.indexOf(suffix, prefix.length);
  if (end < 0) return undefined;
  try {
    const decoded = Schema.decodeUnknownOption(StoredMessageMetadata)(
      JSON.parse(content.slice(prefix.length, end)),
    );
    if (Option.isNone(decoded)) return undefined;
    const resultDelivery = migrateResultDelivery(decoded.value);
    return {
      metadata: Schema.decodeUnknownSync(CrossSessionMessageMetadata)({
        ...decoded.value,
        resultDelivery,
        expectsResponse: resultDelivery !== "ignore",
      }),
      text: content
        .slice(end + suffix.length)
        .replace(/^\s*\n/, "")
        .trimStart(),
    };
  } catch {
    return undefined;
  }
}

import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { Option, Schema } from "effect";
import {
  decodeArtifactPointer,
  type ArtifactPointer,
} from "../../../contracts/artifacts/artifact-contract";
import {
  InterviewEntry,
  InterviewResult,
  type InterviewRecord,
} from "../../../contracts/interviews/interview";
import { TurnStop } from "../../../contracts/conversations/turn-stop";
import type { SessionTreeEntry, UiPart } from "../../../contracts/conversations/session-contract";
import {
  internalInputOrigins,
  internalInputPart,
  subagentCompletionPart,
  subagentCompletionType,
} from "./internal-input-projection";
import { createSystemContextProjector } from "./system-context-projection";
import { toolPruneEntryType, toolPruneMarkerSchema } from "./tool-prune-provenance";
import { partsFromMessage, type AbortPresentation } from "./message-projection";
import { boundedProjectionKey, formatUnknown, textFromContent } from "./tool-projection";
import { visibleUserMessageText } from "./user-message-transport";
import { splitContextReminders } from "./session-context-reminders";
import { inheritedContextEntryIds } from "./agent-context-fork";

export const reviewRunEntryType = "cake.review-run/v1";
export const userMessagePresentationEntryType = "cake.user-message-presentation/v1";
/** Presentation-only provenance: an intentional interruption is not a provider failure. */
export const turnHandoffEntryType = "cake.turn-handoff/v1";
const turnHandoffEntrySchema = Schema.Struct({ timestamp: Schema.Number });
/** Presentation-only provenance: a deliberate stop names who stopped it and is not a failure. */
export const turnStopEntryType = "cake.turn-stop/v1";
const turnStopEntrySchema = Schema.Struct({ timestamp: Schema.Number, stop: TurnStop });

export const userMessagePresentationEntrySchema = Schema.Struct({
  targetId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  renderAs: Schema.Literals(["markdown", "plain"]),
});
export type UserMessagePresentation = typeof userMessagePresentationEntrySchema.Type;
export const reviewRunEntrySchema = Schema.Struct({
  operationId: Schema.String.check(Schema.isUUID()),
  threadIds: Schema.Array(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  commentCount: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000_000)),
  status: Schema.Literals(["running", "complete", "error"]),
});
export type ReviewRunEntry = typeof reviewRunEntrySchema.Type;

export function reviewRunPart(run: ReviewRunEntry): Extract<UiPart, { kind: "review-run" }> {
  return { id: `review-run-${run.operationId}`, kind: "review-run", ...run };
}

export function projectSessionEntries(
  entries: readonly SessionEntry[],
  branchEntries: readonly SessionEntry[] = entries,
  options: { live?: boolean } = {},
) {
  const projected: UiPart[] = [];
  const indexes = new Map<string, number>();
  const artifactOrigins = new Map<
    string,
    { lineageId: string; revision: number; reference?: string; originEntryId: string }
  >();
  const interviews = new Map<string, InterviewRecord>();
  const append = (part: UiPart) => {
    const existingIndex = indexes.get(part.id);
    if (existingIndex === undefined) {
      indexes.set(part.id, projected.length);
      projected.push(part);
      return;
    }
    const existing = projected[existingIndex];
    projected[existingIndex] =
      existing?.kind === "tool" && part.kind === "tool"
        ? {
            ...existing,
            ...part,
            input: part.input || existing.input,
            filePath: part.filePath || existing.filePath,
          }
        : part;
  };

  const visibleRunIds = new Set(
    entries.flatMap((entry) => {
      if (entry.type !== "custom" || entry.customType !== reviewRunEntryType) return [];
      const run = Schema.decodeUnknownOption(reviewRunEntrySchema)(entry.data);
      return Option.isSome(run) ? [run.value.operationId] : [];
    }),
  );
  const compactedRuns = new Map<string, ReviewRunEntry>();
  for (const entry of branchEntries) {
    if (entry.type !== "custom" || entry.customType !== reviewRunEntryType) continue;
    const run = Schema.decodeUnknownOption(reviewRunEntrySchema)(entry.data);
    if (Option.isSome(run) && !visibleRunIds.has(run.value.operationId))
      compactedRuns.set(run.value.operationId, run.value);
  }
  for (const run of compactedRuns.values()) append(reviewRunPart(run));

  const userMessagePresentations = new Map<string, UserMessagePresentation["renderAs"]>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== userMessagePresentationEntryType) continue;
    const presentation = Schema.decodeUnknownOption(userMessagePresentationEntrySchema)(entry.data);
    if (Option.isSome(presentation))
      userMessagePresentations.set(presentation.value.targetId, presentation.value.renderAs);
  }

  // Tool Prune carries Pi's canonical baseline without injecting new instructions.
  // Identify that exact checkpoint from display metadata, including in ordinary
  // forks whose replay prefix ends before the full compaction provenance entry.
  const systemCheckpoints = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== toolPruneEntryType) continue;
    const marker = Schema.decodeUnknownOption(toolPruneMarkerSchema)(entry.data);
    if (Option.isSome(marker) && marker.value.systemCheckpointEntryId)
      systemCheckpoints.add(marker.value.systemCheckpointEntryId);
  }

  const abortPresentations = new Map<number, AbortPresentation>();
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType === turnHandoffEntryType) {
      const handoff = Schema.decodeUnknownOption(turnHandoffEntrySchema)(entry.data);
      if (Option.isSome(handoff))
        abortPresentations.set(handoff.value.timestamp, { kind: "handoff" });
    } else if (entry.customType === turnStopEntryType) {
      const stopped = Schema.decodeUnknownOption(turnStopEntrySchema)(entry.data);
      if (Option.isSome(stopped))
        abortPresentations.set(stopped.value.timestamp, {
          kind: "stopped",
          stop: stopped.value.stop,
        });
    }
  }

  const intermediateRetryErrors = new Set<string>();
  let nextContextRole: string | undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.stopReason === "error" &&
      nextContextRole === "assistant"
    )
      intermediateRetryErrors.add(entry.id);
    if (entry.type === "message") nextContextRole = entry.message.role;
    else if (entry.type === "custom_message") nextContextRole = "custom";
  }

  // A worker's final result completes its start card; otherwise it stands alone.
  const projectSubagentCompletion = (entryId: string, details: unknown) => {
    const completion = Schema.decodeUnknownOption(
      Schema.Struct({ handleId: Schema.String.check(Schema.isUUID()) }),
    )(details);
    const start = Option.isSome(completion)
      ? projected.findLast(
          (part): part is Extract<UiPart, { kind: "tool" }> =>
            part.kind === "tool" &&
            part.command === "subagents.start" &&
            (part.input.includes(completion.value.handleId) ||
              part.output?.includes(completion.value.handleId) === true),
        )
      : undefined;
    if (start) {
      const index = projected.indexOf(start);
      projected[index] = { ...start, output: formatUnknown(details) };
    } else
      append({
        id: `entry-${entryId}-subagent-completion`,
        kind: "tool",
        name: "cake",
        command: "subagents.completion",
        input: "",
        output: formatUnknown(details),
        state: "success",
      });
  };

  const projectSystem = createSystemContextProjector();
  const internalInputs = internalInputOrigins(entries);
  const inheritedIds = inheritedContextEntryIds(branchEntries);
  const inherited = entries.filter((entry) => inheritedIds.has(entry.id));
  if (inherited.length)
    append({
      id: `entry-${inherited[0]!.id}-inherited-context`,
      kind: "context",
      title: "Inherited context",
      text: inherited
        .map((entry) =>
          entry.type === "message"
            ? "content" in entry.message
              ? textFromContent(entry.message.content)
              : formatUnknown(entry.message)
            : entry.type === "custom_message"
              ? textFromContent(entry.content)
              : "",
        )
        .join("\n\n"),
    });
  for (const entry of entries) {
    if (inheritedIds.has(entry.id)) continue;
    if (entry.type === "message") {
      const internal = internalInputs.get(entry.id);
      if (internal?._tag === "WorkboardDelivery") {
        append(internalInputPart(internal, `entry-${entry.id}-context`));
        continue;
      }
      if (internal?._tag === "SubagentCompletion" && entry.message.role === "user") {
        projectSubagentCompletion(entry.id, internal.details);
        append(
          subagentCompletionPart(
            `entry-${entry.id}-custom`,
            textFromContent(entry.message.content),
          ),
        );
        continue;
      }
      if (intermediateRetryErrors.has(entry.id)) continue;
      if (entry.message.role === "system") {
        const parts = projectSystem(
          entry.message,
          `entry-${entry.id}`,
          textFromContent(entry.message.content),
        );
        if (!systemCheckpoints.has(entry.id)) for (const part of parts) append(part);
        continue;
      }
      for (const part of partsFromMessage(
        entry.message,
        `entry-${entry.id}`,
        false,
        entry.id,
        userMessagePresentations.get(entry.id) === "markdown",
        undefined,
        abortPresentations.get(entry.message.timestamp),
        internal,
      ))
        append(part);
      continue;
    }
    if (entry.type === "branch_summary") {
      append({
        id: `entry-${entry.id}-context`,
        kind: "context",
        title: "Branch summary",
        text: entry.summary,
      });
      continue;
    }
    if (entry.type === "compaction") {
      append({
        id: `entry-${entry.id}-compaction`,
        kind: "compaction",
        summary: entry.summary,
        tokensBefore: entry.tokensBefore,
        firstKeptEntryId: entry.firstKeptEntryId,
      });
      continue;
    }
    if (entry.type === "custom_message") {
      if (entry.customType === subagentCompletionType)
        projectSubagentCompletion(entry.id, entry.details);
      for (const part of partsFromMessage({ ...entry, role: "custom" }, `entry-${entry.id}`))
        append(part);
      continue;
    }
    if (entry.type !== "custom") continue;
    if (entry.customType === "cake.artifact/v1") {
      const pointer = decodeArtifactPointer(entry.data);
      if (pointer?.origin)
        artifactOrigins.set(pointer.origin.toolCallId, {
          lineageId: pointer.lineageId,
          revision: pointer.revision,
          originEntryId: pointer.origin.assistantEntryId,
          ...(pointer.presentation === "selected-revision"
            ? { reference: pointer.exactRef }
            : null),
        });
      continue;
    }
    if (entry.customType === "cake.interview/v1") {
      const parsed = Schema.decodeUnknownOption(InterviewEntry)(entry.data);
      if (Option.isSome(parsed)) {
        const value = parsed.value;
        const assistant = entries.find(
          (candidate) =>
            candidate.id === value.origin.assistantEntryId &&
            candidate.type === "message" &&
            candidate.message.role === "assistant" &&
            candidate.message.content.some(
              (content) => content.type === "toolCall" && content.id === value.origin.toolCallId,
            ),
        );
        if (assistant && value.id === value.origin.toolCallId)
          interviews.set(value.id, {
            id: value.id,
            sessionId: value.sessionId,
            request: value.request,
          });
      }
      continue;
    }
    if (entry.customType === reviewRunEntryType) {
      const run = Schema.decodeUnknownOption(reviewRunEntrySchema)(entry.data);
      if (Option.isSome(run)) append(reviewRunPart(run.value));
    }
  }
  const nestedPublications = new Map<string, UiPart[]>();
  for (const [toolCallId, artifact] of artifactOrigins) {
    // Publication records the calling Pi leaf. Earlier operations in the same
    // batch may already have appended metadata after the assistant message.
    const originIndex = entries.findIndex((entry) => entry.id === artifact.originEntryId);
    const assistant = entries
      .slice(0, originIndex + 1)
      .findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
    if (assistant?.type !== "message" || assistant.message.role !== "assistant") continue;
    const calls = new Set(
      assistant.message.content.flatMap((block) =>
        block.type === "toolCall" ? [boundedProjectionKey(`tool-${block.id}`)] : [],
      ),
    );
    const id = boundedProjectionKey(`tool-${toolCallId}`);
    const metadata = {
      artifactId: artifact.lineageId,
      artifactRevision: artifact.revision,
      ...(artifact.reference === undefined ? null : { artifactReference: artifact.reference }),
    };
    const index = indexes.get(id);
    const part = index === undefined ? undefined : projected[index];
    if (index !== undefined && part?.kind === "tool" && calls.has(id))
      projected[index] = { ...part, ...metadata };
    else {
      // Pi persists nested calls beneath their model-issued result, not as
      // messages. Join the authoritative pointer to that explicit record; do
      // not parse codemode output or infer ancestry from tool-call ID strings.
      const parent = projected.find(
        (candidate) =>
          candidate.kind === "tool" &&
          calls.has(candidate.id) &&
          candidate.nestedCalls?.calls.some((call) => call.id === id),
      );
      const call =
        parent?.kind === "tool" && parent.nestedCalls?.calls.find((call) => call.id === id);
      if (!parent || !call) continue;
      const publications = nestedPublications.get(parent.id) ?? [];
      publications.push({
        id,
        kind: "tool",
        name: call.name,
        command: call.command,
        input: call.input,
        state: call.state,
        ...metadata,
      });
      nestedPublications.set(parent.id, publications);
    }
  }
  for (const [toolCallId, interview] of interviews) {
    const index = indexes.get(boundedProjectionKey(`tool-${toolCallId}`));
    const part = index === undefined ? undefined : projected[index];
    if (index === undefined || part?.kind !== "tool") continue;
    let result: InterviewResult | undefined;
    if (part.output) {
      try {
        const parsed = Schema.decodeUnknownOption(InterviewResult)(JSON.parse(part.output));
        if (Option.isSome(parsed) && parsed.value.interviewId === interview.id)
          result = parsed.value;
      } catch {
        /* Non-result tool errors remain visible through the tool state. */
      }
    }
    projected[index] = { ...part, interview, interviewResult: result };
  }
  // Durable entries are settled history. A tool call still marked "running"
  // after the full walk has no recorded result, which means the run was
  // interrupted before the tool settled. Only a live runtime may claim
  // "running"; restored or idle sessions must present a terminal state.
  if (!options.live)
    for (const [index, part] of projected.entries())
      if (part.kind === "tool" && part.state === "running")
        projected[index] = { ...part, state: "interrupted" };
  return projected.flatMap((part) => [part, ...(nestedPublications.get(part.id) ?? [])]);
}

function entryPreview(entry: SessionEntry) {
  if (entry.type === "message") {
    const message = entry.message;
    const role = message.role;
    const rawText = splitContextReminders(
      "content" in message ? textFromContent(message.content) : "",
    ).text;
    const displayText = role === "user" ? visibleUserMessageText(rawText) : rawText;
    const text = displayText.replace(/[\n\t]+/g, " ").trim();
    if (role === "user") return text.slice(0, 2_048);
    if (message.role === "assistant") {
      if (text) return text.slice(0, 2_048);
      if (message.stopReason === "aborted") return "(aborted)";
      if (message.errorMessage)
        return message.errorMessage
          .replace(/[\n\t]+/g, " ")
          .trim()
          .slice(0, 2_048);
      return "";
    }
    if (message.role === "toolResult") return `[${message.toolName}]`;
    if (message.role === "bashExecution") return `[bash]: ${message.command}`.slice(0, 2_048);
    return `[${role}]`;
  }
  if (entry.type === "compaction" || entry.type === "branch_summary")
    return entry.summary.slice(0, 2_048);
  if (entry.type === "custom_message")
    return textFromContent(entry.content)
      .replace(/[\n\t]+/g, " ")
      .trim()
      .slice(0, 2_048);
  if (entry.type === "session_info") return (entry.name ?? "Session renamed").slice(0, 2_048);
  if (entry.type === "model_change") return `${entry.provider}/${entry.modelId}`;
  return entry.type.replaceAll("_", " ");
}

export function projectTree(sessionManager: SessionManager): SessionTreeEntry[] {
  const activeIds = new Set(sessionManager.getBranch().map((entry) => entry.id));
  const entries: SessionTreeEntry[] = [];
  const stack = [...sessionManager.getTree()].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    entries.push({
      id: node.entry.id,
      parentId: node.entry.parentId ?? undefined,
      type: node.entry.type,
      messageRole: node.entry.type === "message" ? node.entry.message.role : undefined,
      editorText:
        node.entry.type === "message" && node.entry.message.role === "user"
          ? visibleUserMessageText(textFromContent(node.entry.message.content))
          : undefined,
      label: node.label,
      preview: entryPreview(node.entry),
      active: activeIds.has(node.entry.id),
    });
    for (let index = node.children.length - 1; index >= 0; index -= 1)
      stack.push(node.children[index]!);
  }
  return entries;
}

export function projectDurableArtifactLineageIds(sessionManager: SessionManager): string[] {
  const lineageIds = new Set<string>();
  for (const entry of sessionManager.getEntries()) {
    if (entry.type !== "custom" || Reflect.get(entry, "customType") !== "cake.artifact/v1")
      continue;
    const pointer = decodeArtifactPointer(Reflect.get(entry, "data"));
    if (!pointer) throw new Error("Malformed durable cake.artifact/v1 Pi entry");
    lineageIds.add(pointer.lineageId);
  }
  return [...lineageIds];
}

export function projectArtifactPointers(sessionManager: SessionManager): ArtifactPointer[] {
  const pointers = new Map<string, ArtifactPointer>();
  for (const entry of sessionManager.getBranch()) {
    if (entry.type !== "custom" || Reflect.get(entry, "customType") !== "cake.artifact/v1")
      continue;
    const parsed = decodeArtifactPointer(Reflect.get(entry, "data"));
    if (!parsed) continue;
    const current = pointers.get(parsed.lineageId);
    if (!current || parsed.revision > current.revision) pointers.set(parsed.lineageId, parsed);
  }
  return [...pointers.values()];
}

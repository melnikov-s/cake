import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Option, Schema } from "effect";
import type { UiPart } from "../../../contracts/conversations/session-contract";
import {
  runAcpTurn,
  type AcpTurn,
  type AcpPermission,
  type AcpStatus,
  type AcpTool,
} from "../../antigravity/acp";
import { cakePortableInstructions } from "./cake-instructions";
import { TurnCanceledError } from "./RuntimeTurnCompletion";

const startedType = "cake.antigravity.start/v1";
export const antigravityResponseType = "cake.antigravity.reply/v1";
const responseType = antigravityResponseType;
export const antigravityReplyLabel =
  "[External assistant context: the following text was produced by Google Antigravity, not by Pi and not by the user.]";
const textLimit = 131_072;
const antigravityPromptLimit = 32_768;
const toolSegment = Schema.Struct({
  type: Schema.Literal("tool"),
  title: Schema.String.check(Schema.isMaxLength(256)),
  status: Schema.Literals(["running", "success", "error", "interrupted"]),
  locations: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
});
const segment = Schema.Union([Schema.Literal("text"), toolSegment]);
const detailsSchema = Schema.Struct({
  id: Schema.String.check(Schema.isUUID(4)),
  sessionId: Schema.NonEmptyString,
  cwd: Schema.String,
  scope: Schema.optionalKey(Schema.Literal("project-chat")),
  resumeId: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(1024))),
  status: Schema.Literals(["connecting", "new", "resumed", "no-resume", "resume-unavailable"]),
  ending: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
  segments: Schema.Array(segment).check(Schema.isMaxLength(300)),
});
type Segment = typeof segment.Type;
export type AntigravityTurnDetails = typeof detailsSchema.Type;
type Details = AntigravityTurnDetails;
const acceptedSchema = Schema.Struct({ id: detailsSchema.fields.id });
const statusText = {
  connecting: "Connecting to the Antigravity CLI…",
  new: "New Antigravity session. Cake sent its instructions and this message, not Pi history.",
  resumed:
    "Resumed Antigravity’s own context. Cake sent its instructions and this message, not Pi history.",
  "no-resume":
    "This CLI does not advertise resume. Cake sent its instructions and this message, not Pi history.",
  "resume-unavailable":
    "Could not resume Antigravity’s context. Cake started fresh with its instructions and this message.",
} satisfies Record<AcpStatus, string>;

const readDetails = (details: unknown) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(detailsSchema)(details));
function readAccepted(entry: Extract<SessionEntry, { type: "custom" }>) {
  return Option.getOrUndefined(Schema.decodeUnknownOption(acceptedSchema)(entry.data));
}

function project(details: Details, texts: readonly string[], live: boolean): UiPart[] {
  let textIndex = 0;
  return [
    {
      id: `agy-${details.id}-source`,
      kind: "notice",
      tone: "info",
      title: "Antigravity",
      detail:
        details.status === "connecting" && !live
          ? "This Antigravity turn did not start."
          : details.scope === "project-chat" && details.status !== "connecting"
            ? "Fresh Antigravity session using Cake’s instructions, this message and any eligible Project Chat memory."
            : statusText[details.status],
    },
    ...details.segments.flatMap((part, index): UiPart[] => {
      const id = `agy-${details.id}-${index}`;
      if (part === "text") {
        const text = texts[textIndex++];
        return text
          ? [{ id, kind: "text", role: "assistant", status: live ? "streaming" : "complete", text }]
          : [];
      }
      return [
        {
          id,
          kind: "tool",
          name: `Antigravity · ${part.title}`,
          state: !live && part.status === "running" ? "interrupted" : part.status,
          input: part.locations ?? "",
        },
      ];
    }),
    ...(details.ending
      ? [
          {
            id: `agy-${details.id}-ending`,
            kind: "notice" as const,
            tone: "warning" as const,
            title: "Antigravity turn ended",
            detail: details.ending,
          },
        ]
      : []),
  ];
}

/** ACP reply is a supported Pi CustomMessage, not an AssistantMessage with
 * fabricated API, usage or signed blocks. The text section is tagged for the
 * next Pi provider; only Cake projects it as externally authored assistant UI.
 */
export function antigravityParts(entry: SessionEntry) {
  if (entry.type !== "custom_message" || entry.customType !== responseType) return undefined;
  const details = readDetails(entry.details);
  if (!details || typeof entry.content === "string") return [];
  const texts = entry.content
    .slice(1)
    .flatMap((block) => (block.type === "text" ? [block.text] : []));
  return project(details, texts, false).map((part) =>
    part.kind === "text" && details.scope === "project-chat"
      ? { ...part, entryId: entry.id }
      : part,
  );
}

export function interruptedAntigravityParts(entries: readonly SessionEntry[]): UiPart[] {
  const ended = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "custom_message" || entry.customType !== responseType) continue;
    const id = readDetails(entry.details)?.id;
    if (id) ended.add(id);
  }
  return entries.flatMap((entry) => {
    if (entry.type !== "custom" || entry.customType !== startedType) return [];
    const id = readAccepted(entry)?.id;
    return id && !ended.has(id)
      ? [
          {
            id: `agy-${id}-ending`,
            kind: "notice",
            tone: "warning",
            title: "Antigravity turn interrupted",
            detail: "No final reply was recorded. Cake did not restart the turn.",
          },
        ]
      : [];
  });
}

function resumeFrom(session: AgentSession, cwd: string) {
  // A newer start without a response fences crash, cancellation and uncertain
  // side effects. Branching away from the checkpoint also forgets Google state.
  const latest = session.sessionManager
    .getEntries()
    .findLast(
      (entry) =>
        (entry.type === "custom" && entry.customType === startedType) ||
        (entry.type === "custom_message" && entry.customType === responseType),
    );
  for (const entry of session.sessionManager.getBranch().reverse()) {
    if (entry.type === "custom" && entry.customType === startedType) return undefined;
    if (entry.type !== "custom_message" || entry.customType !== responseType) continue;
    const details = readDetails(entry.details);
    return entry.id === latest?.id &&
      details?.sessionId === session.sessionManager.getSessionId() &&
      details.cwd === cwd
      ? details.resumeId
      : undefined;
  }
}

export interface CakeAntigravityInput {
  id: string;
  text: string;
  markdown: boolean;
  /** Granted only for Project Chat turns admitted by native renderer IPC. */
  cakeBridgeOwnerSignal?: AbortSignal;
  permission(request: AcpPermission, signal: AbortSignal): Promise<"allow" | "deny" | undefined>;
}

export function createAntigravityTranscript(input: {
  session: AgentSession;
  cwd: string;
  onStarted(): void;
  onChanged(): void;
}) {
  const { session, cwd } = input;
  const manager = session.sessionManager;
  return createAntigravityTurnController({
    ...input,
    sessionId: () => manager.getSessionId(),
    scope: "project-session",
    resume: () => resumeFrom(session, cwd),
    admit(request) {
      const entryId = manager.appendMessage({
        role: "user",
        content: request.text,
        timestamp: Date.now(),
      });
      manager.appendCustomEntry(startedType, { id: request.id });
      if (request.markdown)
        manager.appendCustomEntry("cake.user-message-presentation/v1", {
          targetId: entryId,
          renderAs: "markdown",
        });
    },
    persist: async (details, content) => {
      await session.sendCustomMessage(
        { customType: responseType, content, display: true, details },
        { triggerTurn: false },
      );
    },
  });
}

export function createAntigravityTurnController(input: {
  sessionId(): string;
  cwd: string;
  scope: "project-session" | "project-chat";
  resume?(): string | undefined;
  admit(request: CakeAntigravityInput): void | Promise<void>;
  prepare?(
    request: CakeAntigravityInput,
    signal: AbortSignal,
  ): Promise<Pick<AcpTurn, "history" | "maxPromptBytes" | "instructions" | "cakeCall">>;
  persist(details: Details, content: { type: "text"; text: string }[]): Promise<void>;
  onStarted?(): void;
  onChanged(): void;
}) {
  const { cwd, onStarted, onChanged, scope } = input;
  let active: { id: string; controller: AbortController; done: Promise<void> } | undefined;
  let liveParts: UiPart[] = [];
  let persistenceFailed = false;
  function start(request: CakeAntigravityInput) {
    if (active || persistenceFailed)
      throw new Error("Wait for Antigravity cleanup before sending another turn");
    if (
      !request.text.trim() ||
      request.text.length > antigravityPromptLimit ||
      /^[!/]/.test(request.text.trimStart())
    )
      throw new Error(
        "Antigravity accepts plain messages of up to 32,768 characters, not Cake commands",
      );
    const resumeId = input.resume?.();
    const controller = new AbortController();
    const signal = request.cakeBridgeOwnerSignal
      ? AbortSignal.any([request.cakeBridgeOwnerSignal, controller.signal])
      : controller.signal;
    signal.throwIfAborted();
    const details: Details = {
      id: request.id,
      sessionId: input.sessionId(),
      cwd,
      ...(scope === "project-chat" ? { scope } : null),
      status: "connecting",
      segments: [],
    };
    const segments: Segment[] = [];
    const texts: string[] = [];
    const tools = new Map<string, number>();
    let size = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function publish() {
      liveParts = project({ ...details, segments }, texts, true);
      onChanged();
    }
    function update() {
      timer ??= setTimeout(() => {
        timer = undefined;
        publish();
      }, 35);
    }
    function tool(event: AcpTool) {
      const index = tools.get(event.toolCallId) ?? segments.length;
      tools.set(event.toolCallId, index);
      const controlFree = event.title?.replace(/[\r\n\t\u202a-\u202e\u2066-\u2069]/g, " ").trim();
      const locations = event.locations
        ?.slice(0, 8)
        .map(({ path, line }) => (line ? `${path}:${line}` : path))
        .join("\n")
        .slice(0, 1024);
      segments[index] = {
        type: "tool",
        title: controlFree?.slice(0, 180) || event.kind?.slice(0, 80) || "Tool call",
        status:
          event.status === "completed"
            ? "success"
            : event.status === "failed"
              ? "error"
              : "running",
        ...(locations ? { locations } : null),
      };
      update();
    }
    // Save the original before the transport starts. No recovery path runs it.
    let admitted: void | Promise<void>;
    try {
      admitted = input.admit(request);
    } catch {
      persistenceFailed = true;
      throw new Error("Cake could not save the message. Nothing was sent to Antigravity.");
    }
    const run = async () => {
      try {
        await admitted;
      } catch (error) {
        liveParts = [];
        active = undefined;
        onChanged();
        throw error;
      }
      let failure: Error | undefined;
      let truncated = false;
      let nextResume: string | undefined;
      try {
        signal.throwIfAborted();
        const prepared = await input.prepare?.(request, signal);
        signal.throwIfAborted();
        const result = await runAcpTurn({
          ...prepared,
          cwd,
          text: request.text,
          instructions: prepared?.instructions ?? cakePortableInstructions(scope),
          resumeId,
          signal,
          permission: request.permission,
          status(status) {
            Object.assign(details, { status });
            update();
          },
          tool,
          chunk(text) {
            if (!text) return;
            if (size + text.length > textLimit || segments.length > 290) {
              truncated = true;
              controller.abort();
              return;
            }
            size += text.length;
            if (segments.at(-1) !== "text") {
              segments.push("text");
              texts.push(text);
            } else texts[texts.length - 1] += text;
            update();
          },
        });
        if (truncated)
          failure = new Error(
            "Antigravity output exceeded Cake’s turn limit; the visible partial reply was saved.",
          );
        else if (result.stop === "cancelled")
          failure = new TurnCanceledError("Antigravity turn canceled; the next turn starts fresh.");
        else if (result.stop !== "end_turn")
          failure = new Error(
            result.stop === "refusal"
              ? "Antigravity refused this request."
              : "Antigravity reached a turn limit.",
          );
        else if (scope === "project-session") nextResume = result.resumeId;
      } catch (error) {
        failure = signal.aborted
          ? new TurnCanceledError("Antigravity turn canceled; the next turn starts fresh.")
          : error instanceof Error
            ? error
            : new Error("Antigravity could not complete the turn.");
      }
      clearTimeout(timer);
      liveParts = [];
      try {
        await input.persist(
          {
            ...details,
            segments,
            ...(failure ? { ending: failure.message } : null),
            ...(nextResume ? { resumeId: nextResume } : null),
          },
          [
            { type: "text", text: antigravityReplyLabel },
            ...texts.map((text) => ({ type: "text" as const, text })),
          ],
        );
      } catch {
        // Do not run Pi with a stale in-memory view after a failed append.
        persistenceFailed = true;
        throw new Error(
          "Cake could not save Antigravity’s reply. Reopen the conversation before continuing.",
        );
      } finally {
        active = undefined;
        onChanged();
      }
      if (failure) throw failure;
    };
    const done = Promise.resolve().then(run);
    active = { id: request.id, controller, done };
    onStarted?.();
    publish();
    return done;
  }
  return {
    start,
    parts: () => liveParts,
    activeId: () => active?.id,
    requireIdle() {
      if (active) throw new Error("Wait for the Antigravity turn to finish or stop it first");
      if (persistenceFailed)
        throw new Error("Reopen the session after the transcript write failure");
    },
    wait: async () => {
      await active?.done.catch(() => undefined);
    },
    abort: async () => {
      const turn = active;
      turn?.controller.abort();
      await turn?.done.catch(() => undefined);
    },
  };
}

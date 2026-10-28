import { Model, computed, id } from "r-state-tree";
import {
  type Annotation,
  type NestedToolCalls,
  type ToolOutputContent,
  type UiPart,
} from "../../contracts/conversations/session-contract";
import type { SourceLocation } from "../../contracts/editor/source-location";

type TextRole = Extract<UiPart, { kind: "text" }>["role"];
type TextStatus = Extract<UiPart, { kind: "text" }>["status"];
type PartStatus = Extract<UiPart, { kind: "text" | "reasoning" | "review-run" }>["status"];
type PartState = Extract<UiPart, { kind: "tool" | "command" }>["state"];
type WorkLogOrigin = Extract<UiPart, { kind: "tool" }>["origin"];
type AttachmentKind = Extract<UiPart, { kind: "attachment" }>["attachmentKind"];
type NoticeTone = Extract<UiPart, { kind: "notice" }>["tone"];
type DeliveryState = Extract<UiPart, { kind: "text" }>["deliveryState"];
type TextRenderAs = Extract<UiPart, { kind: "text" }>["renderAs"];
type CrossSessionMetadata = Extract<UiPart, { kind: "text" }>["crossSession"];
type ScheduledOrigin = Extract<UiPart, { kind: "text" }>["scheduled"];
type PromptCacheResponse = Extract<UiPart, { kind: "text" }>["response"];

export class Message extends Model {
  @id id = "";
  /** Cake-generated key for a display part within its conversation. */
  partKey = "";
  kind: UiPart["kind"] = "notice";
  role: TextRole | undefined;
  /** Pi entry identity, when the display part carries one. */
  piId: string | undefined;
  renderKey: string | undefined;
  requestedAt: number | undefined;
  text: string | undefined;
  content: string | undefined;
  status: PartStatus | undefined;
  deliveryState: DeliveryState | undefined;
  renderAs: TextRenderAs | undefined;
  crossSession: CrossSessionMetadata | undefined;
  subagentReport: Extract<UiPart, { kind: "text" }>["subagentReport"];
  agentSource: Extract<UiPart, { kind: "text" }>["agentSource"];
  scheduled: ScheduledOrigin | undefined;
  queuedInput: Extract<UiPart, { kind: "text" }>["queuedInput"];
  response: PromptCacheResponse | undefined;
  taskTodoId: string | null | undefined;
  name: string | undefined;
  command: string | undefined;
  excludeFromContext: boolean | undefined;
  input: string | undefined;
  output: string | undefined;
  outputContent: readonly ToolOutputContent[] | undefined;
  nestedCalls: NestedToolCalls | undefined;
  startedAt: number | null | undefined;
  durationMs: number | undefined;
  interview: Extract<UiPart, { kind: "tool" }>["interview"];
  interviewResult: Extract<UiPart, { kind: "tool" }>["interviewResult"];
  artifactId: string | undefined;
  artifactRevision: number | undefined;
  artifactReference: string | undefined;
  messageReference: string | undefined;
  filePath: string | undefined;
  diff: string | undefined;
  inputStreaming: boolean | undefined;
  state: PartState | undefined;
  origin: WorkLogOrigin | undefined;
  title: string | undefined;
  url: string | undefined;
  mediaType: string | undefined;
  attachmentKind: AttachmentKind | undefined;
  inputReference: Extract<UiPart, { kind: "attachment" }>["inputReference"];
  data: string | undefined;
  location: SourceLocation | undefined;
  selectedText: string | undefined;
  comment: string | undefined;
  tagName: string | undefined;
  selector: string | undefined;
  outerHTML: string | undefined;
  browserText: string | undefined;
  annotations: Annotation[] | undefined;
  tone: NoticeTone | undefined;
  detail: string | undefined;
  retryAt: number | undefined;
  operationId: string | undefined;
  threadIds: string[] | undefined;
  commentCount: number | undefined;
  summary: string | undefined;
  tokensBefore: number | undefined;
  firstKeptPiId: string | undefined;

  /** Updates live transcript fields without reapplying every optional snapshot field per token. */
  update(part: UiPart) {
    if (part.id !== this.partKey || part.kind !== this.kind) return false;
    switch (part.kind) {
      case "context":
        this.title = part.title;
        this.text = part.text;
        return true;
      case "text":
        this.role = part.role;
        this.piId = part.entryId;
        this.renderKey = part.renderKey;
        this.requestedAt = part.requestedAt;
        this.text = part.text;
        this.status = part.status;
        this.deliveryState = part.deliveryState;
        this.renderAs = part.renderAs;
        this.crossSession = part.crossSession;
        this.subagentReport = part.subagentReport;
        this.agentSource = part.agentSource;
        this.scheduled = part.scheduled;
        this.queuedInput = part.queuedInput;
        this.response = part.response;
        this.taskTodoId = part.taskTodoId;
        return true;
      case "skill":
        this.piId = part.entryId;
        this.renderKey = part.renderKey;
        this.name = part.name;
        this.content = part.content;
        return true;
      case "reasoning":
        this.text = part.text;
        this.status = part.status;
        this.response = part.response;
        this.origin = part.origin;
        return true;
      case "command":
        this.command = part.command;
        this.output = part.output;
        this.excludeFromContext = part.excludeFromContext;
        this.state = part.state;
        this.origin = part.origin;
        return true;
      case "tool":
        this.name = part.name;
        this.command = part.command;
        this.input = part.input;
        this.output = part.output;
        this.outputContent = part.outputContent ? [...part.outputContent] : undefined;
        this.nestedCalls = part.nestedCalls;
        this.startedAt = part.startedAt;
        this.durationMs = part.durationMs;
        // Live tool deltas do not repeat immutable interview metadata. Full
        // authoritative snapshots replace it when the transcript branch changes.
        if (part.interview) this.interview = part.interview;
        if (part.interviewResult) this.interviewResult = part.interviewResult;
        this.artifactId = part.artifactId;
        this.artifactRevision = part.artifactRevision;
        this.artifactReference = part.artifactReference;
        this.messageReference = part.messageReference;
        this.filePath = part.filePath;
        this.diff = part.diff;
        this.inputStreaming = part.inputStreaming;
        this.state = part.state;
        this.response = part.response;
        this.origin = part.origin;
        return true;
      case "source":
        this.title = part.title;
        this.url = part.url;
        return true;
      case "attachment":
        this.inputReference = part.inputReference;
        this.name = part.name;
        this.mediaType = part.mediaType;
        this.attachmentKind = part.attachmentKind;
        this.data = part.data;
        this.location = part.location;
        this.selectedText = part.selectedText;
        this.comment = part.comment;
        this.url = part.url;
        this.tagName = part.tagName;
        this.selector = part.selector;
        this.outerHTML = part.outerHTML;
        this.browserText = part.browserText;
        return true;
      case "annotation":
        this.annotations = [...part.annotations];
        return true;
      case "notice":
        this.tone = part.tone;
        this.title = part.title;
        this.detail = part.detail;
        this.retryAt = part.retryAt;
        return true;
      case "review-run":
        this.operationId = part.operationId;
        this.threadIds = [...part.threadIds];
        this.commentCount = part.commentCount;
        this.status = part.status;
        return true;
      case "compaction":
        this.summary = part.summary;
        this.tokensBefore = part.tokensBefore;
        this.firstKeptPiId = part.firstKeptEntryId;
        return true;
    }
  }

  @computed
  get value(): UiPart {
    switch (this.kind) {
      case "context":
        return {
          id: this.partKey,
          kind: this.kind,
          title: this.title!,
          text: this.text!,
        };
      case "text":
        // SAFETY: snapshots and update() keep status aligned with the part discriminant.
        return {
          id: this.partKey,
          kind: this.kind,
          role: this.role!,
          entryId: this.piId,
          renderKey: this.renderKey,
          requestedAt: this.requestedAt,
          text: this.text!,
          status: this.status as TextStatus,
          deliveryState: this.deliveryState,
          renderAs: this.renderAs,
          crossSession: this.crossSession,
          subagentReport: this.subagentReport,
          agentSource: this.agentSource,
          scheduled: this.scheduled,
          queuedInput: this.queuedInput,
          response: this.response,
          ...(this.taskTodoId === undefined ? null : { taskTodoId: this.taskTodoId }),
        };
      case "skill":
        return {
          id: this.partKey,
          kind: this.kind,
          entryId: this.piId,
          renderKey: this.renderKey,
          name: this.name!,
          content: this.content!,
        };
      case "reasoning":
        // SAFETY: snapshots and update() keep reasoning status aligned with the part discriminant.
        return {
          id: this.partKey,
          kind: this.kind,
          text: this.text!,
          status: this.status as Extract<UiPart, { kind: "reasoning" }>["status"],
          response: this.response,
          origin: this.origin,
        };
      case "command":
        return {
          id: this.partKey,
          kind: this.kind,
          command: this.command!,
          output: this.output!,
          excludeFromContext: this.excludeFromContext!,
          // SAFETY: snapshots and update() keep command state aligned with the part discriminant.
          state: this.state as Extract<UiPart, { kind: "command" }>["state"],
          origin: this.origin,
        };
      case "tool":
        return {
          id: this.partKey,
          kind: this.kind,
          name: this.name!,
          command: this.command,
          input: this.input!,
          output: this.output,
          outputContent: this.outputContent,
          nestedCalls: this.nestedCalls,
          startedAt: this.startedAt,
          durationMs: this.durationMs,
          interview: this.interview,
          interviewResult: this.interviewResult,
          artifactId: this.artifactId,
          artifactRevision: this.artifactRevision,
          artifactReference: this.artifactReference,
          messageReference: this.messageReference,
          filePath: this.filePath,
          diff: this.diff,
          inputStreaming: this.inputStreaming,
          state: this.state!,
          response: this.response,
          origin: this.origin,
        };
      case "source":
        return { id: this.partKey, kind: this.kind, title: this.title!, url: this.url! };
      case "attachment":
        return {
          id: this.partKey,
          kind: this.kind,
          name: this.name!,
          mediaType: this.mediaType!,
          attachmentKind: this.attachmentKind!,
          inputReference: this.inputReference,
          data: this.data,
          location: this.location,
          selectedText: this.selectedText,
          comment: this.comment,
          url: this.url,
          tagName: this.tagName,
          selector: this.selector,
          outerHTML: this.outerHTML,
          browserText: this.browserText,
        };
      case "annotation":
        return { id: this.partKey, kind: this.kind, annotations: this.annotations! };
      case "notice":
        return {
          id: this.partKey,
          kind: this.kind,
          tone: this.tone!,
          title: this.title!,
          detail: this.detail,
          retryAt: this.retryAt,
        };
      case "review-run":
        // SAFETY: snapshots and update() keep review status aligned with the part discriminant.
        return {
          id: this.partKey,
          kind: this.kind,
          operationId: this.operationId!,
          threadIds: this.threadIds!,
          commentCount: this.commentCount!,
          status: this.status as Extract<UiPart, { kind: "review-run" }>["status"],
        };
      case "compaction":
        return {
          id: this.partKey,
          kind: this.kind,
          summary: this.summary!,
          tokensBefore: this.tokensBefore!,
          firstKeptEntryId: this.firstKeptPiId,
        };
    }
  }
}

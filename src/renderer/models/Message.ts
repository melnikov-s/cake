import { Model, computed, id } from "r-state-tree";
import { type Annotation, type ToolOutputContent, type UiPart } from "../../ipc/session-contract";

type TextRole = Extract<UiPart, { kind: "text" }>["role"];
type TextStatus = Extract<UiPart, { kind: "text" }>["status"];
type PartStatus = Extract<UiPart, { kind: "text" | "reasoning" | "review-run" }>["status"];
type PartState = Extract<UiPart, { kind: "tool" | "command" }>["state"];
type AttachmentKind = Extract<UiPart, { kind: "attachment" }>["attachmentKind"];
type NoticeTone = Extract<UiPart, { kind: "notice" }>["tone"];
type DeliveryState = Extract<UiPart, { kind: "text" }>["deliveryState"];
type TextRenderAs = Extract<UiPart, { kind: "text" }>["renderAs"];
type CrossSessionMetadata = Extract<UiPart, { kind: "text" }>["crossSession"];

export class Message extends Model {
  @id id = "";
  /** Cake-generated key for a display part within its conversation. */
  partKey = "";
  kind: UiPart["kind"] = "notice";
  role: TextRole | undefined;
  /** Pi entry identity, when the display part carries one. */
  piId: string | undefined;
  text: string | undefined;
  content: string | undefined;
  status: PartStatus | undefined;
  deliveryState: DeliveryState | undefined;
  renderAs: TextRenderAs | undefined;
  crossSession: CrossSessionMetadata | undefined;
  name: string | undefined;
  command: string | undefined;
  excludeFromContext: boolean | undefined;
  input: string | undefined;
  output: string | undefined;
  outputContent: readonly ToolOutputContent[] | undefined;
  artifactId: string | undefined;
  filePath: string | undefined;
  diff: string | undefined;
  inputStreaming: boolean | undefined;
  state: PartState | undefined;
  title: string | undefined;
  url: string | undefined;
  mediaType: string | undefined;
  attachmentKind: AttachmentKind | undefined;
  data: string | undefined;
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
      case "text":
        this.role = part.role;
        this.piId = part.entryId;
        this.text = part.text;
        this.status = part.status;
        this.deliveryState = part.deliveryState;
        this.renderAs = part.renderAs;
        this.crossSession = part.crossSession;
        return true;
      case "skill":
        this.name = part.name;
        this.content = part.content;
        return true;
      case "reasoning":
        this.text = part.text;
        this.status = part.status;
        return true;
      case "command":
        this.command = part.command;
        this.output = part.output;
        this.excludeFromContext = part.excludeFromContext;
        this.state = part.state;
        return true;
      case "tool":
        this.name = part.name;
        this.command = part.command;
        this.input = part.input;
        this.output = part.output;
        this.outputContent = part.outputContent ? [...part.outputContent] : undefined;
        this.artifactId = part.artifactId;
        this.filePath = part.filePath;
        this.diff = part.diff;
        this.inputStreaming = part.inputStreaming;
        this.state = part.state;
        return true;
      case "source":
        this.title = part.title;
        this.url = part.url;
        return true;
      case "attachment":
        this.name = part.name;
        this.mediaType = part.mediaType;
        this.attachmentKind = part.attachmentKind;
        this.data = part.data;
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
      case "text":
        // SAFETY: snapshots and update() keep status aligned with the part discriminant.
        return {
          id: this.partKey,
          kind: this.kind,
          role: this.role!,
          entryId: this.piId,
          text: this.text!,
          status: this.status as TextStatus,
          deliveryState: this.deliveryState,
          renderAs: this.renderAs,
          crossSession: this.crossSession,
        };
      case "skill":
        return { id: this.partKey, kind: this.kind, name: this.name!, content: this.content! };
      case "reasoning":
        // SAFETY: snapshots and update() keep reasoning status aligned with the part discriminant.
        return {
          id: this.partKey,
          kind: this.kind,
          text: this.text!,
          status: this.status as Extract<UiPart, { kind: "reasoning" }>["status"],
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
          artifactId: this.artifactId,
          filePath: this.filePath,
          diff: this.diff,
          inputStreaming: this.inputStreaming,
          state: this.state!,
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
          data: this.data,
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

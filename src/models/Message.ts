import { Model, id } from "r-state-tree";
import { uiPartSchema, type ToolOutputContent, type UiPart } from "../ipc/session-contract";

type TextRole = Extract<UiPart, { kind: "text" }>["role"];
type TextStatus = Extract<UiPart, { kind: "text" }>["status"];
type PartStatus = Extract<UiPart, { kind: "text" | "reasoning" | "review-run" }>["status"];
type ToolState = Extract<UiPart, { kind: "tool" }>["state"];
type AttachmentKind = Extract<UiPart, { kind: "attachment" }>["attachmentKind"];
type NoticeTone = Extract<UiPart, { kind: "notice" }>["tone"];
type DeliveryState = Extract<UiPart, { kind: "text" }>["deliveryState"];

export class Message extends Model {
  @id id = "";
  kind: UiPart["kind"] = "notice";
  role: TextRole | undefined;
  entryId: string | undefined;
  text: string | undefined;
  content: string | undefined;
  status: PartStatus | undefined;
  deliveryState: DeliveryState | undefined;
  name: string | undefined;
  input: string | undefined;
  output: string | undefined;
  outputContent: ToolOutputContent[] | undefined;
  artifactId: string | undefined;
  filePath: string | undefined;
  diff: string | undefined;
  state: ToolState | undefined;
  title: string | undefined;
  url: string | undefined;
  mediaType: string | undefined;
  attachmentKind: AttachmentKind | undefined;
  data: string | undefined;
  tone: NoticeTone | undefined;
  detail: string | undefined;
  operationId: string | undefined;
  threadIds: string[] | undefined;
  commentCount: number | undefined;
  summary: string | undefined;
  tokensBefore: number | undefined;
  firstKeptEntryId: string | undefined;

  /** Updates live transcript fields without reapplying every optional snapshot field per token. */
  update(part: UiPart) {
    if (part.id !== this.id || part.kind !== this.kind) return false;
    switch (part.kind) {
      case "text":
        this.role = part.role;
        this.entryId = part.entryId;
        this.text = part.text;
        this.status = part.status;
        this.deliveryState = part.deliveryState;
        return true;
      case "skill":
        this.name = part.name;
        this.content = part.content;
        return true;
      case "reasoning":
        this.text = part.text;
        this.status = part.status;
        return true;
      case "tool":
        this.name = part.name;
        this.input = part.input;
        this.output = part.output;
        this.outputContent = part.outputContent;
        this.artifactId = part.artifactId;
        this.filePath = part.filePath;
        this.diff = part.diff;
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
      case "notice":
        this.tone = part.tone;
        this.title = part.title;
        this.detail = part.detail;
        return true;
      case "review-run":
        this.operationId = part.operationId;
        this.threadIds = part.threadIds;
        this.commentCount = part.commentCount;
        this.status = part.status;
        return true;
      case "compaction":
        this.summary = part.summary;
        this.tokensBefore = part.tokensBefore;
        this.firstKeptEntryId = part.firstKeptEntryId;
        return true;
    }
  }

  get value(): UiPart {
    switch (this.kind) {
      case "text":
        // SAFETY: snapshots and update() keep status aligned with the part discriminant.
        return {
          id: this.id,
          kind: this.kind,
          role: this.role!,
          entryId: this.entryId,
          text: this.text!,
          status: this.status as TextStatus,
          deliveryState: this.deliveryState,
        };
      case "skill":
        return { id: this.id, kind: this.kind, name: this.name!, content: this.content! };
      case "reasoning":
        return uiPartSchema.parse({
          id: this.id,
          kind: this.kind,
          text: this.text!,
          status: this.status,
        });
      case "tool":
        return {
          id: this.id,
          kind: this.kind,
          name: this.name!,
          input: this.input!,
          output: this.output,
          outputContent: this.outputContent,
          artifactId: this.artifactId,
          filePath: this.filePath,
          diff: this.diff,
          state: this.state!,
        };
      case "source":
        return { id: this.id, kind: this.kind, title: this.title!, url: this.url! };
      case "attachment":
        return {
          id: this.id,
          kind: this.kind,
          name: this.name!,
          mediaType: this.mediaType!,
          attachmentKind: this.attachmentKind!,
          data: this.data,
        };
      case "notice":
        return {
          id: this.id,
          kind: this.kind,
          tone: this.tone!,
          title: this.title!,
          detail: this.detail,
        };
      case "review-run":
        return uiPartSchema.parse({
          id: this.id,
          kind: this.kind,
          operationId: this.operationId!,
          threadIds: this.threadIds!,
          commentCount: this.commentCount!,
          status: this.status,
        });
      case "compaction":
        return {
          id: this.id,
          kind: this.kind,
          summary: this.summary!,
          tokensBefore: this.tokensBefore!,
          firstKeptEntryId: this.firstKeptEntryId,
        };
    }
  }
}

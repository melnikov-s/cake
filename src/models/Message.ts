import { Model, id, state } from "r-state-tree";
import { uiPartSchema, type UiPart } from "../ipc/session-contract";

type TextRole = Extract<UiPart, { kind: "text" }>["role"];
type PartStatus = Extract<UiPart, { kind: "text" }>["status"];
type ToolState = Extract<UiPart, { kind: "tool" }>["state"];
type AttachmentKind = Extract<UiPart, { kind: "attachment" }>["attachmentKind"];
type NoticeTone = Extract<UiPart, { kind: "notice" }>["tone"];
type DeliveryState = Extract<UiPart, { kind: "text" }>["deliveryState"];

export class Message extends Model {
  @id id = "";
  @state kind: UiPart["kind"] = "notice";
  @state role: TextRole | undefined;
  @state entryId: string | undefined;
  @state text: string | undefined;
  @state status: PartStatus | undefined;
  @state deliveryState: DeliveryState | undefined;
  @state name: string | undefined;
  @state input: string | undefined;
  @state output: string | undefined;
  @state artifactId: string | undefined;
  @state filePath: string | undefined;
  @state diff: string | undefined;
  @state state: ToolState | undefined;
  @state title: string | undefined;
  @state url: string | undefined;
  @state mediaType: string | undefined;
  @state attachmentKind: AttachmentKind | undefined;
  @state data: string | undefined;
  @state tone: NoticeTone | undefined;
  @state detail: string | undefined;
  @state operationId: string | undefined;
  @state threadIds: string[] | undefined;
  @state commentCount: number | undefined;
  @state summary: string | undefined;
  @state tokensBefore: number | undefined;
  @state firstKeptEntryId: string | undefined;

  get value(): UiPart {
    switch (this.kind) {
      case "text":
        return {
          id: this.id,
          kind: this.kind,
          role: this.role!,
          entryId: this.entryId,
          text: this.text!,
          status: this.status!,
          deliveryState: this.deliveryState,
        };
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

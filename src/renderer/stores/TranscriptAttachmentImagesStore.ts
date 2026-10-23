import { Store, observable } from "r-state-tree";
import type { TaskInputReference } from "../../contracts/conversations/task-input";
import { ClientContext } from "./context/ClientContext";

export type TranscriptAttachmentImage =
  | { status: "loading" }
  | { status: "ready"; src: string }
  | { status: "unavailable"; error: string };

/**
 * Renderer-only display pixels for a conversation's vaulted image inputs. A sent
 * message seeds its own pixels so the saved reference never flashes a placeholder;
 * older references load from the session-authorized vault. Pixels never reach an agent.
 */
export class TranscriptAttachmentImagesStore extends Store<{ sessionId(): string | undefined }> {
  private readonly images = observable(new Map<string, TranscriptAttachmentImage>());

  image(referenceId: string): TranscriptAttachmentImage | undefined {
    return this.images.get(referenceId);
  }

  has(referenceId: string) {
    return this.images.has(referenceId);
  }

  remember(referenceId: string, mimeType: string, data: string) {
    this.images.set(referenceId, { status: "ready", src: `data:${mimeType};base64,${data}` });
  }

  async load(reference: TaskInputReference) {
    const sessionId = this.props.sessionId();
    if (!sessionId || this.images.has(reference.id)) return;
    this.images.set(reference.id, { status: "loading" });
    try {
      const content = await ClientContext.consume(this)!.sessionChats.readAttachment(
        { sessionId, reference: reference.id },
        { signal: this.signal },
      );
      if (this.signal.aborted || this.images.get(reference.id)?.status !== "loading") return;
      if (content.kind !== "image") throw new Error("Attachment is not a supported image");
      this.remember(reference.id, content.mimeType, content.data);
    } catch (error) {
      if (this.signal.aborted || this.images.get(reference.id)?.status !== "loading") return;
      this.images.set(reference.id, {
        status: "unavailable",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

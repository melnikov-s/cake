import { Store, observable } from "r-state-tree";
import type { Attachment, FileSuggestion, UiPart } from "../../ipc/session-contract";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { ReviewsStore } from "./ReviewsStore";
import type { SessionOperationCoordinator } from "./SessionOperationCoordinator";
import { describeError } from "../error-details";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the pasted image"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const data = result.slice(result.indexOf(",") + 1);
      if (data.length > 20_000_000) reject(new Error(`${file.name || "Pasted image"} is too large (15 MB maximum)`));
      else resolve(data);
    };
    reader.readAsDataURL(file);
  });
}

interface PendingUserMessage {
  operationId: string;
  workspacePath: string;
  sessionId: string;
  canonicalPartCount: number;
  expectedOccurrence: number;
  text: string;
  parts: UiPart[];
}

export interface MessageComposerStoreProps {
  client: Pick<DesktopClient, "chooseAttachments" | "suggestFiles" | "submit">;
  sessionRegistry: SessionRegistryStore;
  reviews(): ReviewsStore;
  projectPath(): string | undefined;
  sessionId(): string | undefined;
  canonicalParts(): UiPart[];
  draft(): string;
  setDraft(value: string): void;
  canSubmit(): boolean;
  isStreaming(): boolean;
  openCommandPane(pane: "changelog" | "tree" | "resources"): Promise<void>;
  matchesPluginCommand(input: string): boolean;
  runPluginCommand(input: string): Promise<boolean>;
  operations: SessionOperationCoordinator;
  operationOwner: string;
}

/** Owns attachments, optimistic immediate prompts, and prompt delivery. */
export class MessageComposerStore extends Store<MessageComposerStoreProps> {
  attachments: Attachment[] = observable([]);
  pendingUserMessages: PendingUserMessage[] = observable([]);
  focusRequestRevision = 0;
  error: string | undefined;
  errorDetails: string | undefined;
  get activeOperations() { return this.props.operations.active(this.props.operationOwner); }

  private reportError(error: unknown) {
    const described = describeError(error);
    this.error = described.message;
    this.errorDetails = described.details;
  }

  requestFocus() {
    this.focusRequestRevision += 1;
  }

  get parts() {
    const canonical = this.props.canonicalParts();
    const workspacePath = this.props.projectPath();
    const sessionId = this.props.sessionId();
    if (!workspacePath || !sessionId) return canonical;
    const pendingParts = this.pendingUserMessages
      .filter((pending) => pending.workspacePath === workspacePath && pending.sessionId === sessionId)
      .filter((pending) => this.userMessageOccurrenceCount(pending.workspacePath, pending.sessionId, pending.text, pending.parts) < pending.expectedOccurrence);
    if (pendingParts.length === 0) return canonical;
    const parts = [...canonical];
    let offset = 0;
    for (const pending of pendingParts) {
      parts.splice(Math.min(pending.canonicalPartCount + offset, parts.length), 0, ...pending.parts);
      offset += pending.parts.length;
    }
    return parts;
  }

  async addAttachments() {
    this.error = undefined; this.errorDetails = undefined;
    try {
      const selected = await this.props.client.chooseAttachments();
      if (this.signal.aborted) return;
      const draft = this.props.draft();
      const fileMentions = selected.filter((item): item is Extract<Attachment, { kind: "file" }> => item.kind === "file")
        .map((item) => /[\s"]/.test(item.path) ? `@"${item.path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : `@${item.path}`);
      if (fileMentions.length > 0) this.props.setDraft(`${draft}${draft.length > 0 && !/\s$/.test(draft) ? " " : ""}${fileMentions.join(" ")}`);
      const images = selected.filter((item): item is Extract<Attachment, { kind: "image" }> => item.kind === "image");
      this.attachments.push(...images.filter((item) => !this.attachments.some((current) => current.kind === "image" && current.name === item.name)));
    } catch (error) { this.reportError(error); }
  }

  async addPastedImages(files: readonly File[]) {
    this.error = undefined; this.errorDetails = undefined;
    try {
      const images = files.filter((file) => file.type.startsWith("image/")).slice(0, Math.max(0, 20 - this.attachments.length));
      const attachments = await Promise.all(images.map(async (file, index): Promise<Extract<Attachment, { kind: "image" }>> => ({
        kind: "image", name: file.name || `Pasted image ${index + 1}`, mimeType: file.type, data: await fileToBase64(file)
      })));
      this.attachments.push(...attachments);
    } catch (error) { this.reportError(error); }
  }

  suggestFiles(prefix: string): Promise<FileSuggestion[]> {
    const projectPath = this.props.projectPath();
    return projectPath ? this.props.client.suggestFiles(projectPath, prefix) : Promise.resolve([]);
  }

  removeAttachment(index: number) { this.attachments.splice(index, 1); }

  async submit(deliveryOverride?: "steer") {
    if (!this.props.canSubmit()) return;
    this.error = undefined; this.errorDetails = undefined;
    const text = this.props.draft().trim();
    const command = text.toLocaleLowerCase();
    if (command === "/tree" || command === "/resources" || command === "/changelog") {
      this.props.setDraft("");
      await this.props.openCommandPane(command === "/tree" ? "tree" : command === "/changelog" ? "changelog" : "resources");
      return;
    }
    if (this.props.matchesPluginCommand(text)) {
      await this.props.runPluginCommand(text);
      this.props.setDraft("");
      return;
    }
    const workspacePath = this.props.projectPath();
    const sessionId = this.props.sessionId();
    if (!workspacePath || !sessionId) return;
    const delivery = deliveryOverride ?? (this.props.isStreaming() ? "follow-up" : "prompt");
    const attachments = this.attachments.slice();
    const threadIds = this.props.reviews().pendingThreads.map((thread) => thread.id);
    this.props.setDraft("");
    const submissions: Promise<void>[] = [];
    if (threadIds.length > 0) submissions.push(this.props.reviews().submitThreads(threadIds, text || undefined));
    if (text || attachments.length > 0) {
      const operationId = this.props.operations.start(this.props.operationOwner);
      this.attachments.splice(0);
      if (delivery === "prompt") this.addPendingUserMessage(operationId, workspacePath, sessionId, text, attachments);
      submissions.push(this.props.client.submit({ operationId, workspacePath, sessionId, text, delivery, attachments }).catch((error) => {
        this.removePendingUserMessage(operationId);
        this.reportError(error);
        if (!this.props.draft().trim()) this.props.setDraft(text);
        this.attachments.push(...attachments);
        this.finishOperation(operationId);
      }));
    }
    await Promise.all(submissions);
  }

  reconcile(sessionId: string) {
    for (let index = this.pendingUserMessages.length - 1; index >= 0; index -= 1) {
      const pending = this.pendingUserMessages[index]!;
      if (pending.sessionId === sessionId && this.userMessageOccurrenceCount(pending.workspacePath, sessionId, pending.text, pending.parts) >= pending.expectedOccurrence) this.pendingUserMessages.splice(index, 1);
    }
  }

  receive(event: DesktopClientEvent) {
    if (event.type === "pi-state-changed" && (event.state === "failed" || event.state === "stopped")) {
      for (const operationId of this.activeOperations.slice()) this.finishOperation(operationId);
      this.pendingUserMessages.splice(0);
      return;
    }
    if ((event.type === "operation-completed" || event.type === "operation-failed") && event.operationId && this.activeOperations.includes(event.operationId)) {
      if (event.type === "operation-failed") {
        this.removePendingUserMessage(event.operationId);
        this.reportError(event.message);
      }
      this.finishOperation(event.operationId);
    }
  }

  private finishOperation(operationId: string) {
    this.props.operations.finish(operationId);
  }

  private addPendingUserMessage(operationId: string, workspacePath: string, sessionId: string, text: string, attachments: Attachment[]) {
    const imageParts: UiPart[] = attachments.flatMap((attachment, index) => attachment.kind === "image" ? [{ id: `optimistic-user-${operationId}-attachment-${index}`, kind: "attachment" as const, name: attachment.name, mediaType: attachment.mimeType, attachmentKind: "image" as const, data: attachment.data }] : []);
    const parts: UiPart[] = [...(text ? [{ id: `optimistic-user-${operationId}`, kind: "text" as const, role: "user" as const, text, status: "complete" as const }] : []), ...imageParts];
    const firstImageData = imageParts[0]?.kind === "attachment" ? imageParts[0].data : undefined;
    const earlierPendingCount = this.pendingUserMessages.filter((pending) => pending.workspacePath === workspacePath && pending.sessionId === sessionId && pending.text === text && (Boolean(text) || pending.parts.some((part) => part.kind === "attachment" && part.data === firstImageData))).length;
    this.pendingUserMessages.push({ operationId, workspacePath, sessionId, canonicalPartCount: this.props.sessionRegistry.findModel(sessionId, workspacePath)?.uiParts.length ?? 0, expectedOccurrence: this.userMessageOccurrenceCount(workspacePath, sessionId, text, parts) + earlierPendingCount + 1, text, parts });
  }

  private removePendingUserMessage(operationId: string) {
    const index = this.pendingUserMessages.findIndex((pending) => pending.operationId === operationId);
    if (index >= 0) this.pendingUserMessages.splice(index, 1);
  }

  private userMessageOccurrenceCount(workspacePath: string, sessionId: string, text: string, parts: UiPart[] = []) {
    const canonical = this.props.sessionRegistry.findModel(sessionId, workspacePath)?.uiParts ?? [];
    if (text) return canonical.filter((part) => part.kind === "text" && part.role === "user" && part.status === "complete" && part.text === text).length;
    const image = parts.find((part): part is Extract<UiPart, { kind: "attachment" }> => part.kind === "attachment" && part.attachmentKind === "image");
    return image?.data ? canonical.filter((part) => part.kind === "attachment" && part.data === image.data).length : 0;
  }
}

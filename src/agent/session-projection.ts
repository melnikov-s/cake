import { type AgentSessionEvent, type SessionEntry, type SessionManager } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { z } from "zod";
import { artifactPointerSchema, type ArtifactPointer } from "../ipc/artifact-contract";
import type { Attachment, SessionTreeEntry, UiPart } from "../ipc/session-contract";

export const reviewRunEntryType = "cake.review-run/v1";
export const reviewRunEntrySchema = z.object({
  operationId: z.uuid(),
  threadIds: z.array(z.string().min(1).max(256)).min(1).max(100),
  commentCount: z.number().int().positive().max(1_000_000),
  status: z.enum(["running", "complete", "error"])
});
export type ReviewRunEntry = z.infer<typeof reviewRunEntrySchema>;

export function boundedProjectionKey(value: string, maximum = 256) {
  if (value.length <= maximum) return value;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `${value.slice(0, maximum - digest.length - 1)}:${digest}`;
}

export function formatUnknown(value: unknown, limit = 48_000) {
  let formatted: string;
  if (typeof value === "string") formatted = value;
  else {
    try {
      formatted = JSON.stringify(value, null, 2);
    } catch {
      formatted = String(value);
    }
  }
  return formatted.length > limit ? `${formatted.slice(0, limit)}\n…` : formatted;
}

export function formatToolInput(toolName: string, args: unknown) {
  if (toolName === "bash" && typeof args === "object" && args !== null) {
    const command = Reflect.get(args, "command");
    if (typeof command === "string") return formatUnknown(command);
  }
  return formatUnknown(args);
}

export function toolFilePath(_toolName: string, args: unknown) {
  if (typeof args !== "object" || args === null) return undefined;
  const path = Reflect.get(args, "path") ?? Reflect.get(args, "file_path");
  return typeof path === "string" && path.length <= 8_192 ? path : undefined;
}

export function toolResultDiff(_toolName: string, result: unknown) {
  if (typeof result !== "object" || result === null) return undefined;
  const details = Reflect.get(result, "details");
  if (typeof details !== "object" || details === null) return undefined;
  const diff = Reflect.get(details, "diff") ?? Reflect.get(details, "patch");
  return typeof diff === "string" ? diff : undefined;
}

export function toolArtifactId(value: unknown) {
  if (typeof value !== "object" || value === null) return undefined;
  const direct = Reflect.get(value, "artifactId");
  if (typeof direct === "string") return direct;
  const details = Reflect.get(value, "details");
  if (typeof details === "object" && details !== null && typeof Reflect.get(details, "artifactId") === "string") return Reflect.get(details, "artifactId") as string;
  const artifact = Reflect.get(value, "artifact");
  if (typeof artifact === "object" && artifact !== null && typeof Reflect.get(artifact, "id") === "string") return Reflect.get(artifact, "id") as string;
  const request = Reflect.get(value, "request");
  return typeof request === "object" && request !== null && typeof Reflect.get(request, "id") === "string" ? Reflect.get(request, "id") as string : undefined;
}

export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: "text"; text: string } =>
      typeof item === "object" && item !== null && Reflect.get(item, "type") === "text" && typeof Reflect.get(item, "text") === "string")
    .map((item) => item.text)
    .join("\n");
}

function partsFromMessage(message: unknown, baseId: string, streaming = false, entryId?: string): UiPart[] {
  if (typeof message !== "object" || message === null) return [];
  const role = Reflect.get(message, "role");
  const content = Reflect.get(message, "content");

  if (role === "user") {
    const parts: UiPart[] = [];
    const text = textFromContent(content);
    if (text) parts.push({ id: `${baseId}-text`, kind: "text", role: "user", entryId, text, status: "complete" });
    if (Array.isArray(content)) {
      content.forEach((item, index) => {
        if (typeof item === "object" && item !== null && Reflect.get(item, "type") === "image") {
          const data = Reflect.get(item, "data");
          parts.push({ id: `${baseId}-attachment-${index}`, kind: "attachment", name: `Image ${index + 1}`, mediaType: String(Reflect.get(item, "mimeType") ?? "image").slice(0, 128), attachmentKind: "image", data: typeof data === "string" && data.length <= 20_000_000 ? data : undefined });
        }
      });
    }
    return parts;
  }

  if (role === "assistant" && Array.isArray(content)) {
    const parts = content.flatMap((item, index): UiPart[] => {
      if (typeof item !== "object" || item === null) return [];
      const type = Reflect.get(item, "type");
      if (type === "text") {
        const text = String(Reflect.get(item, "text") ?? "");
        if (!text) return [];
        const sources = [...new Set(text.match(/https?:\/\/[^\s)\]}>,]+/g) ?? [])].filter((url) => url.length <= 8_192).slice(0, 20);
        return [
          { id: `${baseId}-text-${index}`, kind: "text", role: "assistant", entryId, text, status: streaming ? "streaming" : Reflect.get(message, "errorMessage") ? "error" : "complete" },
          ...sources.map((url, sourceIndex): UiPart => ({ id: `${baseId}-source-${index}-${sourceIndex}`, kind: "source", title: sourceTitle(url), url }))
        ];
      }
      if (type === "thinking") {
        return [{ id: `${baseId}-reasoning-${index}`, kind: "reasoning", text: String(Reflect.get(item, "thinking") ?? ""), status: streaming ? "streaming" : "complete" }];
      }
      if (type === "toolCall") {
        const name = String(Reflect.get(item, "name") ?? "tool");
        const args = Reflect.get(item, "arguments");
        return [{ id: boundedProjectionKey(`tool-${String(Reflect.get(item, "id"))}`), kind: "tool", name, input: formatToolInput(name, args), artifactId: toolArtifactId(args), filePath: toolFilePath(name, args), state: "running" }];
      }
      return [];
    });
    const errorMessage = Reflect.get(message, "errorMessage");
    if (!parts.some((part) => part.kind === "text") && typeof errorMessage === "string" && errorMessage.trim()) {
      parts.push({ id: `${baseId}-error`, kind: "notice", tone: "error", title: "Model request failed", detail: errorMessage.trim() });
    }
    return parts;
  }

  if (role === "toolResult") {
    const name = String(Reflect.get(message, "toolName") ?? "tool");
    const details = Reflect.get(message, "details");
    return [{
      id: boundedProjectionKey(`tool-${String(Reflect.get(message, "toolCallId"))}`),
      kind: "tool",
      name,
      input: "",
      output: textFromContent(content) || formatUnknown(details),
      artifactId: toolArtifactId({ details }),
      diff: toolResultDiff(name, { details }),
      state: Reflect.get(message, "isError") ? "error" : "success"
    }];
  }

  if (role === "custom" && Reflect.get(message, "display") === true) {
    return [{ id: `${baseId}-custom`, kind: "notice", tone: "info", title: String(Reflect.get(message, "customType") ?? "Extension"), detail: textFromContent(content) }];
  }
  return [];
}

export function createLiveMessageProjector() {
  let activeStreamId: string | undefined;
  let streamIndex = 0;

  const nextStreamId = () => `stream-${++streamIndex}`;

  return (event: AgentSessionEvent): UiPart[] => {
    if (event.type === "message_start" && event.message.role === "assistant") {
      activeStreamId = nextStreamId();
      return [];
    }
    if (event.type === "message_update") {
      activeStreamId ??= nextStreamId();
      return partsFromMessage(event.message, activeStreamId, true);
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      activeStreamId ??= nextStreamId();
      const parts = partsFromMessage(event.message, activeStreamId);
      activeStreamId = undefined;
      return parts;
    }
    return [];
  };
}

export function reviewRunPart(run: ReviewRunEntry): Extract<UiPart, { kind: "review-run" }> {
  return { id: `review-run-${run.operationId}`, kind: "review-run", ...run };
}

export function projectSessionEntries(entries: readonly SessionEntry[], branchEntries: readonly SessionEntry[] = entries) {
  const projected: UiPart[] = [];
  const indexes = new Map<string, number>();
  const append = (part: UiPart) => {
    const existingIndex = indexes.get(part.id);
    if (existingIndex === undefined) {
      indexes.set(part.id, projected.length);
      projected.push(part);
      return;
    }
    const existing = projected[existingIndex];
    projected[existingIndex] = existing?.kind === "tool" && part.kind === "tool"
      ? { ...existing, ...part, input: part.input || existing.input, filePath: part.filePath || existing.filePath }
      : part;
  };

  const visibleRunIds = new Set(entries.flatMap((entry) => {
    if (entry.type !== "custom" || entry.customType !== reviewRunEntryType) return [];
    const run = reviewRunEntrySchema.safeParse(entry.data);
    return run.success ? [run.data.operationId] : [];
  }));
  const compactedRuns = new Map<string, ReviewRunEntry>();
  for (const entry of branchEntries) {
    if (entry.type !== "custom" || entry.customType !== reviewRunEntryType) continue;
    const run = reviewRunEntrySchema.safeParse(entry.data);
    if (run.success && !visibleRunIds.has(run.data.operationId)) compactedRuns.set(run.data.operationId, run.data);
  }
  for (const run of compactedRuns.values()) append(reviewRunPart(run));

  for (const entry of entries) {
    if (entry.type === "message") {
      for (const part of partsFromMessage(entry.message, `entry-${entry.id}`, false, entry.id)) append(part);
      continue;
    }
    if (entry.type !== "custom" || entry.customType !== reviewRunEntryType) continue;
    const run = reviewRunEntrySchema.safeParse(entry.data);
    if (run.success) append(reviewRunPart(run.data));
  }
  return projected;
}

export function imageContent(attachments: Attachment[]) {
  return attachments.flatMap((attachment) => attachment.kind === "image"
    ? [{ type: "image" as const, data: attachment.data, mimeType: attachment.mimeType }]
    : []);
}

export function promptText(text: string, attachments: Attachment[]) {
  const mentions = attachments.filter((item) => item.kind === "file").map((item) => `@${item.path}`);
  return mentions.length ? `${text}\n\n${mentions.join("\n")}` : text;
}

function sourceTitle(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return "Source";
  }
}

function entryPreview(entry: { type: string }) {
  const value = entry as unknown as Record<string, unknown>;
  if (entry.type === "message") {
    const message = value.message as Record<string, unknown> | undefined;
    const role = String(message?.role ?? "message");
    const text = textFromContent(message?.content).replace(/[\n\t]+/g, " ").trim();
    if (role === "user") return text.slice(0, 2_048);
    if (role === "assistant") {
      if (text) return text.slice(0, 2_048);
      if (message?.stopReason === "aborted") return "(aborted)";
      if (message?.errorMessage) return String(message.errorMessage).replace(/[\n\t]+/g, " ").trim().slice(0, 2_048);
      return "";
    }
    if (role === "toolResult") return `[${String(message?.toolName ?? "tool")}]`;
    if (role === "bashExecution") return `[bash]: ${String(message?.command ?? "")}`.slice(0, 2_048);
    return `[${role}]`;
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") return String(value.summary ?? "").slice(0, 2_048);
  if (entry.type === "session_info") return String(value.name ?? "Session renamed").slice(0, 2_048);
  if (entry.type === "model_change") return `${String(value.provider ?? "")}/${String(value.modelId ?? "")}`;
  return entry.type.replaceAll("_", " ");
}

function entryMessageValue(entry: object, key: string) {
  const message = Reflect.get(entry, "message");
  return typeof message === "object" && message !== null ? Reflect.get(message, key) : undefined;
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
      messageRole: node.entry.type === "message" ? String(entryMessageValue(node.entry, "role") ?? "message") : undefined,
      editorText: node.entry.type === "message" && entryMessageValue(node.entry, "role") === "user"
        ? textFromContent(entryMessageValue(node.entry, "content"))
        : undefined,
      label: node.label,
      preview: entryPreview(node.entry),
      active: activeIds.has(node.entry.id)
    });
    for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]!);
  }
  return entries;
}

export function projectArtifactPointers(sessionManager: SessionManager): ArtifactPointer[] {
  const pointers = new Map<string, ArtifactPointer>();
  for (const entry of sessionManager.getBranch()) {
    if (entry.type !== "custom" || Reflect.get(entry, "customType") !== "cake.artifact/v1") continue;
    const parsed = artifactPointerSchema.safeParse(Reflect.get(entry, "data"));
    if (!parsed.success) continue;
    const current = pointers.get(parsed.data.artifactId);
    if (!current || parsed.data.revision > current.revision) pointers.set(parsed.data.artifactId, parsed.data);
  }
  return [...pointers.values()];
}

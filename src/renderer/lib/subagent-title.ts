import { textPreview } from "./text-preview";

/** A worker's generated title, or its trimmed task until one exists. */
export function subagentTitle(worker: {
  readonly title?: string | undefined;
  readonly task: string;
}): string {
  return worker.title?.trim() || textPreview(worker.task) || "Subagent";
}

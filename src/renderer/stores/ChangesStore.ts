import { Store } from "r-state-tree";
import type { SessionChange } from "../../ipc/session-contract";
import { diffStats } from "../components/ai-elements/diff-view";
import type { SessionModel } from "../models/session";

export interface ChangesStoreProps {
  session(): SessionModel | undefined;
  refreshSession(): Promise<void>;
}

/** Owns navigation and derived file state for the session-changes surface. */
export class ChangesStore extends Store<ChangesStoreProps> {
  path: string | null | undefined;

  get changes() {
    const session = this.props.session();
    const changesByCall = new Map((session?.sessionChanges ?? []).map((change) => [change.toolCallId, change]));
    for (const part of session?.uiParts ?? []) {
      if (part.kind !== "tool" || part.name !== "edit" || part.state !== "success" || !part.filePath || !part.diff) continue;
      const toolCallId = part.id.startsWith("tool-") ? part.id.slice(5) : part.id;
      if (changesByCall.has(toolCallId)) continue;
      const stats = diffStats(part.diff);
      changesByCall.set(toolCallId, { id: part.id, toolCallId, toolName: part.name, path: part.filePath, ...stats, diff: part.diff, timestamp: new Date(0).toISOString() });
    }
    const changesByFile = new Map<string, SessionChange>();
    for (const change of changesByCall.values()) {
      const existing = changesByFile.get(change.path);
      if (!existing) {
        changesByFile.set(change.path, { ...change, id: `file:${change.path}` });
        continue;
      }
      changesByFile.set(change.path, {
        ...existing,
        additions: existing.additions + change.additions,
        deletions: existing.deletions + change.deletions,
        diff: `${existing.diff}\n${change.diff}`,
        timestamp: change.timestamp
      });
    }
    return [...changesByFile.values()];
  }

  get selected() {
    return typeof this.path === "string"
      ? this.changes.find((change) => change.path === this.path) ?? this.changes[0]
      : this.changes[0];
  }

  async open(path?: string) {
    this.path = path ?? this.changes[0]?.path ?? null;
    await this.props.refreshSession();
  }

  select(path: string) {
    if (this.changes.some((change) => change.path === path)) this.path = path;
  }

  focusPath(path: string) {
    this.path = path;
  }

  close() {
    this.path = undefined;
  }
}

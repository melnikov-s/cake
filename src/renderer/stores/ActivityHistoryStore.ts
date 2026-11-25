import { Store } from "r-state-tree";
import type {
  ActivityCursor,
  ActivityEntry,
  ActivityKind,
  ActivityQuery,
} from "../../contracts/application/activity-history";
import type { Client } from "../client/Client";

/** Window-local filters and paging. The backend, not the toast queue, owns the entries. */
export class ActivityHistoryStore extends Store<{
  client: Pick<Client["application"], "listActivity">;
}> {
  visible = false;
  projectPath: string | null | undefined;
  kind: ActivityKind | undefined;
  entries: readonly ActivityEntry[] = [];
  next: ActivityCursor | undefined;
  busy = false;
  error: string | undefined;
  private request: AbortController | undefined;

  constructor(props: ActivityHistoryStore["props"]) {
    super(props);
    this.effect(() => () => this.request?.abort());
  }

  open(projectPath?: string) {
    this.visible = true;
    this.projectPath = projectPath;
    this.kind = undefined;
    void this.refresh();
  }

  close() {
    this.request?.abort();
    this.visible = false;
  }

  setProject(projectPath: string | null | undefined) {
    this.projectPath = projectPath;
    void this.refresh();
  }

  setKind(kind: ActivityKind | undefined) {
    this.kind = kind;
    void this.refresh();
  }

  refresh() {
    this.entries = [];
    this.next = undefined;
    return this.load();
  }

  loadOlder() {
    if (!this.busy && this.next) return this.load(this.next);
  }

  private async load(before?: ActivityCursor) {
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    this.busy = true;
    this.error = undefined;
    try {
      const query: ActivityQuery = {};
      if (this.projectPath !== undefined) Object.assign(query, { projectPath: this.projectPath });
      if (this.kind !== undefined) Object.assign(query, { kind: this.kind });
      if (before !== undefined) Object.assign(query, { before });
      const page = await this.props.client.listActivity(query, { signal: request.signal });
      if (request.signal.aborted) return;
      const loaded = new Set(this.entries.map((entry) => entry.id));
      this.entries = [...this.entries, ...page.entries.filter((entry) => !loaded.has(entry.id))];
      this.next = page.next;
    } catch (error) {
      if (!request.signal.aborted)
        this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (!request.signal.aborted) this.busy = false;
    }
  }
}

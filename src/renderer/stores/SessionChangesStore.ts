import { Store, observable, untracked } from "r-state-tree";
import type { ChangedFile, WorktreeChanges } from "../../contracts/worktrees/worktree-changes";
import { workingDirectoryEditorLocation } from "../../contracts/editor/editor-location";
import type { WorktreeStoreProps } from "./WorktreeStore";
import { ClientContext } from "./context/ClientContext";
import { SessionPresentationContext } from "./context/SessionPresentationContext";
import type { SideChatStore } from "./SideChatStore";
import { describeError } from "../lib/error-details";

export interface SessionChangesStoreProps {
  workspacePath(): string;
  enabled(): boolean;
  isStreaming(): boolean;
  worktreeOperation: WorktreeStoreProps["operation"];
  panel(): SideChatStore;
}

/** One ordinary session's transient branch review, using the shared accessory slot. */
export class SessionChangesStore extends Store<SessionChangesStoreProps> {
  data: WorktreeChanges | undefined;
  loading = false;
  width = 334;
  error: string | undefined;
  expandedCommits = observable(new Set<string>());
  commitsExpanded = true;
  uncommittedExpanded = true;
  private request = 0;

  constructor(props: SessionChangesStore["props"]) {
    super(props);
    this.effect(() => {
      const enabled = this.props.enabled();
      this.props.workspacePath();
      if (enabled) untracked(() => void this.refresh());
    });
    this.reaction(
      () => this.props.isStreaming(),
      (streaming, previous) => {
        if (previous && !streaming && this.props.enabled()) void this.refresh();
      },
    );
    this.reaction(
      () => this.props.worktreeOperation(),
      () => {
        if (this.props.enabled()) void this.refresh();
      },
    );
  }

  get open() {
    return this.props.panel().target?.changes === this;
  }

  close() {
    if (this.open) this.props.panel().close();
  }

  toggle() {
    if (this.open) this.props.panel().close();
    else {
      this.props.panel().open({ key: "changes", title: "Changes", changes: this });
      void this.refresh();
    }
  }

  setWidth(width: number) {
    this.width = width;
  }

  toggleCommit(hash: string) {
    if (this.expandedCommits.has(hash)) this.expandedCommits.delete(hash);
    else this.expandedCommits.add(hash);
  }

  toggleCommits() {
    this.commitsExpanded = !this.commitsExpanded;
  }

  toggleUncommitted() {
    this.uncommittedExpanded = !this.uncommittedExpanded;
  }

  /** Latest read wins; requests are cancelled with their owning session. */
  async refresh() {
    const request = ++this.request;
    const path = this.props.workspacePath();
    this.loading = true;
    this.error = undefined;
    try {
      const data = await ClientContext.consume(this)!.managedWorktrees.inspectChanges(path, {
        signal: this.signal,
      });
      if (this.signal.aborted || request !== this.request) return;
      this.data = data;
    } catch (error) {
      if (!this.signal.aborted && request === this.request)
        this.error = describeError(error).message;
    } finally {
      if (!this.signal.aborted && request === this.request) this.loading = false;
    }
  }

  async openFile(file: ChangedFile, commit?: string) {
    const location = workingDirectoryEditorLocation(
      file.deleted || !file.workingTreeExists
        ? {
            path: file.path,
            view: "changes",
            side: "before",
            base: commit ? (file.deleted ? `${commit}^` : commit) : "HEAD",
          }
        : commit
          ? { path: file.path }
          : { path: file.path, view: "changes" },
    );
    try {
      await SessionPresentationContext.consume(this)!.openFile(location);
    } catch (error) {
      if (!this.signal.aborted) this.error = describeError(error).message;
    }
  }

  async openWorkspaceChanges() {
    try {
      await SessionPresentationContext.consume(this)!.openWorkspaceChanges();
    } catch (error) {
      if (!this.signal.aborted) this.error = describeError(error).message;
    }
  }
}

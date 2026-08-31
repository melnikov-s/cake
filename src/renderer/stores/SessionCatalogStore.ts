import { Store, observable } from "r-state-tree";
import type { GlobalSessionSummary, SessionSnapshot } from "../../ipc/session-contract";
import type { WorktreeRecord } from "../../ipc/worktree-contract";
import { compareSessionSummariesForSidebar } from "../../utils/session-summary-order";

/** The flat renderer projection of Pi summaries and cataloged Cake-owned pseudo-sessions. */
export class SessionCatalogStore extends Store<Record<string, never>> {
  readonly sessions: GlobalSessionSummary[] = observable([]);
  private indexedById = new Map<string, GlobalSessionSummary>();
  private indexedByProject = new Map<string, GlobalSessionSummary[]>();
  private resolvedSessionIds = new Set<string>();
  private unreadSessionIds = new Set<string>();
  /** Managed worktree workspaces mapped to their durable Git metadata. */
  private readonly managedWorktrees = observable(new Map<string, WorktreeRecord>());

  /** Registers current managed-worktree metadata and projects it into every matching session. */
  noteManagedWorktree(record: WorktreeRecord) {
    this.managedWorktrees.set(record.worktreePath, record);
    let changed = false;
    for (let index = 0; index < this.sessions.length; index += 1) {
      const session = this.sessions[index]!;
      if (session.workspacePath !== record.worktreePath) continue;
      this.sessions.splice(index, 1, {
        ...session,
        managedWorktree: record,
        projectPath: record.projectPath,
      });
      changed = true;
    }
    if (changed) this.rebuildIndexes();
  }

  managedWorktree(workspacePath: string) {
    return this.managedWorktrees.get(workspacePath);
  }

  /** The parent project of a managed worktree workspace, if it is one. */
  projectOfManagedWorktree(workspacePath: string) {
    return this.managedWorktrees.get(workspacePath)?.projectPath;
  }

  find(sessionId: string) {
    return this.indexedById.get(sessionId);
  }

  get sessionsById(): ReadonlyMap<string, GlobalSessionSummary> {
    return this.indexedById;
  }

  get sessionsByProject(): ReadonlyMap<string, readonly GlobalSessionSummary[]> {
    return this.indexedByProject;
  }

  projectSessions(workspacePath: string) {
    return this.indexedByProject.get(workspacePath) ?? [];
  }

  /** Landed worktrees whose sessions have all been resolved and are safe to clean up. */
  resolvedWorktrees(projectPath: string) {
    const sessionsByWorktree = new Map<string, GlobalSessionSummary[]>();
    for (const session of this.projectSessions(projectPath)) {
      const record = session.managedWorktree;
      if (!record || record.state !== "landed") continue;
      const sessions = sessionsByWorktree.get(record.worktreePath) ?? [];
      sessions.push(session);
      sessionsByWorktree.set(record.worktreePath, sessions);
    }
    return [...sessionsByWorktree.values()]
      .filter((sessions) => sessions.length > 0 && sessions.every((session) => session.resolved))
      .map((sessions) => sessions[0]!.managedWorktree!);
  }

  replace(sessions: GlobalSessionSummary[]) {
    this.assertUniqueIds(sessions);
    this.sessions.splice(0, this.sessions.length, ...sessions);
    this.sortBySidebarOrder();
    this.rebuildIndexes();
  }

  applyWorkspace(
    workspacePath: string,
    workspaceName: string,
    sessions: SessionSnapshot["sessions"],
    retainedSessionIds: readonly string[] = [],
  ) {
    const prior = new Map(
      this.sessions
        .filter((session) => session.workspacePath === workspacePath)
        .map((session) => [session.id, session]),
    );
    const otherSessions = this.sessions.filter(
      (session) => session.workspacePath !== workspacePath,
    );
    const managedWorktree = this.managedWorktrees.get(workspacePath);
    const workspaceSessions: GlobalSessionSummary[] = sessions.map((session) => ({
      ...session,
      managedWorktree,
      projectPath: managedWorktree?.projectPath,
      resolved:
        this.resolvedSessionIds.has(session.id) ||
        prior.get(session.id)?.resolved === true ||
        session.resolved,
      unread: this.unreadSessionIds.has(session.id) || prior.get(session.id)?.unread === true,
      workspacePath,
      workspaceName,
    }));
    const listedIds = new Set(workspaceSessions.map((session) => session.id));
    for (const sessionId of retainedSessionIds) {
      const retained = prior.get(sessionId);
      if (retained && !listedIds.has(sessionId)) workspaceSessions.push(retained);
    }
    const next = [...otherSessions, ...workspaceSessions];
    this.assertUniqueIds(next);
    this.sessions.splice(0, this.sessions.length, ...next);
    this.sortBySidebarOrder();
    this.rebuildIndexes();
  }

  applyResolvedState(resolvedSessionIds: readonly string[]) {
    this.resolvedSessionIds = new Set(resolvedSessionIds);
    for (let index = 0; index < this.sessions.length; index += 1) {
      const session = this.sessions[index]!;
      if (session.draft) continue;
      const resolved = this.resolvedSessionIds.has(session.id);
      if (session.resolved !== resolved) this.sessions.splice(index, 1, { ...session, resolved });
    }
    this.rebuildIndexes();
  }

  applyUnreadState(unreadSessionIds: readonly string[]) {
    this.unreadSessionIds = new Set(unreadSessionIds);
    for (let index = 0; index < this.sessions.length; index += 1) {
      const session = this.sessions[index]!;
      const unread = this.unreadSessionIds.has(session.id);
      if (session.unread !== unread) this.sessions.splice(index, 1, { ...session, unread });
    }
    this.rebuildIndexes();
  }

  upsertPending(
    sessionId: string,
    workspacePath: string,
    workspaceName: string,
    options: { draft?: boolean; resolved?: boolean } = {},
  ) {
    const now = new Date().toISOString();
    const existing = this.indexedById.get(sessionId);
    const managedWorktree = this.managedWorktrees.get(workspacePath);
    const summary: GlobalSessionSummary = {
      id: sessionId,
      title: existing?.title ?? "New chat",
      created: existing?.created ?? now,
      modified: now,
      messageCount: 0,
      resolved: options.resolved ?? existing?.resolved ?? false,
      unread: existing?.unread ?? false,
      draft: options.draft ?? existing?.draft ?? false,
      workspacePath,
      workspaceName,
      managedWorktree,
      projectPath: managedWorktree?.projectPath,
    };
    const next = this.sessions.filter((session) => session.id !== sessionId);
    next.push(summary);
    this.sessions.splice(0, this.sessions.length, ...next);
    this.sortBySidebarOrder();
    this.rebuildIndexes();
  }

  setDraft(sessionId: string, draft: boolean) {
    const index = this.sessions.findIndex((session) => session.id === sessionId);
    if (index < 0) return;
    const session = this.sessions[index]!;
    this.sessions.splice(index, 1, { ...session, draft });
    this.rebuildIndexes();
  }

  setResolved(sessionId: string, resolved: boolean) {
    const index = this.sessions.findIndex((session) => session.id === sessionId);
    if (index < 0) return;
    const session = this.sessions[index]!;
    this.sessions.splice(index, 1, { ...session, resolved });
    this.sortBySidebarOrder();
    this.rebuildIndexes();
  }

  remove(sessionId: string) {
    const index = this.sessions.findIndex((session) => session.id === sessionId);
    if (index < 0) return;
    this.sessions.splice(index, 1);
    this.rebuildIndexes();
  }

  rename(sessionId: string, title: string) {
    const index = this.sessions.findIndex((session) => session.id === sessionId);
    if (index < 0) return undefined;
    const session = this.sessions[index]!;
    const previousTitle = session.title;
    this.sessions.splice(index, 1, { ...session, title });
    this.rebuildIndexes();
    return previousTitle;
  }

  updateWorkspaceNames(names: ReadonlyMap<string, string>) {
    for (let index = 0; index < this.sessions.length; index += 1) {
      const session = this.sessions[index]!;
      const workspaceName = names.get(session.workspacePath) ?? session.workspaceName;
      if (workspaceName !== session.workspaceName)
        this.sessions.splice(index, 1, { ...session, workspaceName });
    }
    this.rebuildIndexes();
  }

  private sortBySidebarOrder() {
    this.sessions.sort(compareSessionSummariesForSidebar);
  }

  private assertUniqueIds(sessions: readonly GlobalSessionSummary[]) {
    const seen = new Set<string>();
    for (const session of sessions) {
      if (seen.has(session.id)) throw new Error(`Session ID collision detected: ${session.id}`);
      seen.add(session.id);
    }
  }

  private rebuildIndexes() {
    const byId = new Map<string, GlobalSessionSummary>();
    const byProject = new Map<string, GlobalSessionSummary[]>();
    for (const session of this.sessions) {
      byId.set(session.id, session);
      const projectKey = session.projectPath ?? session.workspacePath;
      const projectSessions = byProject.get(projectKey) ?? [];
      projectSessions.push(session);
      byProject.set(projectKey, projectSessions);
      if (session.managedWorktree)
        this.managedWorktrees.set(session.workspacePath, session.managedWorktree);
    }
    this.indexedById = byId;
    this.indexedByProject = byProject;
  }
}

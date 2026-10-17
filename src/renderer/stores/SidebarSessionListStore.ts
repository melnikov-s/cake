import { Store, observable, snapshot, untracked } from "r-state-tree";
import type { CakeChatCatalogQuery } from "../../contracts/cake-chats/cake-chat-data";
import type { ProjectSessionCatalogQuery } from "../../contracts/project-sessions/project-session-data";
import { compareSessionSummariesForSidebar } from "../../utils/session-summary-order";
import { isActiveSessionActivity } from "../lib/session-activity";
import type { CakeChatCollectionStore } from "./CakeChatCollectionStore";
import { ProjectCatalogContext } from "./context/ProjectCatalogContext";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import { SessionMetadataContext } from "./context/SessionMetadataContext";

type ProjectSession = ReturnType<SessionCatalogStore["projectSessions"]>[number];

interface FamilyActivity {
  modifiedAt: string;
  active: boolean;
}

/** Owns sidebar session ordering, family presentation, pagination, and catalog demand. */
export class SidebarSessionListStore extends Store<{
  catalog: SessionCatalogStore;
  cakeChat(): CakeChatCollectionStore;
  selectedConversation?(): { kind: "project-session" | "cake-chat"; sessionId: string } | undefined;
}> {
  private get projects() {
    return ProjectCatalogContext.consume(this)!;
  }

  private get metadata() {
    return SessionMetadataContext.consume(this)!;
  }

  @snapshot private readonly projectSessionSorts: Record<string, "date" | "label"> = observable({});
  @snapshot private readonly expandedActiveGroups: Record<string, boolean> = observable({
    "cake-chat": true,
  });
  private readonly expandedResolvedGroups: Record<string, boolean> = observable({});
  private readonly activatedResolvedCakeChatCatalogs: Record<string, boolean> = observable({});
  private readonly sessionLimits: Record<string, number> = observable({});
  @snapshot private readonly collapsedFamilies: Record<string, boolean> = observable({});
  /**
   * Freeze recency only for running/waiting rows (whole families stay parent-first).
   * Entry uses the existing date/label lanes; completion immediately rejoins live recency.
   * Persist anchors with window presentation so catalog refreshes/remounts cannot reshuffle work.
   */
  @snapshot private readonly activeSortTimes: Record<string, string> = observable({});
  resolvedLaneExpanded = false;

  constructor(props: SidebarSessionListStore["props"]) {
    super(props);
    this.reaction(
      () => this.sortEntries(),
      (entries) => this.syncActiveSortTimes(entries),
    );
    // Context is available only once this Store is attached to its ownership tree.
    this.effect(() => {
      untracked(() => this.syncActiveSortTimes(this.sortEntries()));
    });
  }

  projectSessionSort(path: string): "date" | "label" {
    return this.projectSessionSorts[path] ?? "date";
  }

  setProjectSessionSort(path: string, sort: "date" | "label") {
    this.projectSessionSorts[path] = sort;
  }

  get activeProjectSessionFamilies() {
    const sessions = this.props.catalog.sessions.filter((session) => !session.resolved);
    const byId = new Map(sessions.map((session) => [session.sessionId, session]));
    const roots = sessions.filter(
      (session) =>
        !session.familyParentSessionId ||
        session.familyParentSessionId === session.sessionId ||
        !byId.has(session.familyParentSessionId),
    );
    const latestActivity = (session: ProjectSession) =>
      this.sortTime("project", session.sessionId, this.familyActivity(session, byId).modifiedAt);
    const flatten = (session: (typeof sessions)[number]): Array<(typeof sessions)[number]> => {
      if (!session.familyChildSessionIds?.length || this.isFamilyCollapsed(session.sessionId))
        return [session];
      const children = session.familyChildSessionIds
        .flatMap((id) => (byId.get(id) ? [byId.get(id)!] : []))
        .sort((left, right) => (left.familyChildOrder ?? 0) - (right.familyChildOrder ?? 0));
      return [session, ...children.flatMap(flatten)];
    };
    return roots
      .map((root) => ({
        rootSessionId: root.sessionId,
        latestModifiedAt: latestActivity(root),
        sessions: flatten(root),
      }))
      .sort(
        (left, right) =>
          right.latestModifiedAt.localeCompare(left.latestModifiedAt) ||
          left.rootSessionId.localeCompare(right.rootSessionId),
      );
  }

  get activeCakeChatSessions() {
    return this.props
      .cakeChat()
      .summaries.filter(
        (session) =>
          !session.resolved && session.projectPath !== undefined && session.messageCount > 0,
      )
      .map((session) => ({
        ...session,
        modifiedAt: this.sortTime("cake-chat", session.sessionId, session.modifiedAt),
      }))
      .sort(
        (left, right) =>
          right.modifiedAt.localeCompare(left.modifiedAt) ||
          left.sessionId.localeCompare(right.sessionId),
      );
  }

  projectSessions(projectPath: string, resolved = false, includeCollapsed = false) {
    const { byId, roots } = this.sortedProjectSessionRoots(projectPath, resolved);
    return this.flattenProjectSessionRoots(byId, roots, includeCollapsed);
  }

  visibleProjectSessions(projectPath: string, resolved = false) {
    const { byId, roots } = this.sortedProjectSessionRoots(projectPath, resolved);
    const visibleRoots = roots.slice(0, this.sessionLimit(projectPath, resolved));
    return this.flattenProjectSessionRoots(byId, visibleRoots);
  }

  /** Canonical sidebar order within the navigation scope, independent of pagination or collapse. */
  adjacentActiveSession(direction: "next" | "previous", projectPath?: string) {
    const projectPaths = projectPath ? [projectPath] : this.projects.orderedProjectPaths;
    const conversations = [
      ...(projectPath ? [] : this.cakeChatSessions()).map((session) => ({
        kind: "cake-chat" as const,
        sessionId: session.sessionId,
        active: this.props.cakeChat().registry.find(session.sessionId)?.streaming === true,
      })),
      ...projectPaths.flatMap((path) => {
        const { byId, roots } = this.sortedProjectSessionRoots(path, false);
        return this.flattenProjectSessionRoots(byId, roots, true).map((session) => ({
          kind: "project-session" as const,
          sessionId: session.sessionId,
          active: isActiveSessionActivity(this.metadata.sessionActivity(session.sessionId)),
        }));
      }),
    ];
    const selected = this.props.selectedConversation?.();
    const currentIndex = conversations.findIndex(
      (conversation) =>
        conversation.kind === selected?.kind && conversation.sessionId === selected.sessionId,
    );
    const step = direction === "next" ? 1 : -1;
    const start = currentIndex >= 0 ? currentIndex : direction === "next" ? -1 : 0;
    for (let offset = 1; offset <= conversations.length; offset++) {
      const index = (start + step * offset + conversations.length) % conversations.length;
      const conversation = conversations[index]!;
      if (index !== currentIndex && conversation.active)
        return { kind: conversation.kind, sessionId: conversation.sessionId };
    }
    return undefined;
  }

  isFamilyCollapsed(parentSessionId: string) {
    return this.collapsedFamilies[parentSessionId] === true;
  }

  toggleFamilyCollapsed(parentSessionId: string) {
    this.collapsedFamilies[parentSessionId] = !this.isFamilyCollapsed(parentSessionId);
  }

  cakeChatSessions(resolved = false) {
    const sessions = this.props
      .cakeChat()
      .summaries.filter((session) => session.resolved === resolved);
    return sessions.sort(
      (left, right) =>
        compareSessionSummariesForSidebar(
          { ...left, modifiedAt: this.sortTime("cake-chat", left.sessionId, left.modifiedAt) },
          { ...right, modifiedAt: this.sortTime("cake-chat", right.sessionId, right.modifiedAt) },
        ) || left.sessionId.localeCompare(right.sessionId),
    );
  }

  hasMoreResolvedProjectSessions(projectPath: string) {
    return (
      this.props.catalog.hasMoreResolvedSessions(projectPath) ||
      this.sortedProjectSessionRoots(projectPath, true).roots.length >
        this.sessionLimit(projectPath, true)
    );
  }

  get hasMoreResolvedCakeChatSessions() {
    return this.props.cakeChat().hasMoreResolvedSessions;
  }

  sessionLimit(groupKey: string, resolved = false) {
    return this.sessionLimits[this.limitKey(groupKey, resolved)] ?? 10;
  }

  showMoreSessions(groupKey: string, resolved = false) {
    const key = this.limitKey(groupKey, resolved);
    this.sessionLimits[key] = this.sessionLimit(groupKey, resolved) + 10;
  }

  sessionActivityForDisplay(session: {
    sessionId: string;
    familyChildSessionIds?: readonly string[];
  }) {
    const own = this.metadata.sessionActivity(session.sessionId);
    if (!session.familyChildSessionIds || !this.isFamilyCollapsed(session.sessionId)) return own;
    const descendants = (sessionIds: readonly string[]): string[] =>
      sessionIds.flatMap((id) => {
        const child = this.props.catalog.find(id);
        return [id, ...descendants(child?.familyChildSessionIds ?? [])];
      });
    const activities = [
      own,
      ...descendants(session.familyChildSessionIds).map((id) => this.metadata.sessionActivity(id)),
    ];
    if (activities.includes("waiting")) return "waiting";
    if (activities.includes("running")) return "running";
    if (activities.includes("error")) return "error";
    if (activities.includes("unread")) return "unread";
    if (activities.includes("stopped")) return "stopped";
    return undefined;
  }

  isActiveGroupExpanded(groupKey: string) {
    return this.expandedActiveGroups[groupKey] !== false;
  }

  expandActiveGroup(groupKey: string) {
    this.expandedActiveGroups[groupKey] = true;
  }

  toggleActiveGroupExpanded(groupKey: string) {
    this.expandedActiveGroups[groupKey] = !this.isActiveGroupExpanded(groupKey);
  }

  isResolvedGroupExpanded(groupKey: string) {
    return this.expandedResolvedGroups[groupKey] === true;
  }

  toggleResolvedGroupExpanded(groupKey: string) {
    const expanded = !this.isResolvedGroupExpanded(groupKey);
    this.expandedResolvedGroups[groupKey] = expanded;
    if (expanded && groupKey === "cake-chat")
      this.activatedResolvedCakeChatCatalogs[groupKey] = true;
  }

  toggleResolvedLane() {
    this.resolvedLaneExpanded = !this.resolvedLaneExpanded;
  }

  get projectSessionCatalogQueries(): ReadonlyArray<ProjectSessionCatalogQuery> {
    return this.projects.orderedProjectPaths.flatMap((projectPath) => [
      { projectPath, resolved: false },
      { projectPath, resolved: true },
    ]);
  }

  get cakeChatCatalogQueries(): ReadonlyArray<CakeChatCatalogQuery> {
    return this.activatedResolvedCakeChatCatalogs["cake-chat"]
      ? [{ resolved: false }, { resolved: true, limit: this.sessionLimit("cake-chat", true) }]
      : [{ resolved: false }];
  }

  private flattenProjectSessionRoots(
    byId: ReturnType<SidebarSessionListStore["sortedProjectSessionRoots"]>["byId"],
    roots: ReturnType<SidebarSessionListStore["sortedProjectSessionRoots"]>["roots"],
    includeCollapsed = false,
  ) {
    const flatten = (session: (typeof roots)[number]): Array<(typeof roots)[number]> => {
      if (
        !session.familyChildSessionIds?.length ||
        (!includeCollapsed && this.isFamilyCollapsed(session.sessionId))
      )
        return [session];
      const children = session.familyChildSessionIds
        .flatMap((id) => (byId.get(id) ? [byId.get(id)!] : []))
        .sort((left, right) => (left.familyChildOrder ?? 0) - (right.familyChildOrder ?? 0));
      return [session, ...children.flatMap(flatten)];
    };
    return roots.flatMap(flatten);
  }

  private sortedProjectSessionRoots(projectPath: string, resolved: boolean) {
    const sessions = this.props.catalog
      .projectSessions(projectPath)
      .filter((item) => item.resolved === resolved);
    const byId = new Map(sessions.map((session) => [session.sessionId, session]));
    const roots = sessions.filter(
      (session) =>
        !session.familyParentSessionId ||
        session.familyParentSessionId === session.sessionId ||
        !byId.has(session.familyParentSessionId),
    );
    const latestActivity = (session: ProjectSession) =>
      this.sortTime("project", session.sessionId, this.familyActivity(session, byId).modifiedAt);
    const compareByDate = (left: (typeof roots)[number], right: (typeof roots)[number]) =>
      compareSessionSummariesForSidebar(
        { modifiedAt: latestActivity(left), draft: left.draft },
        { modifiedAt: latestActivity(right), draft: right.draft },
      ) || left.sessionId.localeCompare(right.sessionId);
    roots.sort((left, right) => {
      if (this.projectSessionSort(projectPath) === "date") return compareByDate(left, right);
      const labelOrder = new Map(
        this.metadata.projectLabels(projectPath).map((label, index) => [label.id, index]),
      );
      const leftOrder =
        labelOrder.get(this.metadata.sessionLabelIds(left.sessionId)[0] ?? "") ?? Infinity;
      const rightOrder =
        labelOrder.get(this.metadata.sessionLabelIds(right.sessionId)[0] ?? "") ?? Infinity;
      return leftOrder - rightOrder || compareByDate(left, right);
    });
    return { byId, roots };
  }

  private familyActivity(
    session: ProjectSession,
    byId: ReadonlyMap<string, ProjectSession>,
  ): FamilyActivity {
    let modifiedAt = session.modifiedAt;
    let active = this.metadata.activeSessionIds.has(session.sessionId);
    for (const id of session.familyChildSessionIds ?? []) {
      const child = byId.get(id);
      if (!child) continue;
      const activity = this.familyActivity(child, byId);
      if (activity.modifiedAt > modifiedAt) modifiedAt = activity.modifiedAt;
      active ||= activity.active;
    }
    return { modifiedAt, active };
  }

  private sortEntries() {
    const sessions = this.props.catalog.sessions;
    const byId = new Map(sessions.map((session) => [session.sessionId, session]));
    return [
      ...sessions.map((session) => ({
        key: `project:${session.sessionId}`,
        ...this.familyActivity(session, byId),
      })),
      ...this.props.cakeChat().summaries.map((session) => ({
        key: `cake-chat:${session.sessionId}`,
        modifiedAt: session.modifiedAt,
        active: isActiveSessionActivity(this.props.cakeChat().activityFor(session.sessionId)),
      })),
    ];
  }

  private syncActiveSortTimes(
    entries: ReadonlyArray<{ key: string; modifiedAt: string; active: boolean }>,
  ) {
    // An absent record may simply not have arrived in a refreshed catalog yet.
    for (const entry of entries) {
      if (entry.active) this.activeSortTimes[entry.key] ??= entry.modifiedAt;
      else delete this.activeSortTimes[entry.key];
    }
  }

  private sortTime(kind: "project" | "cake-chat", sessionId: string, modifiedAt: string) {
    return this.activeSortTimes[`${kind}:${sessionId}`] ?? modifiedAt;
  }

  private limitKey(groupKey: string, resolved: boolean) {
    return `${resolved ? "resolved" : "active"}:${groupKey}`;
  }
}

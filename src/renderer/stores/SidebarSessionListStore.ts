import { Store, computed, observable, snapshot, type ReadonlySignal } from "r-state-tree";
import type { CakeChatCatalogQuery } from "../../contracts/cake-chats/cake-chat-data";
import type { ProjectSessionCatalogQuery } from "../../contracts/project-sessions/project-session-data";
import {
  compareSessionPurposes,
  compareSessionSummariesByCreation,
  compareSessionSummariesForSidebar,
} from "../../utils/session-summary-order";
import {
  isActiveSessionActivity,
  mostUrgentSessionActivity,
  sessionActivityWithInheritedWorking,
} from "../lib/session-activity";
import { sessionKind, type SessionKind } from "../lib/session-kind";
import type { CakeChatCollectionStore } from "./CakeChatCollectionStore";
import { ProjectCatalogContext } from "./context/ProjectCatalogContext";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import { WorkspaceNavigatorContext } from "./context/WorkspaceNavigatorContext";
import { SessionMetadataContext } from "./context/SessionMetadataContext";

type ProjectSession = ReturnType<SessionCatalogStore["projectSessions"]>[number];

interface ProjectSessionRoots {
  byId: ReadonlyMap<string, ProjectSession>;
  roots: ProjectSession[];
}

/** Owns sidebar session ordering, family presentation, pagination, and catalog demand. */
export class SidebarSessionListStore extends Store<{
  catalog: SessionCatalogStore;
  cakeChat(): CakeChatCollectionStore;
  additionalCatalogDemand?(): boolean;
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
  /** Per Project and kind, remembered like Resolved sessions; kind groups start expanded. */
  private readonly collapsedSessionKindGroups: Record<string, boolean> = observable({});
  private readonly activatedResolvedCakeChatCatalogs: Record<string, boolean> = observable({});
  private readonly sessionLimits: Record<string, number> = observable({});
  @snapshot private readonly collapsedFamilies: Record<string, boolean> = observable({});
  resolvedLaneExpanded = false;
  private readonly orderedProjectGroups = new Map<string, ReadonlySignal<ProjectSessionRoots>>();
  /** The selected row's root keeps the rank and last-updated time it had when selected, so the row never moves under the user. */
  private heldRoot: { sessionId: string; rank: number; modifiedAt: string } | undefined;

  constructor(props: SidebarSessionListStore["props"]) {
    super(props);
    // Reveal a newly selected session, whatever opened it (click, link, control).
    // Tracks selection, Project and family structure, never collapse state, so collapsing
    // the selected session's Project or parent afterwards still sticks.
    this.reaction(
      () => this.selectedSessionAncestorKey(),
      () => this.revealSelectedSession(),
    );
    this.reaction(
      () => this.selectedActiveRootId(),
      (sessionId) => {
        const root = sessionId ? this.props.catalog.find(sessionId) : undefined;
        this.heldRoot = root
          ? {
              sessionId: root.sessionId,
              rank: this.activityRank(root),
              modifiedAt: root.modifiedAt,
            }
          : undefined;
      },
    );
  }

  projectSessionSort(path: string): "date" | "label" {
    return this.projectSessionSorts[path] ?? "date";
  }

  setProjectSessionSort(path: string, sort: "date" | "label") {
    this.projectSessionSorts[path] = sort;
  }

  @computed
  get activeProjectSessionFamilies() {
    const sessions = this.props.catalog.activeSessions;
    const byId = new Map(sessions.map((session) => [session.sessionId, session]));
    const roots = sessions.filter(
      (session) =>
        !session.familyParentSessionId ||
        session.familyParentSessionId === session.sessionId ||
        !byId.has(session.familyParentSessionId),
    );
    const flatten = (session: (typeof sessions)[number]): Array<(typeof sessions)[number]> => {
      if (!session.familyChildSessionIds?.length || this.isFamilyCollapsed(session.sessionId))
        return [session];
      const children = session.familyChildSessionIds
        .flatMap((id) => (byId.get(id) ? [byId.get(id)!] : []))
        .sort((left, right) => (left.familyChildOrder ?? 0) - (right.familyChildOrder ?? 0));
      return [session, ...children.flatMap(flatten)];
    };
    return roots.sort(compareSessionSummariesByCreation).map((root) => ({
      rootSessionId: root.sessionId,
      createdAt: root.createdAt,
      sessions: flatten(root),
    }));
  }

  get activeCakeChatSessions() {
    return this.props
      .cakeChat()
      .summaries.filter(
        (session) =>
          !session.resolved && session.projectPath !== undefined && session.messageCount > 0,
      )
      .sort(compareSessionSummariesByCreation);
  }

  projectSessions(projectPath: string, resolved = false, includeCollapsed = false) {
    const { byId, roots } = this.sortedProjectSessionRoots(projectPath, resolved);
    return this.flattenProjectSessionRoots(byId, roots, includeCollapsed);
  }

  visibleProjectSessions(projectPath: string, resolved = false) {
    const { byId } = this.sortedProjectSessionRoots(projectPath, resolved);
    const visibleRoots = this.pagedProjectSessionRoots(projectPath, resolved).slice(
      0,
      this.sessionLimit(projectPath, resolved),
    );
    return this.flattenProjectSessionRoots(byId, visibleRoots);
  }

  hasMoreActiveProjectSessions(projectPath: string) {
    return (
      this.pagedProjectSessionRoots(projectPath, false).length > this.sessionLimit(projectPath)
    );
  }

  /** Collapsed kind groups do not spend the shared page on hidden rows. */
  private pagedProjectSessionRoots(projectPath: string, resolved: boolean) {
    const { roots } = this.sortedProjectSessionRoots(projectPath, resolved);
    return resolved
      ? roots
      : roots.filter((root) => this.isSessionKindGroupExpanded(projectPath, sessionKind(root)));
  }

  /** Active sessions per kind, including family children; independent of disclosure or paging. */
  activeSessionKindCounts(projectPath: string) {
    const counts = { user: 0, delegated: 0 } satisfies Record<SessionKind, number>;
    for (const session of this.props.catalog.projectSessions(projectPath, false))
      counts[sessionKind(session)] += 1;
    return counts;
  }

  /** Kind headers appear only when both kinds are active; a single kind lists directly. */
  showsSessionKindGroups(projectPath: string) {
    const counts = this.activeSessionKindCounts(projectPath);
    return counts.user > 0 && counts.delegated > 0;
  }

  isSessionKindGroupExpanded(projectPath: string, kind: SessionKind) {
    return (
      !this.collapsedSessionKindGroups[this.sessionKindGroupKey(projectPath, kind)] ||
      !this.showsSessionKindGroups(projectPath)
    );
  }

  toggleSessionKindGroupExpanded(projectPath: string, kind: SessionKind) {
    this.collapsedSessionKindGroups[this.sessionKindGroupKey(projectPath, kind)] =
      this.isSessionKindGroupExpanded(projectPath, kind);
  }

  /** What a collapsed kind header must still surface from its hidden rows. */
  sessionKindGroupActivity(projectPath: string, kind: SessionKind) {
    return mostUrgentSessionActivity(
      this.props.catalog
        .projectSessions(projectPath, false)
        .filter((session) => sessionKind(session) === kind)
        .map((session) => this.metadata.sessionActivity(session.sessionId)),
    );
  }

  private sessionKindGroupKey(projectPath: string, kind: SessionKind) {
    return `${projectPath}\n${kind}`;
  }

  /** Canonical conversation order across projects, independent of pagination or collapse. */
  adjacentActiveSession(direction: "next" | "previous") {
    const projectPaths = this.projects.orderedProjectPaths;
    const conversations = [
      ...this.cakeChatSessions().map((session) => ({
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
    // Cold running identities remain keyboard-navigable without opening the list.
    const knownIds = new Set(conversations.map((conversation) => conversation.sessionId));
    conversations.push(
      ...this.props.catalog.backgroundSessions
        .filter((session) => !knownIds.has(session.sessionId))
        .map((session) => ({
          kind: "project-session" as const,
          sessionId: session.sessionId,
          active: isActiveSessionActivity(this.metadata.sessionActivity(session.sessionId)),
        })),
    );
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

  /** Expands the active Project group and each collapsed ancestor as manual expands would, so they persist. */
  private revealSelectedSession() {
    const selected = this.props.selectedConversation?.();
    if (selected?.kind !== "project-session") return;
    const session = this.props.catalog.find(selected.sessionId);
    if (session && !session.resolved) {
      this.expandActiveGroup(session.projectPath);
      delete this.collapsedSessionKindGroups[
        this.sessionKindGroupKey(session.projectPath, sessionKind(session))
      ];
    }
    for (const ancestorId of this.sidebarAncestorIds(selected.sessionId))
      delete this.collapsedFamilies[ancestorId];
  }

  private selectedSessionAncestorKey() {
    const selected = this.props.selectedConversation?.();
    if (selected?.kind !== "project-session") return undefined;
    const session = this.props.catalog.find(selected.sessionId);
    return [
      selected.sessionId,
      session?.projectPath,
      session?.resolved,
      sessionKind(session),
      // Returning kind headers reveal the selection instead of hiding it in a remembered collapse.
      session && this.showsSessionKindGroups(session.projectPath),
      ...this.sidebarAncestorIds(selected.sessionId),
    ].join("\n");
  }

  /** The active-lane root whose position decides where the selected row appears. */
  private selectedActiveRootId() {
    const selected = this.props.selectedConversation?.();
    if (selected?.kind !== "project-session") return undefined;
    const session = this.props.catalog.find(selected.sessionId);
    if (!session || session.resolved) return undefined;
    return this.sidebarAncestorIds(selected.sessionId).at(-1) ?? selected.sessionId;
  }

  /** Parents that nest this session in the sidebar: same Project and lane, else it is a root. */
  private sidebarAncestorIds(sessionId: string) {
    const ancestors: string[] = [];
    let session = this.props.catalog.find(sessionId);
    while (session?.familyParentSessionId && session.familyParentSessionId !== session.sessionId) {
      const parent = this.props.catalog.find(session.familyParentSessionId);
      if (
        !parent ||
        parent.projectPath !== session.projectPath ||
        parent.resolved !== session.resolved ||
        parent.sessionId === sessionId ||
        ancestors.includes(parent.sessionId)
      )
        break;
      ancestors.push(parent.sessionId);
      session = parent;
    }
    return ancestors;
  }

  cakeChatSessions(resolved = false) {
    const sessions = this.props
      .cakeChat()
      .summaries.filter((session) => session.resolved === resolved);
    if (!resolved) return sessions.sort(compareSessionSummariesByCreation);
    return sessions.sort(
      (left, right) =>
        compareSessionSummariesForSidebar(
          {
            ...left,
            working: isActiveSessionActivity(this.props.cakeChat().activityFor(left.sessionId)),
          },
          {
            ...right,
            working: isActiveSessionActivity(this.props.cakeChat().activityFor(right.sessionId)),
          },
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
    return sessionActivityWithInheritedWorking(
      this.metadata.sessionActivity(session.sessionId),
      this.sessionsWorking([session]),
    );
  }

  /** Like unread, settled failure attention belongs to Project Chat and family roots. */
  projectHasError(projectPath: string) {
    if (
      this.props.catalog.backgroundSessions
        .filter((session) => session.projectPath === projectPath)
        .some(
          (session) =>
            (!session.familyParentSessionId ||
              session.familyParentSessionId === session.sessionId) &&
            this.metadata.sessionActivity(session.sessionId) === "error",
        )
    )
      return true;
    const chats = this.props.cakeChat();
    const home = chats.projectChat(projectPath);
    // Never open an unobserved chat just to calculate a rail dot.
    return Boolean(
      home &&
      !home.resolved &&
      chats.registry.find(home.sessionId) &&
      chats.ownActivityFor(home.sessionId) === "error",
    );
  }

  projectActivityForDisplay(projectPath: string) {
    const projectChat = this.props.cakeChat().projectChat(projectPath);
    const own = projectChat
      ? this.props.cakeChat().ownActivityFor(projectChat.sessionId)
      : undefined;
    return sessionActivityWithInheritedWorking(
      own,
      this.sessionsWorking(
        this.props.catalog.backgroundSessions.filter(
          (session) => session.projectPath === projectPath,
        ),
      ),
    );
  }

  /** Disclosure never changes activity; only active work crosses ownership boundaries. */
  private sessionsWorking(
    sessions: ReadonlyArray<{ sessionId: string; familyChildSessionIds?: readonly string[] }>,
  ): boolean {
    const visited = new Set<string>();
    const visit = (session: (typeof sessions)[number]): boolean => {
      if (visited.has(session.sessionId)) return false;
      visited.add(session.sessionId);
      if (isActiveSessionActivity(this.metadata.sessionActivity(session.sessionId))) return true;
      return (session.familyChildSessionIds ?? []).some((id) =>
        visit(this.props.catalog.backgroundSession(id) ?? { sessionId: id }),
      );
    };
    return sessions.some(visit);
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
    const navigator = WorkspaceNavigatorContext.consume(this);
    const searchDemand = this.props.additionalCatalogDemand?.() ?? false;
    if (
      !searchDemand &&
      navigator &&
      (!navigator.visible || navigator.showingWidget || navigator.mode !== "sessions")
    )
      return [];
    const scoped = !searchDemand ? navigator?.projectPath : undefined;
    const paths = scoped ? [scoped] : this.projects.orderedProjectPaths;
    return paths.flatMap((projectPath) => [
      { projectPath, resolved: false },
      // The shown Project's archive page also supplies the collapsed Resolved count.
      ...(projectPath === scoped || this.isResolvedGroupExpanded(projectPath)
        ? [{ projectPath, resolved: true, limit: this.sessionLimit(projectPath, true) }]
        : []),
    ]);
  }

  get cakeChatCatalogQueries(): ReadonlyArray<CakeChatCatalogQuery> {
    const navigator = WorkspaceNavigatorContext.consume(this);
    const visible =
      !navigator ||
      (navigator.visible && !navigator.showingWidget && navigator.mode === "sessions");
    // Active permanent-chat summaries also serve Project Chat/to-do ownership and rail attention.
    // Only their archive lane is a list-only observation.
    return visible && this.activatedResolvedCakeChatCatalogs["cake-chat"]
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
    return roots.flatMap(flatten).sort(compareSessionPurposes);
  }

  private sortedProjectSessionRoots(projectPath: string, resolved: boolean): ProjectSessionRoots {
    const key = `${resolved ? "resolved" : "active"}:${projectPath}`;
    let group = this.orderedProjectGroups.get(key);
    if (!group) {
      group = computed(() => this.orderProjectSessionRoots(projectPath, resolved));
      this.orderedProjectGroups.set(key, group);
    }
    return group.value;
  }

  private orderProjectSessionRoots(projectPath: string, resolved: boolean): ProjectSessionRoots {
    const sessions = this.props.catalog.projectSessions(projectPath, resolved);
    const byId = new Map(sessions.map((session) => [session.sessionId, session]));
    const roots = sessions.filter(
      (session) =>
        !session.familyParentSessionId ||
        session.familyParentSessionId === session.sessionId ||
        !byId.has(session.familyParentSessionId),
    );
    // Only working state crosses family boundaries; unread rank belongs to the root.
    const held = this.heldRoot;
    const activityPriorities = new Map(
      roots.map((session) => [
        session.sessionId,
        resolved
          ? 2
          : held?.sessionId === session.sessionId
            ? held.rank
            : this.activityRank(session),
      ]),
    );
    const latestActivity = (session: ProjectSession) =>
      !resolved && held?.sessionId === session.sessionId ? held.modifiedAt : session.modifiedAt;
    // Running rows keep creation order; other groups use each root's own update,
    // never a descendant's completion or unread message.
    const compareByDate = (left: (typeof roots)[number], right: (typeof roots)[number]) =>
      activityPriorities.get(left.sessionId) === 1
        ? compareSessionSummariesByCreation(left, right)
        : compareSessionSummariesForSidebar(
            { modifiedAt: latestActivity(left), draft: left.draft },
            { modifiedAt: latestActivity(right), draft: right.draft },
          ) || compareSessionSummariesByCreation(left, right);
    const labelOrder =
      this.projectSessionSort(projectPath) === "label"
        ? new Map(this.metadata.projectLabels(projectPath).map((label, index) => [label.id, index]))
        : undefined;
    roots.sort((left, right) => {
      const purposeOrder = compareSessionPurposes(left, right);
      if (purposeOrder) return purposeOrder;
      const activityOrder =
        activityPriorities.get(left.sessionId)! - activityPriorities.get(right.sessionId)!;
      if (activityOrder) return activityOrder;
      if (!labelOrder) return compareByDate(left, right);
      const leftOrder =
        labelOrder.get(this.metadata.sessionLabelIds(left.sessionId)[0] ?? "") ?? Infinity;
      const rightOrder =
        labelOrder.get(this.metadata.sessionLabelIds(right.sessionId)[0] ?? "") ?? Infinity;
      return leftOrder - rightOrder || compareByDate(left, right);
    });
    return { byId, roots };
  }

  /** Green unread rows lead, then working rows (including unread ones), then the rest. */
  private activityRank(session: ProjectSession) {
    const activity = this.sessionActivityForDisplay(session);
    return activity === "unread" ? 0 : isActiveSessionActivity(activity) ? 1 : 2;
  }

  private limitKey(groupKey: string, resolved: boolean) {
    return `${resolved ? "resolved" : "active"}:${groupKey}`;
  }
}

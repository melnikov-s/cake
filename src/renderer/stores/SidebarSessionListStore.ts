import { Store, computed, observable, snapshot, type ReadonlySignal } from "r-state-tree";
import type { CakeChatCatalogQuery } from "../../contracts/cake-chats/cake-chat-data";
import type { ProjectSessionCatalogQuery } from "../../contracts/project-sessions/project-session-data";
import {
  compareSessionSummariesByCreation,
  compareSessionSummariesForSidebar,
} from "../../utils/session-summary-order";
import { isActiveSessionActivity, type SessionActivity } from "../lib/session-activity";
import type { CakeChatCollectionStore } from "./CakeChatCollectionStore";
import { ProjectCatalogContext } from "./context/ProjectCatalogContext";
import type { SessionCatalogStore } from "./SessionCatalogStore";
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
              modifiedAt: this.familyModifiedDates(
                new Map(
                  this.props.catalog
                    .projectSessions(root.projectPath, false)
                    .map((session) => [session.sessionId, session]),
                ),
              ).get(root.sessionId)!,
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
    const { byId, roots } = this.sortedProjectSessionRoots(projectPath, resolved);
    const visibleRoots = roots.slice(0, this.sessionLimit(projectPath, resolved));
    return this.flattenProjectSessionRoots(byId, visibleRoots);
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
    if (session && !session.resolved) this.expandActiveGroup(session.projectPath);
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
    if (!session.familyChildSessionIds) return this.metadata.sessionActivity(session.sessionId);
    return this.collapsedSessionActivity([session]);
  }

  projectActivityForDisplay(projectPath: string, expanded: boolean) {
    const projectChat = this.props.cakeChat().projectChat(projectPath);
    const own = projectChat ? this.props.cakeChat().activityFor(projectChat.sessionId) : undefined;
    if (expanded) return own;
    return this.collapsedSessionActivity(
      this.props.catalog.projectSessions(projectPath, false),
      own,
    );
  }

  /** One hierarchy traversal and precedence policy for families and collapsed Projects. */
  private collapsedSessionActivity(
    sessions: ReadonlyArray<{ sessionId: string; familyChildSessionIds?: readonly string[] }>,
    own?: SessionActivity,
  ): SessionActivity | undefined {
    const activities: Array<SessionActivity | undefined> = [own];
    const visited = new Set<string>();
    const visit = (session: (typeof sessions)[number]) => {
      if (visited.has(session.sessionId)) return;
      visited.add(session.sessionId);
      activities.push(this.metadata.sessionActivity(session.sessionId));
      for (const id of session.familyChildSessionIds ?? [])
        visit(this.props.catalog.find(id) ?? { sessionId: id });
    };
    for (const session of sessions) visit(session);
    if (activities.includes("waiting")) return "waiting";
    if (activities.includes("running")) return "running";
    if (activities.includes("blocked")) return "blocked";
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
    // Rank active roots by the same child-aware activity shown on their rows:
    // unread, then running, then the rest.
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
    // A family's time is its latest update anywhere in the family.
    const modifiedDates = this.familyModifiedDates(byId);
    const latestActivity = (session: ProjectSession) =>
      !resolved && held?.sessionId === session.sessionId
        ? held.modifiedAt
        : modifiedDates.get(session.sessionId)!;
    // Running rows update constantly, so they keep creation order; every other
    // group shows the most recently updated family first.
    const compareByDate = (left: (typeof roots)[number], right: (typeof roots)[number]) =>
      activityPriorities.get(left.sessionId) === 1
        ? compareSessionSummariesByCreation(left, right)
        : compareSessionSummariesForSidebar(
            { modifiedAt: latestActivity(left), draft: left.draft },
            { modifiedAt: latestActivity(right), draft: right.draft },
          ) || compareSessionSummariesByCreation(left, right);
    roots.sort((left, right) => {
      const activityOrder =
        activityPriorities.get(left.sessionId)! - activityPriorities.get(right.sessionId)!;
      if (activityOrder) return activityOrder;
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

  /** Green unread rows lead, then working rows (including unread ones), then the rest. */
  private activityRank(session: ProjectSession) {
    const activity = this.sessionActivityForDisplay(session);
    return activity === "unread" ? 0 : isActiveSessionActivity(activity) ? 1 : 2;
  }

  private familyModifiedDates(byId: ReadonlyMap<string, ProjectSession>) {
    const dates = new Map<string, string>();
    const visit = (session: ProjectSession): string => {
      const known = dates.get(session.sessionId);
      if (known) return known;
      let modifiedAt = session.modifiedAt;
      for (const id of session.familyChildSessionIds ?? []) {
        const child = byId.get(id);
        if (!child) continue;
        const childModifiedAt = visit(child);
        if (childModifiedAt > modifiedAt) modifiedAt = childModifiedAt;
      }
      dates.set(session.sessionId, modifiedAt);
      return modifiedAt;
    };
    for (const session of byId.values()) visit(session);
    return dates;
  }

  private limitKey(groupKey: string, resolved: boolean) {
    return `${resolved ? "resolved" : "active"}:${groupKey}`;
  }
}

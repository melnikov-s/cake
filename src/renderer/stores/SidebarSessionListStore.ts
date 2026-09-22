import { Store, observable, snapshot } from "r-state-tree";
import type { CakeChatCatalogQuery } from "../../domain/cake-chats/cake-chat-data";
import type { ProjectSessionCatalogQuery } from "../../domain/project-sessions/project-session-data";
import { compareSessionSummariesForSidebar } from "../../utils/session-summary-order";
import { isActiveSessionActivity } from "../lib/session-activity";
import type { WorktreeOperationCatalog } from "../models/WorktreeOperationCatalog";
import type { CakeChatCollectionStore } from "./CakeChatCollectionStore";
import type { ProjectCatalogStore } from "./ProjectCatalogStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionMetadataStore } from "./SessionMetadataStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";

/** Owns sidebar session ordering, family presentation, pagination, and catalog demand. */
export class SidebarSessionListStore extends Store<{
  projects: ProjectCatalogStore;
  catalog: SessionCatalogStore;
  sessions: SessionRegistryStore;
  sessionMetadata: SessionMetadataStore;
  worktreeOperations?: WorktreeOperationCatalog;
  cakeChat(): CakeChatCollectionStore;
  selectedConversation?(): { kind: "project-session" | "cake-chat"; sessionId: string } | undefined;
}> {
  @snapshot private readonly projectSessionSorts: Record<string, "date" | "label"> = observable({});
  @snapshot private readonly expandedActiveGroups: Record<string, boolean> = observable({
    "cake-chat": true,
  });
  private readonly expandedResolvedGroups: Record<string, boolean> = observable({});
  private readonly activatedResolvedCakeChatCatalogs: Record<string, boolean> = observable({});
  private readonly sessionLimits: Record<string, number> = observable({});
  @snapshot private readonly collapsedFamilies: Record<string, boolean> = observable({});
  private pinnedSession:
    | {
        kind: "project-session" | "cake-chat";
        sessionId: string;
        groupKey: string;
        resolved: boolean;
        index: number;
      }
    | undefined;
  /** Prevents transcript writes from continually reordering a lane while it has active turns. */
  private readonly activeLaneOrders = observable(new Map<string, readonly string[]>());
  resolvedLaneExpanded = false;

  constructor(props: SidebarSessionListStore["props"]) {
    super(props);
    this.reaction(
      () => {
        const selected = this.props.selectedConversation?.();
        return selected ? `${selected.kind}:${selected.sessionId}` : undefined;
      },
      () => this.pinSelectedSession(),
    );
    this.reaction(
      () => this.activeLaneMemberships(),
      (memberships) => this.syncActiveLaneOrders(memberships),
    );
    this.pinSelectedSession();
    this.syncActiveLaneOrders(this.activeLaneMemberships());
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
    const latestActivity = (session: (typeof sessions)[number]): string =>
      (session.familyChildSessionIds ?? []).reduce((latest, id) => {
        const child = byId.get(id);
        if (!child) return latest;
        const childLatest = latestActivity(child);
        return childLatest > latest ? childLatest : latest;
      }, session.modifiedAt);
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
      .sort((left, right) => right.latestModifiedAt.localeCompare(left.latestModifiedAt));
  }

  get activeCakeChatSessions() {
    return this.props
      .cakeChat()
      .summaries.filter((session) => !session.resolved)
      .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  }

  projectSessions(projectPath: string, resolved = false) {
    const { byId, roots } = this.orderedProjectSessionRoots(projectPath, resolved);
    return this.flattenProjectSessionRoots(byId, roots);
  }

  visibleProjectSessions(projectPath: string, resolved = false) {
    const { byId, roots } = this.orderedProjectSessionRoots(projectPath, resolved);
    const visibleRoots = roots.slice(0, this.sessionLimit(projectPath, resolved));
    return this.flattenProjectSessionRoots(byId, visibleRoots);
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
    const pinned = this.pinnedSession;
    if (pinned?.kind !== "cake-chat" || pinned.resolved !== resolved) return sessions;
    const currentIndex = sessions.findIndex((session) => session.sessionId === pinned.sessionId);
    if (currentIndex < 0) return sessions;
    const ordered = [...sessions];
    const [selected] = ordered.splice(currentIndex, 1);
    ordered.splice(Math.min(pinned.index, ordered.length), 0, selected!);
    return ordered;
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
    const own = this.props.sessionMetadata.sessionActivity(session.sessionId);
    if (!session.familyChildSessionIds || !this.isFamilyCollapsed(session.sessionId)) return own;
    const descendants = (sessionIds: readonly string[]): string[] =>
      sessionIds.flatMap((id) => {
        const child = this.props.catalog.find(id);
        return [id, ...descendants(child?.familyChildSessionIds ?? [])];
      });
    const activities = [
      own,
      ...descendants(session.familyChildSessionIds).map((id) =>
        this.props.sessionMetadata.sessionActivity(id),
      ),
    ];
    if (activities.includes("waiting")) return "waiting";
    if (activities.includes("running")) return "running";
    if (activities.includes("error")) return "error";
    if (activities.includes("unread")) return "unread";
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
    return this.props.projects.orderedProjectPaths.flatMap((projectPath) => [
      { projectPath, resolved: false },
      { projectPath, resolved: true },
    ]);
  }

  get cakeChatCatalogQueries(): ReadonlyArray<CakeChatCatalogQuery> {
    return this.activatedResolvedCakeChatCatalogs["cake-chat"]
      ? [{ resolved: false }, { resolved: true, limit: this.sessionLimit("cake-chat", true) }]
      : [{ resolved: false }];
  }

  private orderedProjectSessionRoots(projectPath: string, resolved: boolean) {
    const { byId, roots } = this.sortedProjectSessionRoots(projectPath, resolved);
    const pinned = this.pinnedSession;
    if (
      pinned?.kind === "project-session" &&
      pinned.groupKey === projectPath &&
      pinned.resolved === resolved
    ) {
      const currentIndex = roots.findIndex((session) => session.sessionId === pinned.sessionId);
      if (currentIndex >= 0) {
        const [selected] = roots.splice(currentIndex, 1);
        roots.splice(Math.min(pinned.index, roots.length), 0, selected!);
      }
    }
    return { byId, roots };
  }

  private flattenProjectSessionRoots(
    byId: ReturnType<SidebarSessionListStore["sortedProjectSessionRoots"]>["byId"],
    roots: ReturnType<SidebarSessionListStore["sortedProjectSessionRoots"]>["roots"],
  ) {
    const flatten = (session: (typeof roots)[number]): Array<(typeof roots)[number]> => {
      if (!session.familyChildSessionIds?.length || this.isFamilyCollapsed(session.sessionId))
        return [session];
      const children = session.familyChildSessionIds
        .flatMap((id) => (byId.get(id) ? [byId.get(id)!] : []))
        .sort((left, right) => (left.familyChildOrder ?? 0) - (right.familyChildOrder ?? 0));
      return [session, ...children.flatMap(flatten)];
    };
    return roots.flatMap(flatten);
  }

  private sortedProjectSessionRoots(
    projectPath: string,
    resolved: boolean,
    preserveActiveOrder = true,
  ) {
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
    const latestActivity = (session: (typeof sessions)[number]): string =>
      (session.familyChildSessionIds ?? []).reduce((latest, id) => {
        const child = byId.get(id);
        if (!child) return latest;
        const childLatest = latestActivity(child);
        return childLatest > latest ? childLatest : latest;
      }, session.modifiedAt);
    const compareByDate = (left: (typeof roots)[number], right: (typeof roots)[number]) =>
      compareSessionSummariesForSidebar(
        { modifiedAt: latestActivity(left), draft: left.draft },
        { modifiedAt: latestActivity(right), draft: right.draft },
      );
    roots.sort((left, right) => {
      if (this.projectSessionSort(projectPath) === "date") return compareByDate(left, right);
      const labelOrder = new Map(
        this.props.sessionMetadata
          .projectLabels(projectPath)
          .map((label, index) => [label.id, index]),
      );
      const leftOrder =
        labelOrder.get(this.props.sessionMetadata.sessionLabelIds(left.sessionId)[0] ?? "") ??
        Infinity;
      const rightOrder =
        labelOrder.get(this.props.sessionMetadata.sessionLabelIds(right.sessionId)[0] ?? "") ??
        Infinity;
      return leftOrder - rightOrder || compareByDate(left, right);
    });
    const frozenOrder = preserveActiveOrder
      ? this.activeLaneOrders.get(this.laneKey(projectPath, resolved))
      : undefined;
    if (frozenOrder) {
      const frozenIds = new Set(frozenOrder);
      const rootsById = new Map(roots.map((root) => [root.sessionId, root]));
      const newlyAdded = roots.filter((root) => !frozenIds.has(root.sessionId));
      const frozen = frozenOrder.flatMap((id) => (rootsById.has(id) ? [rootsById.get(id)!] : []));
      roots.splice(0, roots.length, ...newlyAdded, ...frozen);
    }
    return { byId, roots };
  }

  private activeLaneMemberships() {
    const activeSessionIds = new Set<string>();
    for (const session of this.props.sessions.sessions ?? []) {
      if (isActiveSessionActivity(session.activity)) activeSessionIds.add(session.sessionId);
    }
    for (const operation of this.props.worktreeOperations?.operations ?? []) {
      if (operation.kind === "landing" && operation.phase === "waiting")
        activeSessionIds.add(operation.sessionId);
    }
    return [...activeSessionIds].flatMap((sessionId) => {
      const summary = this.props.catalog.find(sessionId);
      return summary
        ? [{ sessionId, projectPath: summary.projectPath, resolved: summary.resolved }]
        : [];
    });
  }

  private syncActiveLaneOrders(
    memberships: ReadonlyArray<{ sessionId: string; projectPath: string; resolved: boolean }>,
  ) {
    const activeLanes = new Map<string, { projectPath: string; resolved: boolean }>();
    for (const membership of memberships)
      activeLanes.set(this.laneKey(membership.projectPath, membership.resolved), membership);
    for (const key of this.activeLaneOrders.keys()) {
      if (!activeLanes.has(key)) this.activeLaneOrders.delete(key);
    }
    for (const [key, lane] of activeLanes) {
      if (this.activeLaneOrders.has(key)) continue;
      const { roots } = this.sortedProjectSessionRoots(lane.projectPath, lane.resolved, false);
      this.activeLaneOrders.set(
        key,
        roots.map((root) => root.sessionId),
      );
    }
  }

  private laneKey(projectPath: string, resolved: boolean) {
    return `${resolved ? "resolved" : "active"}:${projectPath}`;
  }

  private pinSelectedSession() {
    this.pinnedSession = undefined;
    const selected = this.props.selectedConversation?.();
    if (!selected) return;
    if (selected.kind === "cake-chat") {
      const summary = this.props
        .cakeChat()
        .summaries.find((session) => session.sessionId === selected.sessionId);
      if (!summary) return;
      const sessions = this.props
        .cakeChat()
        .summaries.filter((session) => session.resolved === summary.resolved);
      const index = sessions.findIndex((session) => session.sessionId === selected.sessionId);
      if (index >= 0)
        this.pinnedSession = {
          kind: selected.kind,
          sessionId: selected.sessionId,
          groupKey: "cake-chat",
          resolved: summary.resolved,
          index,
        };
      return;
    }
    const summary = this.props.catalog.find(selected.sessionId);
    if (!summary) return;
    const { byId, roots } = this.sortedProjectSessionRoots(summary.projectPath, summary.resolved);
    let rootId = summary.sessionId;
    let current = summary;
    const visited = new Set<string>();
    while (
      current.familyParentSessionId &&
      current.familyParentSessionId !== current.sessionId &&
      !visited.has(current.sessionId)
    ) {
      const parent = byId.get(current.familyParentSessionId);
      if (!parent) break;
      visited.add(current.sessionId);
      rootId = parent.sessionId;
      current = parent;
    }
    const index = roots.findIndex((session) => session.sessionId === rootId);
    if (index >= 0)
      this.pinnedSession = {
        kind: selected.kind,
        sessionId: rootId,
        groupKey: summary.projectPath,
        resolved: summary.resolved,
        index,
      };
  }

  private limitKey(groupKey: string, resolved: boolean) {
    return `${resolved ? "resolved" : "active"}:${groupKey}`;
  }
}

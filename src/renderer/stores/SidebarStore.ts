import { Store, observable, snapshot } from "r-state-tree";
import { formatRelativeSessionTime } from "../../utils/format-relative-session-time";
import { compareSessionSummariesForSidebar } from "../../utils/session-summary-order";
import type { ProjectCatalogStore } from "./ProjectCatalogStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { CakeChatCollectionStore } from "./CakeChatCollectionStore";
import { ClientContext } from "./context/ClientContext";
import type { ProjectSessionCatalogQuery } from "../../domain/project-sessions/project-session-data";
import type { CakeChatCatalogQuery } from "../../domain/cake-chats/cake-chat-data";
import type { EmbeddedEditorSettingsStore } from "./EmbeddedEditorSettingsStore";
import { isActiveSessionActivity, type SessionActivity } from "../lib/session-activity";
import type { WorktreeOperationCatalog } from "../models/WorktreeOperationCatalog";

export interface SidebarStoreProps {
  projects: ProjectCatalogStore;
  catalog: SessionCatalogStore;
  sessions: SessionRegistryStore;
  worktreeOperations?: WorktreeOperationCatalog;
  cakeChat(): CakeChatCollectionStore;
  selectedConversation?(): { kind: "project-session" | "cake-chat"; sessionId: string } | undefined;
  setSessionResolved(sessionId: string, resolved: boolean): Promise<void>;
  setSessionWorkflowStatus(sessionId: string, statusId?: string): Promise<void>;
  setCakeChatSessionResolved(sessionId: string, resolved: boolean): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  deleteCakeChatSession(sessionId: string): Promise<void>;
  setSessionUnread(sessionId: string, unread: boolean): Promise<void>;
  embeddedEditorSettings: EmbeddedEditorSettingsStore;
}

/** Owns project navigation, metadata-stream demand, and activity badges. */
export class SidebarStore extends Store<SidebarStoreProps> {
  get electron() {
    return ClientContext.consume(this)!.electron;
  }

  @snapshot hidden = false;
  @snapshot width = 292;
  /** Window-local presentation mode that narrows navigation to one Project. */
  @snapshot focusedProjectPath: string | undefined;
  private ideActive = false;
  private ideHidden: boolean | undefined;
  private ideVisibilityManuallySet = false;
  private ideViewportWidth = Number.POSITIVE_INFINITY;
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
  now = Date.now();

  constructor(props: SidebarStore["props"]) {
    super(props);
    this.effect(() => {
      const timer = setInterval(() => {
        this.now = Date.now();
      }, 60_000);
      return () => clearInterval(timer);
    });
    this.effect(() => {
      const browserWindow = globalThis.window;
      if (!browserWindow) return;
      const updateViewportWidth = () => this.updateIdeViewportWidth(browserWindow.innerWidth);
      browserWindow.addEventListener("resize", updateViewportWidth);
      return () => browserWindow.removeEventListener("resize", updateViewportWidth);
    });
    this.reaction(
      () => [
        this.props.embeddedEditorSettings.sidebarAutoHide,
        this.props.embeddedEditorSettings.sidebarAutoHideWidth,
      ],
      () => this.applyIdeAutoHide(),
    );
    this.reaction(
      () => {
        const selected = this.props.selectedConversation?.();
        return selected ? `${selected.kind}:${selected.sessionId}` : undefined;
      },
      () => this.pinSelectedSession(),
    );
    this.reaction(
      () =>
        (this.props.catalog.sessions ?? []).map((session) =>
          [
            session.sessionId,
            session.projectPath,
            session.resolved,
            session.familyParentSessionId,
            isActiveSessionActivity(this.sessionActivity(session.sessionId)),
          ].join(":"),
        ),
      () => this.syncActiveLaneOrders(),
    );
    this.pinSelectedSession();
    this.syncActiveLaneOrders();
  }

  get visible() {
    return !(this.ideActive ? (this.ideHidden ?? this.hidden) : this.hidden);
  }

  get sessions() {
    return this.props.catalog.sessions;
  }

  get focusModeProjectPath() {
    const path = this.focusedProjectPath;
    return path && this.props.projects.find(path) ? path : undefined;
  }

  focusProject(path: string) {
    if (!this.props.projects.find(path)) return;
    this.focusedProjectPath = path;
    this.expandedActiveGroups[path] = true;
  }

  leaveProjectFocus() {
    this.focusedProjectPath = undefined;
  }

  managedWorktree(workingDirectory: string) {
    return this.props.catalog.managedWorktree(workingDirectory);
  }

  toggle() {
    if (this.ideActive) {
      this.ideHidden = this.visible;
      this.ideVisibilityManuallySet = true;
      return;
    }
    this.hidden = !this.hidden;
  }

  enterIdeMode(viewportWidth = globalThis.window?.innerWidth ?? Number.POSITIVE_INFINITY) {
    if (this.ideActive) return;
    this.ideActive = true;
    this.ideViewportWidth = viewportWidth;
    this.ideVisibilityManuallySet = false;
    this.applyIdeAutoHide();
  }

  leaveIdeMode() {
    this.ideActive = false;
    this.ideHidden = undefined;
    this.ideVisibilityManuallySet = false;
  }

  updateIdeViewportWidth(width: number) {
    this.ideViewportWidth = width;
    this.applyIdeAutoHide();
  }

  private applyIdeAutoHide() {
    if (!this.ideActive || this.ideVisibilityManuallySet) return;
    const settings = this.props.embeddedEditorSettings;
    this.ideHidden =
      settings.sidebarAutoHide === "always" ||
      (settings.sidebarAutoHide === "below-width" &&
        this.ideViewportWidth < settings.sidebarAutoHideWidth)
        ? true
        : undefined;
  }

  setWidth(width: number) {
    this.width = width;
  }

  showSessionContextMenu(
    sessionId: string,
    x: number,
    y: number,
    resolved: boolean,
    unread?: boolean,
    familyChild?: boolean,
  ) {
    const session = this.props.catalog.find(sessionId);
    const workflow = session ? this.props.projects.find(session.projectPath)?.workflow : undefined;
    const assignedStatusId = workflow?.assignments.find(
      (assignment) => assignment.sessionId === sessionId,
    )?.statusId;
    const currentStatus = session?.draft
      ? "draft"
      : resolved
        ? "resolved"
        : workflow?.columns.some((status) => status.id === assignedStatusId)
          ? (assignedStatusId ?? "active")
          : "active";
    return this.electron.showSessionContextMenu({
      sessionId,
      x,
      y,
      resolved,
      draft: session?.draft === true,
      unread,
      familyChild,
      ...(workflow?.columns.length
        ? {
            workflow: {
              currentStatus,
              statuses: workflow.columns.map((status) => ({ ...status })),
            },
          }
        : undefined),
    });
  }

  setSessionWorkflowStatus(sessionId: string, statusId?: string) {
    return this.props.setSessionWorkflowStatus(sessionId, statusId);
  }

  showProjectContextMenu(path: string, x: number, y: number) {
    return this.electron.showProjectContextMenu({
      path,
      x,
      y,
      resolvedWorktreeCount: this.props.catalog.resolvedWorktrees(path).length,
    });
  }

  projectSessionCount(path: string) {
    return this.props.catalog.projectSessions(path).length;
  }

  resolvedWorktreeCount(path: string) {
    return this.props.catalog.resolvedWorktrees(path).length;
  }

  projectSessions(workspacePath: string, resolved = false) {
    const { byId, roots } = this.orderedProjectSessionRoots(workspacePath, resolved);
    return this.flattenProjectSessionRoots(byId, roots);
  }

  visibleProjectSessions(workspacePath: string, resolved = false) {
    const { byId, roots } = this.orderedProjectSessionRoots(workspacePath, resolved);
    const visibleRoots = roots.slice(0, this.sessionLimit(workspacePath, resolved));
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

  sessionWorkflowStatuses(sessionId: string) {
    const session = this.props.catalog.find(sessionId);
    const pendingSession = this.props.sessions.findSession(sessionId);
    const projectPath =
      session?.projectPath ??
      (pendingSession
        ? (this.props.catalog.projectOfManagedWorktree(pendingSession.workspacePath) ??
          pendingSession.workspacePath)
        : undefined);
    return projectPath ? (this.props.projects.find(projectPath)?.workflow.columns ?? []) : [];
  }

  sessionWorkflowStatusId(sessionId: string) {
    const pendingStatusId =
      this.props.sessions.pendingSessions.conversation(sessionId)?.workflowStatusId;
    if (this.props.sessions.pendingSessions.isTemporary(sessionId)) return pendingStatusId;
    const session = this.props.catalog.find(sessionId);
    if (!session || session.resolved) return undefined;
    const workflow = this.props.projects.find(session.projectPath)?.workflow;
    const statusId = workflow?.assignments.find(
      (assignment) => assignment.sessionId === sessionId,
    )?.statusId;
    return workflow?.columns.some((column) => column.id === statusId) ? statusId : undefined;
  }

  sessionWorkflowStatus(sessionId: string) {
    const statusId = this.sessionWorkflowStatusId(sessionId);
    return this.sessionWorkflowStatuses(sessionId).find((column) => column.id === statusId);
  }

  sessionAvatarSeed(sessionId: string) {
    return sessionId;
  }

  sessionActivity(sessionId: string): SessionActivity | undefined {
    const activity = this.props.sessions.findSession?.(sessionId)?.activity;
    if (activity) return activity;
    const waitingToMerge = this.props.worktreeOperations?.operations.some(
      (operation) =>
        operation.sessionId === sessionId &&
        operation.kind === "landing" &&
        operation.phase === "waiting",
    );
    if (waitingToMerge) return "running";
    return this.props.catalog.find(sessionId)?.unread ? "unread" : undefined;
  }

  sessionActivityForDisplay(session: {
    sessionId: string;
    familyChildSessionIds?: readonly string[];
  }) {
    const own = this.sessionActivity(session.sessionId);
    if (!session.familyChildSessionIds || !this.isFamilyCollapsed(session.sessionId)) return own;
    const activities = [
      own,
      ...session.familyChildSessionIds.map((id) => this.sessionActivity(id)),
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

  setSessionResolved(sessionId: string, resolved: boolean) {
    return this.props.setSessionResolved(sessionId, resolved);
  }

  setCakeChatSessionResolved(sessionId: string, resolved: boolean) {
    return this.props.setCakeChatSessionResolved(sessionId, resolved);
  }

  deleteSession(sessionId: string) {
    return this.props.deleteSession(sessionId);
  }

  deleteCakeChatSession(sessionId: string) {
    return this.props.deleteCakeChatSession(sessionId);
  }

  setSessionUnread(sessionId: string, unread: boolean) {
    if (!unread) this.props.sessions.findSession(sessionId)?.markRead();
    return this.props.setSessionUnread(sessionId, unread);
  }

  toggleResolvedLane() {
    this.resolvedLaneExpanded = !this.resolvedLaneExpanded;
  }

  sessionActivityTime(modified: string) {
    return formatRelativeSessionTime(modified, this.now);
  }

  private orderedProjectSessionRoots(workspacePath: string, resolved: boolean) {
    const { byId, roots } = this.sortedProjectSessionRoots(workspacePath, resolved);
    const pinned = this.pinnedSession;
    if (
      pinned?.kind === "project-session" &&
      pinned.groupKey === workspacePath &&
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
    byId: ReturnType<SidebarStore["sortedProjectSessionRoots"]>["byId"],
    roots: ReturnType<SidebarStore["sortedProjectSessionRoots"]>["roots"],
  ) {
    return roots.flatMap((root) => {
      if (!root.familyChildSessionIds || this.isFamilyCollapsed(root.sessionId)) return [root];
      const children = root.familyChildSessionIds
        .flatMap((id) => (byId.get(id) ? [byId.get(id)!] : []))
        .sort((left, right) => (left.familyChildOrder ?? 0) - (right.familyChildOrder ?? 0));
      return [root, ...children];
    });
  }

  private sortedProjectSessionRoots(
    workspacePath: string,
    resolved: boolean,
    preserveActiveOrder = true,
  ) {
    const sessions = this.props.catalog
      .projectSessions(workspacePath)
      .filter((item) => item.resolved === resolved);
    const byId = new Map(sessions.map((session) => [session.sessionId, session]));
    const roots = sessions.filter(
      (session) =>
        !session.familyParentSessionId ||
        session.familyParentSessionId === session.sessionId ||
        !byId.has(session.familyParentSessionId),
    );
    const latestActivity = (session: (typeof sessions)[number]) => {
      const members = session.familyChildSessionIds
        ? [
            session,
            ...session.familyChildSessionIds.flatMap((id) => (byId.get(id) ? [byId.get(id)!] : [])),
          ]
        : [session];
      return members.reduce(
        (latest, member) => (member.modifiedAt > latest ? member.modifiedAt : latest),
        session.modifiedAt,
      );
    };
    roots.sort((left, right) =>
      compareSessionSummariesForSidebar(
        { modifiedAt: latestActivity(left), draft: left.draft },
        { modifiedAt: latestActivity(right), draft: right.draft },
      ),
    );
    const frozenOrder = preserveActiveOrder
      ? this.activeLaneOrders.get(this.laneKey(workspacePath, resolved))
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

  private syncActiveLaneOrders() {
    const activeLanes = new Map<string, { workspacePath: string; resolved: boolean }>();
    for (const session of this.props.catalog.sessions ?? []) {
      if (!isActiveSessionActivity(this.sessionActivity(session.sessionId))) continue;
      activeLanes.set(this.laneKey(session.projectPath, session.resolved), {
        workspacePath: session.projectPath,
        resolved: session.resolved,
      });
    }
    for (const key of this.activeLaneOrders.keys()) {
      if (!activeLanes.has(key)) this.activeLaneOrders.delete(key);
    }
    for (const [key, lane] of activeLanes) {
      if (this.activeLaneOrders.has(key)) continue;
      const { roots } = this.sortedProjectSessionRoots(lane.workspacePath, lane.resolved, false);
      this.activeLaneOrders.set(
        key,
        roots.map((root) => root.sessionId),
      );
    }
  }

  private laneKey(workspacePath: string, resolved: boolean) {
    return `${resolved ? "resolved" : "active"}:${workspacePath}`;
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
    const parentId = summary.familyParentSessionId;
    const rootId =
      parentId && parentId !== summary.sessionId && byId.has(parentId)
        ? parentId
        : summary.sessionId;
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

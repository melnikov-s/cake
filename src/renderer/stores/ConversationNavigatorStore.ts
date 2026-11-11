import { Store, computed, observable, snapshot, type ReadonlySignal } from "r-state-tree";
import { subagentTitle } from "../lib/subagent-title";
import { isActiveSessionActivity } from "../lib/session-activity";
import type { RootProjection } from "../models/RootProjection";
import { conversationOwnedNavigation } from "../lib/conversation-owned-navigation";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import { ProjectCatalogContext } from "./context/ProjectCatalogContext";
import type { SidebarSessionListStore } from "./SidebarSessionListStore";
import { sessionKind, sessionKinds, type SessionKind } from "../lib/session-kind";
import type { ReviewThread } from "../models/ReviewThread";
import type { DiscussionThreadMetadata } from "../../contracts/discussion-sessions/discussion-session-data";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import {
  buildConversationNavigationTree,
  conversationNavigationKey,
  matchingConversationNavigationKeys,
  conversationNavigationTargetKey,
  type ConversationNavigationNode,
  type ConversationNavigationTarget,
  type ConversationNavigationMetadataTarget,
  type ConversationNavigationTree,
  type ConversationNavigationEntry,
} from "../lib/conversation-navigation-tree";

/** Owns Sessions disclosure/search and selection reveal, not conversation/runtime state. */
export class ConversationNavigatorStore extends Store<{
  projection: RootProjection;
  catalog: SessionCatalogStore;
  sessionList: SidebarSessionListStore;
  selected(): ConversationNavigationTarget | undefined;
  interact(target: ConversationNavigationTarget): void;
  open(target: ConversationNavigationTarget): void | Promise<void>;
}> {
  @snapshot private readonly collapsed: Record<string, boolean> = observable({});
  private readonly queries: Record<string, string> = observable({});
  private readonly searchCollapsed: Record<string, boolean> = observable({});
  private readonly trees = new Map<string, ReadonlySignal<ConversationNavigationTree>>();
  private readonly lineages = new Map<
    string,
    ReadonlySignal<readonly ConversationNavigationEntry[]>
  >();
  private readonly metadataScopes = new Map<
    string,
    ReadonlySignal<readonly ConversationNavigationMetadataTarget[]>
  >();
  error: string | undefined;

  constructor(props: ConversationNavigatorStore["props"]) {
    super(props);
    this.effect(() => {
      const keys = this.selectedAncestorKeys;
      this.revealSelection(keys);
    });
  }

  tree(projectPath: string | undefined, resolved = false): ConversationNavigationTree {
    const key = `${resolved ? "resolved" : "active"}:${this.scopeKey(projectPath)}`;
    let tree = this.trees.get(key);
    if (!tree) {
      tree = computed(() => this.buildTree(projectPath, resolved));
      this.trees.set(key, tree);
    }
    return tree.value;
  }

  private projectPaths(projectPath: string | undefined): readonly string[] {
    return projectPath === undefined
      ? ProjectCatalogContext.consume(this)!.orderedProjectPaths
      : [projectPath];
  }

  private buildTree(
    projectPath: string | undefined,
    resolved: boolean,
  ): ConversationNavigationTree {
    const model = this.props.projection;
    const tree = buildConversationNavigationTree({
      projectPath,
      projectName: projectPath ? this.projectName(projectPath) : undefined,
      sessions: projectPath
        ? this.props.sessionList.projectSessions(projectPath, resolved, true)
        : [],
      resolved,
      cakeChats: model.cakeChatCatalog.sessions,
      conversations: [
        ...model.projectConversations,
        ...model.cakeChatConversations,
        ...model.discussionConversations,
      ],
    });
    if (projectPath !== undefined) return tree;
    // Global Cake owns the all-project view; each Project keeps its existing tree and order.
    const trees = [tree, ...this.projectPaths(undefined).map((path) => this.tree(path, resolved))];
    return {
      roots: trees.flatMap((tree) => tree.roots),
      byKey: new Map(trees.flatMap((tree) => [...tree.byKey])),
      total: trees.reduce((sum, tree) => sum + tree.total, 0),
      running: trees.reduce((sum, tree) => sum + tree.running, 0),
      unread: trees.reduce((sum, tree) => sum + tree.unread, 0),
    };
  }

  /** The header menu reads only this conversation's direct ownership catalogs. */
  ownedConversations(sessionId: string) {
    const model = this.props.projection;
    return conversationOwnedNavigation(
      sessionId,
      model.discussionCatalogs.find((catalog) => catalog.sessionId === sessionId),
      model.subagentCatalogs.find((catalog) => catalog.sessionId === sessionId),
      model.discussionConversations,
    );
  }

  /** Work is recursive and independent of disclosure; unread and outcomes stay with their owner. */
  effectiveWorking(node: ConversationNavigationNode): boolean {
    if (node.running || isActiveSessionActivity(node.activity)) return true;
    if (node.children.some((child) => this.effectiveWorking(child))) return true;
    if (node.target.kind === "subagent") return false;
    return this.ownedConversations(node.target.sessionId).some((child) =>
      this.effectiveWorking(child),
    );
  }

  /** Metadata demand follows the selected scope and discovered public sidecar owners, never transcript demand. */
  metadataTargets(
    projectPath: string | undefined,
    includeClosed = false,
  ): readonly ConversationNavigationMetadataTarget[] {
    const key = `${includeClosed}:${this.scopeKey(projectPath)}`;
    let scope = this.metadataScopes.get(key);
    if (!scope) {
      let previous: readonly ConversationNavigationMetadataTarget[] = [];
      scope = computed(() => {
        const next = this.buildMetadataTargets(projectPath, includeClosed);
        if (
          next.length !== previous.length ||
          next.some((target, index) => {
            const old = previous[index];
            return (
              old?.sessionId !== target.sessionId ||
              old?.kind !== target.kind ||
              old?.workingDirectory !== target.workingDirectory
            );
          })
        )
          previous = next;
        return previous;
      });
      this.metadataScopes.set(key, scope);
    }
    return scope.value;
  }

  private buildMetadataTargets(projectPath: string | undefined, includeClosed: boolean) {
    const projection = this.props.projection;
    const targets = new Map<string, ConversationNavigationMetadataTarget>();
    if (projectPath === undefined)
      targets.set(CAKE_CHAT_SESSION_ID, {
        sessionId: CAKE_CHAT_SESSION_ID,
        workingDirectory: "",
        kind: "cake-chat",
      });
    for (const path of this.projectPaths(projectPath)) {
      const homeId = projection.cakeChatCatalog.sessions.find(
        (session) => session.projectPath === path,
      )?.sessionId;
      if (homeId)
        targets.set(homeId, {
          sessionId: homeId,
          workingDirectory: path,
          kind: "cake-chat",
        });
      for (const session of this.props.catalog.projectSessions(path)) {
        if (
          includeClosed ||
          !session.resolved ||
          this.props.sessionList.isResolvedGroupExpanded(this.scopeKey(projectPath))
        )
          targets.set(session.sessionId, {
            sessionId: session.sessionId,
            workingDirectory: session.workingDirectory,
            kind: "project-session",
          });
      }
    }
    let discovered = true;
    while (discovered) {
      discovered = false;
      for (const catalog of projection.discussionCatalogs) {
        if (!targets.has(catalog.sessionId)) continue;
        for (const thread of catalog.metadataLoaded ? catalog.metadata : catalog.threads) {
          if (
            (!includeClosed && thread.status !== "open") ||
            !thread.sidecarSessionId ||
            targets.has(thread.sidecarSessionId)
          )
            continue;
          targets.set(thread.sidecarSessionId, {
            sessionId: thread.sidecarSessionId,
            workingDirectory: thread.workingDirectory,
            kind: "side-chat",
          });
          discovered = true;
        }
      }
    }
    return [...targets.values()];
  }

  projectRunning(projectPath: string) {
    return this.props.projection.projects.runningProjectPaths.includes(projectPath);
  }

  /** Only top-level sessions' own unread counts; descendants still contribute to running. */
  projectUnread(projectPath: string) {
    return (
      this.props.catalog.backgroundSessions
        .filter((session) => session.projectPath === projectPath)
        .some(
          (session) =>
            session.unread &&
            (!session.familyParentSessionId || session.familyParentSessionId === session.sessionId),
        ) ||
      this.props.projection.cakeChatCatalog.sessions.some(
        (session) => session.projectPath === projectPath && !session.resolved && session.unread,
      )
    );
  }

  /** Tab/rail summaries do not demand the Sessions tree or list details. */
  summaryCounts(projectPath?: string) {
    if (!this.props.catalog.backgroundSignalsLoaded) return this.tree(projectPath);
    const model = this.props.projection;
    const sessions = this.props.catalog.backgroundSessions.filter(
      (session) => projectPath === undefined || session.projectPath === projectPath,
    );
    const chats = model.cakeChatCatalog.sessions.filter(
      (chat) => !chat.resolved && (projectPath === undefined || chat.projectPath === projectPath),
    );
    const live = new Map(
      [...model.projectConversations, ...model.cakeChatConversations].map((conversation) => [
        conversation.sessionId,
        conversation.streaming || conversation.activeTurnIds.length > 0,
      ]),
    );
    return {
      total:
        sessions.length +
        chats.length +
        Number(
          projectPath === undefined &&
            !chats.some((chat) => chat.sessionId === CAKE_CHAT_SESSION_ID),
        ),
      running: sessions.filter((session) => session.running || live.get(session.sessionId)).length,
      unread:
        sessions.filter(
          (session) =>
            session.unread &&
            (!session.familyParentSessionId || session.familyParentSessionId === session.sessionId),
        ).length + chats.filter((chat) => chat.unread).length,
    };
  }

  countFor(projectPath?: string) {
    return this.summaryCounts(projectPath).total;
  }

  get selectedKey(): string | undefined {
    const target = this.props.selected();
    return target ? conversationNavigationTargetKey(target) : undefined;
  }

  lineageForTarget(target: ConversationNavigationTarget): readonly ConversationNavigationEntry[] {
    const key = conversationNavigationTargetKey(target);
    let lineage = this.lineages.get(key);
    if (!lineage) {
      let previous: readonly ConversationNavigationEntry[] = [];
      lineage = computed(() => {
        const next = this.buildLineage(target);
        // Metadata arrives as replacement rows even when only activity changed.
        if (!sameLineage(previous, next)) previous = next;
        return previous;
      });
      this.lineages.set(key, lineage);
    }
    return lineage.value;
  }

  lineageFor(sessionId: string): readonly ConversationNavigationEntry[] {
    const selected = this.props.selected();
    const lineage = selected ? this.lineageForTarget(selected) : [];
    const key = conversationNavigationKey(sessionId);
    return lineage.some((node) => node.key === key)
      ? lineage
      : this.lineageForTarget({ kind: "project-session", sessionId });
  }

  /** Index ownership only; reading titles must never subscribe to other conversations' activity. */
  @computed
  private get discussionsBySidecar() {
    const records = new Map<string, ReviewThread | DiscussionThreadMetadata>();
    for (const catalog of this.props.projection.discussionCatalogs)
      for (const thread of catalog.metadataLoaded ? catalog.metadata : catalog.threads)
        if (thread.status === "open" && thread.sidecarSessionId)
          records.set(thread.sidecarSessionId, thread);
    return records;
  }

  @computed
  private get subagentsByOwner() {
    return new Map(
      this.props.projection.subagentCatalogs.map((catalog) => [catalog.sessionId, catalog]),
    );
  }

  private buildLineage(
    target: ConversationNavigationTarget,
  ): readonly ConversationNavigationEntry[] {
    if (target.kind === "subagent") {
      const catalog = this.subagentsByOwner.get(target.sessionId);
      const worker = (catalog?.metadataLoaded ? catalog.metadata : catalog?.activities)?.find(
        (worker) => worker.handleId === target.handleId,
      );
      if (!worker) return [];
      const parent = this.sessionLineage(target.sessionId);
      return parent.length
        ? [
            ...parent,
            {
              key: conversationNavigationTargetKey(target),
              title: subagentTitle(worker),
              relationship: "subagent",
              target,
            },
          ]
        : [];
    }
    return this.sessionLineage(target.sessionId);
  }

  private sessionLineage(sessionId: string): readonly ConversationNavigationEntry[] {
    const projection = this.props.projection;
    const session = this.props.catalog.find(sessionId);
    if (session) {
      const parentId = session.familyParentSessionId;
      const familyChild = Boolean(parentId && parentId !== sessionId);
      const parent = familyChild ? this.props.catalog.find(parentId!) : undefined;
      const ancestors =
        parent && parent.projectPath === session.projectPath
          ? this.sessionLineage(parent.sessionId)
          : this.homeLineage(session.projectPath);
      return [
        ...ancestors,
        {
          key: conversationNavigationKey(sessionId),
          title: session.title || "Session",
          relationship: familyChild ? "family-child" : "grouped",
          target: { kind: "project-session", sessionId },
        },
      ];
    }
    const home = projection.cakeChatCatalog.sessions.find((chat) => chat.sessionId === sessionId);
    if (home || sessionId === CAKE_CHAT_SESSION_ID) return this.homeLineage(home?.projectPath);
    const thread = this.discussionsBySidecar.get(sessionId);
    if (!thread) return [];
    const parent = this.sessionLineage(thread.parentSessionId);
    return parent.length
      ? [
          ...parent,
          {
            key: conversationNavigationKey(sessionId),
            title:
              thread.title ||
              ("anchor" in thread
                ? thread.anchor.selectedText ||
                  thread.textParts.find((part) => part.role === "user")?.text
                : undefined) ||
              "Side chat",
            relationship: "side-chat",
            target: {
              kind: "side-chat",
              sessionId,
              parentSessionId: thread.parentSessionId,
              threadId: thread.id,
            },
          },
        ]
      : [];
  }

  private projectName(projectPath: string) {
    return (
      this.props.projection.projects.find(projectPath)?.name ??
      projectPath.replace(/\/+$/, "").split("/").at(-1) ??
      projectPath
    );
  }

  private homeLineage(projectPath: string | undefined): readonly ConversationNavigationEntry[] {
    const homeId =
      projectPath === undefined
        ? CAKE_CHAT_SESSION_ID
        : this.props.projection.cakeChatCatalog.sessions.find(
            (chat) => chat.projectPath === projectPath,
          )?.sessionId;
    return homeId
      ? [
          {
            key: conversationNavigationKey(homeId),
            title: projectPath === undefined ? "Cake Chat" : this.projectName(projectPath),
            relationship: "home",
            target: { kind: "cake-chat", sessionId: homeId },
          },
        ]
      : [];
  }

  @computed
  private get selectedAncestorKeys() {
    const target = this.props.selected();
    return target
      ? this.lineageForTarget(target)
          .map((node) => node.key)
          .join("\n")
      : "";
  }

  revealSelection(ancestorKeys = this.selectedAncestorKeys) {
    for (const key of ancestorKeys.split("\n")) {
      delete this.collapsed[key];
      delete this.searchCollapsed[key];
    }
  }

  query(projectPath: string | undefined) {
    return this.queries[this.scopeKey(projectPath)] ?? "";
  }

  setQuery(projectPath: string | undefined, query: string) {
    this.queries[this.scopeKey(projectPath)] = query;
    for (const key of Object.keys(this.searchCollapsed)) delete this.searchCollapsed[key];
  }

  isExpanded(projectPath: string | undefined, key: string) {
    return !(this.query(projectPath).trim() ? this.searchCollapsed[key] : this.collapsed[key]);
  }

  toggleExpanded(projectPath: string | undefined, key: string) {
    const collapsed = this.query(projectPath).trim() ? this.searchCollapsed : this.collapsed;
    collapsed[key] = !collapsed[key];
  }

  collapseAll(projectPath: string | undefined) {
    const collapsed = this.query(projectPath).trim() ? this.searchCollapsed : this.collapsed;
    for (const node of this.tree(projectPath).byKey.values())
      if (node.children.length) collapsed[node.key] = true;
  }

  hasMoreSessions(projectPath: string | undefined, resolved = false) {
    return this.projectPaths(projectPath).some((path) => {
      const home = this.tree(path).roots.find((node) => node.relationship === "home");
      if (!resolved && home && !this.isExpanded(projectPath, home.key)) return false;
      return resolved
        ? this.props.sessionList.hasMoreResolvedProjectSessions(path)
        : this.props.sessionList.hasMoreActiveProjectSessions(path);
    });
  }

  showMoreSessions(projectPath: string | undefined, resolved = false) {
    for (const path of this.projectPaths(projectPath))
      this.props.sessionList.showMoreSessions(path, resolved);
  }

  rows(
    projectPath: string | undefined,
    resolved = false,
  ): readonly { node: ConversationNavigationNode; depth: number }[] {
    const tree = this.tree(projectPath, resolved);
    const query = this.query(projectPath);
    const matching = matchingConversationNavigationKeys(tree, query);
    const visible = !query.trim()
      ? new Set(
          this.projectPaths(projectPath).flatMap((path) =>
            this.props.sessionList
              .visibleProjectSessions(path, resolved)
              .map((session) => conversationNavigationKey(session.sessionId)),
          ),
        )
      : undefined;
    const rows: { node: ConversationNavigationNode; depth: number }[] = [];
    const visit = (node: ConversationNavigationNode, depth: number) => {
      if (!matching.has(node.key)) return;
      if (visible && node.relationship === "grouped" && !visible.has(node.key)) return;
      rows.push({ node, depth });
      if (this.isExpanded(projectPath, node.key))
        for (const child of node.children) visit(child, depth + 1);
    };
    for (const root of tree.roots) visit(root, 0);
    return rows;
  }

  /**
   * Presentation groups only; ownership, family edges and to-do order are unchanged.
   * Active kind groups get a collapsible header only when both kinds are active in the Project.
   */
  rowGroups(projectPath: string | undefined, resolved = false): readonly ConversationRowGroup[] {
    const rows = this.rows(projectPath, resolved);
    const tree = this.tree(projectPath, resolved);
    const groups: ConversationRowGroup[] = [];
    // Paging may leave an expanded kind with no rows yet; only search hides its header.
    const searching = Boolean(this.query(projectPath).trim());
    let segment: ConversationRow[] = [];
    let segmentProject: string | undefined;
    // Collapsed headers may stand alone, but never beneath a collapsed Project Chat.
    let segmentOpen =
      projectPath !== undefined && !tree.roots.some((node) => node.relationship === "home");
    const kindOf = (node: ConversationNavigationNode): SessionKind => {
      if (node.target.kind === "project-session")
        return sessionKind(this.props.catalog.find(node.target.sessionId));
      const parent = node.parentKey ? tree.byKey.get(node.parentKey) : undefined;
      return parent ? kindOf(parent) : "user";
    };
    const flush = () => {
      if (!segment.length && !segmentOpen) return;
      const first = segment.find(({ node }) => node.target.kind === "project-session");
      const path =
        projectPath ??
        segmentProject ??
        (first && this.props.catalog.find(first.node.target.sessionId)?.projectPath);
      const list = this.props.sessionList;
      const headed =
        !resolved && path !== undefined && list.showsSessionKindGroups(path) ? path : undefined;
      const counts = headed !== undefined ? list.activeSessionKindCounts(headed) : undefined;
      for (const kind of sessionKinds) {
        const expanded = headed === undefined || list.isSessionKindGroupExpanded(headed, kind);
        const kindRows = expanded ? segment.filter(({ node }) => kindOf(node) === kind) : [];
        const key = `${resolved ? "resolved" : "active"}:${path ?? ""}:${kind}`;
        // Resolved history keeps its plain labels inside the Resolved sessions disclosure.
        if (resolved) {
          if (kindRows.length) groups.push({ key, label: sessionKindLabels[kind], rows: kindRows });
        } else if (headed !== undefined && (kindRows.length || !expanded || !searching)) {
          groups.push({
            key,
            label: sessionKindLabels[kind],
            rows: kindRows,
            header: { projectPath: headed, kind, count: counts![kind], expanded },
          });
        } else if (kindRows.length) groups.push({ key, rows: kindRows });
      }
      segment = [];
    };
    for (const row of rows) {
      if (row.node.relationship === "home") {
        flush();
        segmentProject = this.props.projection.cakeChatCatalog.sessions.find(
          (chat) => chat.sessionId === row.node.target.sessionId,
        )?.projectPath;
        segmentOpen = this.isExpanded(projectPath, row.node.key);
        groups.push({ key: row.node.key, rows: [row] });
      } else segment.push(row);
    }
    flush();
    return groups;
  }

  /** Every archived session in scope, including children; undefined until each archive is observed. */
  resolvedCount(projectPath: string | undefined) {
    let total = 0;
    for (const path of this.projectPaths(projectPath)) {
      const count = this.props.catalog.resolvedSessionTotal(path);
      if (count === undefined) return undefined;
      // A just-resolved row can arrive through the active lane before the archive page refreshes.
      total += Math.max(count, this.props.catalog.projectSessions(path, true).length);
    }
    return total;
  }

  async open(node: ConversationNavigationEntry) {
    this.error = undefined;
    try {
      this.props.interact(node.target);
      await this.props.open(node.target);
    } catch (error) {
      if (!this.signal.aborted) this.error = error instanceof Error ? error.message : String(error);
    }
  }

  private scopeKey(projectPath: string | undefined) {
    return projectPath ?? "cake-chat";
  }
}

const sessionKindLabels = {
  user: "My sessions",
  delegated: "Delegated",
} satisfies Record<SessionKind, string>;

export type ConversationRow = { node: ConversationNavigationNode; depth: number };

export interface ConversationRowGroup {
  /** Stable across header appearance, so rows keep their React identity and focus. */
  readonly key: string;
  readonly label?: string;
  readonly rows: readonly ConversationRow[];
  /** Collapsible active kind group; absent when only one kind is active. */
  readonly header?: {
    readonly projectPath: string;
    readonly kind: SessionKind;
    readonly count: number;
    readonly expanded: boolean;
  };
}

function sameLineage(
  left: readonly ConversationNavigationEntry[],
  right: readonly ConversationNavigationEntry[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const next = right[index]!;
      return (
        entry.key === next.key &&
        entry.title === next.title &&
        entry.relationship === next.relationship &&
        entry.target.kind === next.target.kind &&
        (entry.target.kind !== "side-chat" ||
          (next.target.kind === "side-chat" &&
            entry.target.parentSessionId === next.target.parentSessionId &&
            entry.target.threadId === next.target.threadId))
      );
    })
  );
}

import { Store, computed, observable, snapshot, type ReadonlySignal } from "r-state-tree";
import { isActiveSessionActivity } from "../lib/session-activity";
import type { RootProjection } from "../models/RootProjection";
import { conversationOwnedNavigation } from "../lib/conversation-owned-navigation";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SidebarSessionListStore } from "./SidebarSessionListStore";
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

  tree(projectPath: string | undefined, resolved = false) {
    const key = `${resolved ? "resolved" : "active"}:${this.scopeKey(projectPath)}`;
    let tree = this.trees.get(key);
    if (!tree) {
      tree = computed(() => this.buildTree(projectPath, resolved));
      this.trees.set(key, tree);
    }
    return tree.value;
  }

  private buildTree(projectPath: string | undefined, resolved: boolean) {
    const model = this.props.projection;
    return buildConversationNavigationTree({
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
    const homeId =
      projectPath === undefined
        ? CAKE_CHAT_SESSION_ID
        : projection.cakeChatCatalog.sessions.find((session) => session.projectPath === projectPath)
            ?.sessionId;
    if (homeId)
      targets.set(homeId, {
        sessionId: homeId,
        workingDirectory: projectPath ?? "",
        kind: "cake-chat",
      });
    if (projectPath)
      for (const session of this.props.catalog.projectSessions(projectPath)) {
        if (
          includeClosed ||
          !session.resolved ||
          this.props.sessionList.isResolvedGroupExpanded(projectPath)
        )
          targets.set(session.sessionId, {
            sessionId: session.sessionId,
            workingDirectory: session.workingDirectory,
            kind: "project-session",
          });
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

  /** Read each active session's own flag, never inherited activity or descendant catalogs. */
  projectUnread(projectPath: string) {
    return (
      this.props.catalog.projectSessions(projectPath, false).some((session) => session.unread) ||
      this.props.projection.cakeChatCatalog.sessions.some(
        (session) => session.projectPath === projectPath && !session.resolved && session.unread,
      )
    );
  }

  countFor(projectPath?: string) {
    return this.tree(projectPath).total;
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
              title: worker.task || "Subagent",
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

  rows(
    projectPath: string | undefined,
    resolved = false,
  ): readonly { node: ConversationNavigationNode; depth: number }[] {
    const tree = this.tree(projectPath, resolved);
    const query = this.query(projectPath);
    const matching = matchingConversationNavigationKeys(tree, query);
    const visible =
      projectPath && !query.trim()
        ? new Set(
            this.props.sessionList
              .visibleProjectSessions(projectPath, resolved)
              .map((session) => conversationNavigationKey(session.sessionId)),
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

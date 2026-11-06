import { Store, computed, observable, snapshot } from "r-state-tree";
import type { RootProjection } from "../models/RootProjection";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SidebarSessionListStore } from "./SidebarSessionListStore";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import {
  buildConversationNavigationTree,
  conversationNavigationKey,
  conversationNavigationLineage,
  matchingConversationNavigationKeys,
  conversationNavigationTargetKey,
  type ConversationNavigationNode,
  type ConversationNavigationTarget,
  type ConversationNavigationMetadataTarget,
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
  error: string | undefined;

  constructor(props: ConversationNavigatorStore["props"]) {
    super(props);
    this.effect(() => {
      const keys = this.selectedAncestorKeys;
      this.revealSelection(keys);
    });
  }

  tree(projectPath: string | undefined, resolved = false) {
    const model = this.props.projection;
    return buildConversationNavigationTree({
      projectPath,
      sessions: projectPath
        ? this.props.sessionList.projectSessions(projectPath, resolved, true)
        : [],
      resolved,
      cakeChats: model.cakeChatCatalog.sessions,
      discussions: model.discussionCatalogs,
      subagents: model.subagentCatalogs,
      conversations: [
        ...model.projectConversations,
        ...model.cakeChatConversations,
        ...model.discussionConversations,
      ],
    });
  }

  /** Metadata demand follows the selected scope and discovered public sidecar owners, never transcript demand. */
  metadataTargets(
    projectPath: string | undefined,
  ): readonly ConversationNavigationMetadataTarget[] {
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
        if (!session.resolved || this.props.sessionList.isResolvedGroupExpanded(projectPath))
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
            thread.status !== "open" ||
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

  countFor(projectPath?: string) {
    return this.tree(projectPath).total;
  }

  get selectedKey(): string | undefined {
    const target = this.props.selected();
    return target ? conversationNavigationTargetKey(target) : undefined;
  }

  lineageForTarget(target: ConversationNavigationTarget): readonly ConversationNavigationNode[] {
    return this.lineageForKey(conversationNavigationTargetKey(target));
  }

  lineageFor(sessionId: string): readonly ConversationNavigationNode[] {
    const selected = this.props.selected();
    const lineage = selected ? this.lineageForTarget(selected) : [];
    const key = conversationNavigationKey(sessionId);
    return lineage.some((node) => node.key === key) ? lineage : this.lineageForKey(key);
  }

  private lineageForKey(key: string): readonly ConversationNavigationNode[] {
    for (const projectPath of [
      undefined,
      ...this.props.projection.projects.projects.map((project) => project.path),
    ]) {
      const tree = this.tree(projectPath);
      if (tree.byKey.has(key)) return conversationNavigationLineage(tree, key);
    }
    return [];
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

  async open(node: ConversationNavigationNode) {
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

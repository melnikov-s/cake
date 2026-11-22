import {
  untracked,
  Store,
  computed,
  observable,
  snapshot,
  type ReadonlySignal,
} from "r-state-tree";
import { subagentTitle } from "../lib/subagent-title";
import { isActiveSessionActivity } from "../lib/session-activity";
import type { RootProjection } from "../models/RootProjection";
import { conversationOwnedNavigation } from "../lib/conversation-owned-navigation";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import { ProjectCatalogContext } from "./context/ProjectCatalogContext";
import type { SidebarSessionListStore } from "./SidebarSessionListStore";
import { sessionKinds, type SessionKind } from "../lib/session-kind";
import type { ReviewThread } from "../models/ReviewThread";
import type { DiscussionCatalog } from "../models/DiscussionCatalog";
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
  registry: SessionRegistryStore;
  sessionList: SidebarSessionListStore;
  selected(): ConversationNavigationTarget | undefined;
  interact(target: ConversationNavigationTarget): void;
  open(target: ConversationNavigationTarget): void | Promise<void>;
}> {
  @snapshot private readonly collapsed: Record<string, boolean> = observable({});
  private readonly queries: Record<string, string> = observable({});
  private readonly searchCollapsed: Record<string, boolean> = observable({});
  private readonly trees = observable(
    new Map<string, ReadonlySignal<ConversationNavigationTree>>(),
  );
  private readonly lineages = observable(
    new Map<string, ReadonlySignal<readonly ConversationNavigationEntry[]>>(),
  );
  private readonly metadataScopes = observable(
    new Map<string, ReadonlySignal<readonly ConversationNavigationMetadataTarget[]>>(),
  );
  /** Per node/owner working state, so a heading re-reads cached descendants instead of rescanning them. */
  readonly #workingNodes = new WeakMap<ConversationNavigationNode, ReadonlySignal<boolean>>();
  readonly #ownedWorking = new Map<string, ReadonlySignal<boolean>>();
  readonly #sidecarTargets = new WeakMap<
    DiscussionCatalog,
    Map<boolean, ReadonlySignal<readonly ConversationNavigationMetadataTarget[]>>
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
    if (projectPath !== undefined) return this.scopeTree(projectPath, resolved);
    return this.cachedTree(`all:${resolved}`, () => {
      const trees = [
        this.scopeTree(undefined, resolved),
        ...this.projectPaths.map((path) => this.scopeTree(path, resolved)),
      ];
      return {
        roots: trees.flatMap((tree) => tree.roots),
        byKey: new Map(trees.flatMap((tree) => [...tree.byKey])),
        total: trees.reduce((sum, tree) => sum + tree.total, 0),
        running: trees.reduce((sum, tree) => sum + tree.running, 0),
        unread: trees.reduce((sum, tree) => sum + tree.unread, 0),
      };
    });
  }

  private cachedTree(key: string, build: () => ConversationNavigationTree) {
    let tree = untracked(() => this.trees.get(key));
    if (!tree) {
      tree = computed(build);
      this.trees.set(key, tree);
    }
    return tree.value;
  }

  @computed
  private get projectPaths() {
    return ProjectCatalogContext.consume(this)!.orderedProjectPaths;
  }

  /** Project context changes presentation order, never catalog scope. */
  private viewScopes(projectPath: string | undefined): readonly (string | undefined)[] {
    return projectPath !== undefined && this.projectPaths.includes(projectPath)
      ? [projectPath, undefined, ...this.projectPaths.filter((path) => path !== projectPath)]
      : [undefined, ...this.projectPaths];
  }

  private scopeTree(
    projectPath: string | undefined,
    resolved: boolean,
  ): ConversationNavigationTree {
    return this.cachedTree(`${resolved}:${this.scopeKey(projectPath)}`, () => {
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
    });
  }

  /** The header menu reads only this conversation's direct ownership catalogs. */
  ownedConversations(sessionId: string) {
    return conversationOwnedNavigation(
      sessionId,
      this.discussionCatalogsBySession.get(sessionId),
      this.subagentsByOwner.get(sessionId),
      (id) => this.props.projection.findDiscussionConversation(id),
    );
  }

  /**
   * Work is recursive and independent of disclosure; unread and outcomes stay with their owner.
   * Cached per node: a Project Chat heading over every Session must not rescan them all per render.
   */
  effectiveWorking(node: ConversationNavigationNode): boolean {
    let working = this.#workingNodes.get(node);
    if (!working) {
      working = computed(() => {
        // Read every child: short-circuiting would release later children's caches.
        const children = node.children.map((child) => this.effectiveWorking(child));
        return (
          node.running ||
          isActiveSessionActivity(node.activity) ||
          children.includes(true) ||
          (node.target.kind !== "subagent" && this.ownedWorking(node.target.sessionId))
        );
      });
      this.#workingNodes.set(node, working);
    }
    return working.value;
  }

  private ownedWorking(sessionId: string): boolean {
    let working = this.#ownedWorking.get(sessionId);
    if (!working) {
      working = computed(() =>
        this.ownedConversations(sessionId).some((child) => this.effectiveWorking(child)),
      );
      this.#ownedWorking.set(sessionId, working);
    }
    return working.value;
  }

  /** Metadata demand follows the all-project view and discovered sidecars, never transcript demand. */
  metadataTargets(includeClosed = false): readonly ConversationNavigationMetadataTarget[] {
    const key = String(includeClosed);
    let scope = untracked(() => this.metadataScopes.get(key));
    if (!scope) {
      const signature = computed(() => JSON.stringify(this.buildMetadataTargets(includeClosed)));
      scope = computed(() => {
        // SAFETY: the signature serializes only the typed metadata targets built above.
        return JSON.parse(signature.value) as readonly ConversationNavigationMetadataTarget[];
      });
      this.metadataScopes.set(key, scope);
    }
    return scope.value;
  }

  private buildMetadataTargets(includeClosed: boolean) {
    const projection = this.props.projection;
    const targets = new Map<string, ConversationNavigationMetadataTarget>();
    targets.set(CAKE_CHAT_SESSION_ID, {
      sessionId: CAKE_CHAT_SESSION_ID,
      workingDirectory: "",
      kind: "cake-chat",
    });
    for (const path of this.projectPaths) {
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
        if (includeClosed || !session.resolved || this.props.sessionList.resolvedGroupExpanded)
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
        for (const sidecar of this.sidecarTargets(catalog, includeClosed)) {
          if (targets.has(sidecar.sessionId)) continue;
          targets.set(sidecar.sessionId, sidecar);
          discovered = true;
        }
      }
    }
    return [...targets.values()];
  }

  /**
   * One catalog's sidecar owners. Each Session's metadata arrival rederives only its own
   * catalog; the scope's targets rebuild only when an actual sidecar appears or disappears.
   */
  private sidecarTargets(
    catalog: DiscussionCatalog,
    includeClosed: boolean,
  ): readonly ConversationNavigationMetadataTarget[] {
    let scopes = this.#sidecarTargets.get(catalog);
    if (!scopes) {
      scopes = new Map();
      this.#sidecarTargets.set(catalog, scopes);
    }
    let targets = scopes.get(includeClosed);
    if (!targets) {
      const signature = computed(() =>
        JSON.stringify(
          (catalog.metadataLoaded ? catalog.metadata : catalog.threads).flatMap((thread) =>
            (includeClosed || thread.status === "open") && thread.sidecarSessionId
              ? [
                  {
                    sessionId: thread.sidecarSessionId,
                    workingDirectory: thread.workingDirectory,
                    kind: "side-chat",
                  },
                ]
              : [],
          ),
        ),
      );
      targets = computed(() => {
        // SAFETY: the signature serializes only the typed sidecar targets built above.
        return JSON.parse(signature.value) as readonly ConversationNavigationMetadataTarget[];
      });
      scopes.set(includeClosed, targets);
    }
    return targets.value;
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
  summaryCounts() {
    if (!this.props.catalog.backgroundSignalsLoaded) return this.tree(undefined);
    const model = this.props.projection;
    const projects = new Set(this.projectPaths);
    const sessions = this.props.catalog.backgroundSessions.filter((session) =>
      projects.has(session.projectPath),
    );
    const chats = model.cakeChatCatalog.sessions.filter(
      (chat) =>
        !chat.resolved &&
        (chat.sessionId === CAKE_CHAT_SESSION_ID ||
          (chat.projectPath !== undefined && projects.has(chat.projectPath))),
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
        Number(!chats.some((chat) => chat.sessionId === CAKE_CHAT_SESSION_ID)),
      running: sessions.filter((session) => session.running || live.get(session.sessionId)).length,
      unread:
        sessions.filter(
          (session) =>
            session.unread &&
            (!session.familyParentSessionId || session.familyParentSessionId === session.sessionId),
        ).length + chats.filter((chat) => chat.unread).length,
    };
  }

  get selectedKey(): string | undefined {
    const target = this.props.selected();
    return target ? conversationNavigationTargetKey(target) : undefined;
  }

  lineageForTarget(target: ConversationNavigationTarget): readonly ConversationNavigationEntry[] {
    const key = conversationNavigationTargetKey(target);
    let lineage = untracked(() => this.lineages.get(key));
    if (!lineage) {
      // Stable scalar equality keeps activity-only metadata replacements from
      // notifying ownership/title consumers, without writes during derivation.
      const signature = computed(() => JSON.stringify(this.buildLineage(target)));
      lineage = computed(() => {
        // SAFETY: the signature serializes only the typed lineage entries built above.
        return JSON.parse(signature.value) as readonly ConversationNavigationEntry[];
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
  private get discussionCatalogsBySession() {
    return new Map(
      this.props.projection.discussionCatalogs.map((catalog) => [catalog.sessionId, catalog]),
    );
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

  /** Presentation ownership includes staged identities, without adding them to Sessions. */
  projectPathForSession(sessionId: string): string | undefined {
    const catalogPath = this.props.catalog.backgroundSession(sessionId)?.projectPath;
    if (catalogPath) return catalogPath;
    const chat = this.props.projection.cakeChatCatalog.sessions.find(
      (chat) => chat.sessionId === sessionId,
    );
    if (chat) return chat.projectPath;
    const registry = this.props.registry;
    const directory = registry.findSession(sessionId)?.workspacePath;
    return directory ? this.props.catalog.projectPathFor(directory) : undefined;
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
    if (this.props.registry.pendingSessions.isStaged(sessionId)) {
      const projectPath = this.projectPathForSession(sessionId);
      const conversation = this.props.registry.pendingSessions.conversation(sessionId);
      if (projectPath && conversation)
        return [
          ...this.homeLineage(projectPath),
          {
            key: conversationNavigationKey(sessionId),
            title: conversation.title,
            relationship: "grouped",
            target: { kind: "project-session", sessionId },
          },
        ];
    }
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

  @computed
  private get projectHomeKeys() {
    return new Map(
      this.props.projection.cakeChatCatalog.sessions.flatMap(({ projectPath, sessionId }) =>
        projectPath === undefined
          ? []
          : [[projectPath, conversationNavigationKey(sessionId)] as const],
      ),
    );
  }

  isPinnedOpen(projectPath: string | undefined, key: string) {
    return projectPath !== undefined && this.projectHomeKeys.get(projectPath) === key;
  }

  isExpanded(projectPath: string | undefined, key: string) {
    return (
      this.isPinnedOpen(projectPath, key) ||
      !(this.query(projectPath).trim() ? this.searchCollapsed[key] : this.collapsed[key])
    );
  }

  toggleExpanded(projectPath: string | undefined, key: string) {
    if (this.isPinnedOpen(projectPath, key)) return;
    const collapsed = this.query(projectPath).trim() ? this.searchCollapsed : this.collapsed;
    collapsed[key] = !collapsed[key];
  }

  collapseAll(projectPath: string | undefined) {
    for (const node of this.tree(undefined).byKey.values())
      if (node.children.length && this.isExpanded(projectPath, node.key))
        this.toggleExpanded(projectPath, node.key);
  }

  hasMoreSessions(projectPath: string | undefined, resolved = false) {
    return this.projectPaths.some((path) => {
      const home = this.tree(path).roots.find((node) => node.relationship === "home");
      if (!resolved && home && !this.isExpanded(projectPath, home.key)) return false;
      return resolved
        ? this.props.sessionList.hasMoreResolvedProjectSessions(path)
        : this.props.sessionList.hasMoreActiveProjectSessions(path);
    });
  }

  showMoreSessions(resolved = false) {
    for (const path of this.projectPaths) this.props.sessionList.showMoreSessions(path, resolved);
  }

  private scopeRows(
    scope: string | undefined,
    projectPath: string | undefined,
    resolved: boolean,
  ): ConversationRow[] {
    const tree = this.scopeTree(scope, resolved);
    const query = this.query(projectPath);
    const matching = query.trim() ? matchingConversationNavigationKeys(tree, query) : undefined;
    const visible =
      !matching && scope !== undefined
        ? new Set(
            this.props.sessionList
              .visibleProjectSessions(scope, resolved)
              .map(({ sessionId }) => sessionId),
          )
        : undefined;
    const rows: ConversationRow[] = [];
    const visit = (node: ConversationNavigationNode, depth: number) => {
      if (matching && !matching.has(node.key)) return;
      if (visible && node.target.kind === "project-session" && !visible.has(node.target.sessionId))
        return;
      rows.push({ node, depth });
      if (this.isExpanded(projectPath, node.key))
        for (const child of node.children) visit(child, depth + 1);
    };
    for (const root of tree.roots) visit(root, 0);
    return rows;
  }

  resolvedRows(projectPath: string | undefined): readonly ConversationRow[] {
    return this.viewScopes(projectPath).flatMap((path) =>
      path === undefined ? [] : this.scopeRows(path, projectPath, true),
    );
  }

  toggleKind(projectPath: string | undefined, path: string, kind: SessionKind, expanded: boolean) {
    if (this.query(projectPath).trim()) this.searchCollapsed[this.kindKey(path, kind)] = expanded;
    else this.props.sessionList.setSessionKindGroupExpanded(path, kind, !expanded);
  }

  private kindKey(path: string, kind: SessionKind) {
    return `active:${path}:${kind}`;
  }

  /** Presentation groups only; project and family ownership are unchanged. */
  rowGroups(
    projectPath: string | undefined,
    canAutoMerge: (path: string) => boolean,
  ): readonly ConversationRowGroup[] {
    const groups: ConversationRowGroup[] = [];
    const list = this.props.sessionList;
    const searching = Boolean(this.query(projectPath).trim());
    for (const path of this.viewScopes(projectPath)) {
      const rows = this.scopeRows(path, projectPath, false);
      const home = rows.find(({ node }) => node.relationship === "home");
      const autoMerge = path !== undefined && canAutoMerge(path);
      if (home)
        groups.push({
          key: home.node.key,
          rows: [home],
          showEmptyDelegatedGroup: autoMerge && !searching,
        });
      if (path === undefined || (home && !this.isExpanded(projectPath, home.node.key))) continue;
      const counts = list.activeSessionKindCounts(path);
      for (const kind of sessionKinds) {
        const key = this.kindKey(path, kind);
        const matches = rows.filter(
          ({ node }) =>
            node.target.kind === "project-session" &&
            list.sessionKindForDisplay(node.target.sessionId) === kind,
        );
        if (searching && !matches.length) continue;
        const headed =
          kind === "delegated"
            ? counts.delegated > 0 || autoMerge
            : counts.user > 0 && counts.delegated > 0;
        const expanded =
          !headed ||
          (searching ? !this.searchCollapsed[key] : list.isSessionKindGroupExpanded(path, kind));
        if (!headed && !matches.length) continue;
        const running =
          kind === "delegated" && !expanded
            ? [...this.tree(path).byKey.values()].filter(
                ({ target, running }) =>
                  target.kind === "project-session" &&
                  (running || this.props.catalog.backgroundSession(target.sessionId)?.running) &&
                  list.sessionKindForDisplay(target.sessionId) === "delegated",
              ).length
            : undefined;
        groups.push({
          key,
          containingProjectPath: home ? path : undefined,
          rows: expanded ? matches : [],
          header: headed
            ? {
                projectPath: path,
                kind,
                label: sessionKindLabels[kind],
                count: counts[kind],
                expanded,
                running,
                autoMerge: kind === "delegated" && autoMerge,
              }
            : undefined,
        });
      }
    }
    return groups;
  }

  /** Every archived session, including children; undefined until each archive is observed. */
  resolvedCount() {
    let total = 0;
    for (const path of this.projectPaths) {
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

type ConversationRow = { node: ConversationNavigationNode; depth: number };

export interface ConversationRowGroup {
  /** Stable across header appearance, so rows keep their React identity and focus. */
  readonly key: string;
  readonly containingProjectPath?: string;
  readonly showEmptyDelegatedGroup?: boolean;
  readonly rows: readonly ConversationRow[];
  readonly header?: {
    readonly projectPath: string;
    readonly kind: SessionKind;
    readonly label: string;
    readonly count: number;
    readonly expanded: boolean;
    readonly running?: number;
    readonly autoMerge: boolean;
  };
}

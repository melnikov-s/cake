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
import { sessionKind, sessionKinds, type SessionKind } from "../lib/session-kind";
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
    let previousOwner: string | undefined;
    let selectedResolution: boolean | undefined;
    this.effect(() => {
      const keys = this.selectedAncestorKeys;
      const group = this.selectedSessionGroup;
      const projectPath = this.selectedProjectPath;
      const owner = this.selectedOwnerId;
      const session = this.selectedSession;
      if (owner !== previousOwner) selectedResolution = undefined;
      // Reveal an explicitly selected archive, not a live session briefly marked
      // resolved before retirement moves selection back to its Project Chat.
      const archive =
        selectedResolution === undefined && session?.resolved ? session.projectPath : undefined;
      previousOwner = owner;
      selectedResolution ??= session?.resolved;
      untracked(() => this.revealSelection(keys, group, projectPath, archive));
    });
  }

  tree(projectPath: string | undefined, resolved = false): ConversationNavigationTree {
    if (projectPath !== undefined) return this.scopeTree(projectPath, resolved);
    return this.cachedTree(`all:${resolved}`, () => {
      const trees = this.projectPaths.map((path) => this.scopeTree(path, resolved));
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
  private viewScopes(projectPath: string | undefined): readonly string[] {
    return projectPath !== undefined && this.projectPaths.includes(projectPath)
      ? [projectPath, ...this.projectPaths.filter((path) => path !== projectPath)]
      : this.projectPaths;
  }

  private scopeTree(projectPath: string, resolved: boolean): ConversationNavigationTree {
    return this.cachedTree(`${resolved}:${this.scopeKey(projectPath)}`, () => {
      const model = this.props.projection;
      return buildConversationNavigationTree({
        projectPath,
        projectName: this.projectName(projectPath),
        sessions: this.props.sessionList.projectSessions(projectPath, resolved, true),
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
        if (includeClosed || !session.resolved || this.props.sessionList.isArchiveExpanded(path))
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
        chat.sessionId !== CAKE_CHAT_SESSION_ID &&
        !chat.resolved &&
        chat.projectPath !== undefined &&
        projects.has(chat.projectPath),
    );
    const live = new Map(
      [...model.projectConversations, ...model.cakeChatConversations].map((conversation) => [
        conversation.sessionId,
        conversation.streaming || conversation.activeTurnIds.length > 0,
      ]),
    );
    return {
      total: sessions.length + chats.length,
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

  private get selectedOwnerId() {
    const target = this.props.selected();
    if (!target) return undefined;
    return (
      this.lineageForTarget(target).findLast(
        ({ target }) => target.kind === "project-session" || target.kind === "cake-chat",
      )?.target.sessionId ??
      (target.kind === "side-chat" ? target.parentSessionId : target.sessionId)
    );
  }

  @computed
  private get selectedProjectPath() {
    const id = this.selectedOwnerId;
    return id && id !== CAKE_CHAT_SESSION_ID ? this.projectPathForSession(id) : undefined;
  }

  private get selectedSession() {
    const id = this.selectedOwnerId;
    return id ? this.props.catalog.find(id) : undefined;
  }

  @computed
  private get selectedSessionGroup() {
    const session = this.selectedSession;
    if (!session || session.resolved) return undefined;
    return this.kindKey(
      session.projectPath,
      this.props.sessionList.sessionKindForDisplay(session.sessionId),
    );
  }

  private revealSelection(
    ancestorKeys: string,
    group: string | undefined,
    projectPath: string | undefined,
    archive: string | undefined,
  ) {
    const keys = ancestorKeys.split("\n");
    if (projectPath) keys.push(this.projectHeadingKey(projectPath));
    for (const key of keys) {
      // A selection overrides a manual close, but keeps a manual open when we leave the project.
      if (this.collapsed[key] === true) delete this.collapsed[key];
      delete this.searchCollapsed[key];
    }
    if (group) {
      delete this.searchCollapsed[group];
      const session = this.selectedSession!;
      const list = this.props.sessionList;
      list.setSessionKindGroupExpanded(
        session.projectPath,
        list.sessionKindForDisplay(session.sessionId),
        true,
      );
    }
    if (archive) this.props.sessionList.setArchiveExpanded(archive, true);
  }

  query(projectPath: string | undefined) {
    return this.queries[this.scopeKey(projectPath)] ?? "";
  }

  setQuery(projectPath: string | undefined, query: string) {
    this.queries[this.scopeKey(projectPath)] = query;
    for (const key of Object.keys(this.searchCollapsed)) delete this.searchCollapsed[key];
  }

  @computed
  private get projectHomePaths() {
    return new Map(
      this.props.projection.cakeChatCatalog.sessions.flatMap(({ projectPath, sessionId }) =>
        projectPath === undefined || sessionId === CAKE_CHAT_SESSION_ID
          ? []
          : [[conversationNavigationKey(sessionId), projectPath] as const],
      ),
    );
  }

  @computed
  private get projectsWithUserSessions() {
    // Every family with a user-owned member belongs to My sessions. Background
    // summaries include those members even before the list or a page is loaded.
    return new Set(
      this.props.catalog.backgroundSessions
        .filter((session) => sessionKind(session) === "user")
        .map((session) => session.projectPath),
    );
  }

  private projectHeadingKey(path: string) {
    return `project:${path}`;
  }

  private projectHeadingPath(key: string) {
    return key.startsWith("project:")
      ? key.slice("project:".length)
      : this.projectHomePaths.get(key);
  }

  isPinnedOpen(projectPath: string | undefined, key: string) {
    return projectPath !== undefined && this.projectHeadingPath(key) === projectPath;
  }

  isExpanded(projectPath: string | undefined, key: string) {
    if (this.isPinnedOpen(projectPath, key)) return true;
    const path = this.projectHeadingPath(key);
    const disclosureKey = path === undefined ? key : this.projectHeadingKey(path);
    if (this.query(projectPath).trim()) return !this.searchCollapsed[disclosureKey];
    const collapsed = this.collapsed[disclosureKey] ?? this.collapsed[key];
    if (collapsed !== undefined) return !collapsed;
    return (
      path === undefined ||
      path === this.selectedProjectPath ||
      this.projectsWithUserSessions.has(path)
    );
  }

  toggleExpanded(projectPath: string | undefined, key: string) {
    if (this.isPinnedOpen(projectPath, key)) return;
    const collapsed = this.query(projectPath).trim() ? this.searchCollapsed : this.collapsed;
    const path = this.projectHeadingPath(key);
    collapsed[path === undefined ? key : this.projectHeadingKey(path)] = this.isExpanded(
      projectPath,
      key,
    );
  }

  collapseAll(projectPath: string | undefined) {
    for (const path of this.projectPaths) {
      const tree = this.tree(path);
      const key = this.homeRow(tree)?.node.key ?? this.projectHeadingKey(path);
      if (this.isExpanded(projectPath, key)) this.toggleExpanded(projectPath, key);
      for (const node of tree.byKey.values())
        if (
          node.relationship !== "home" &&
          node.children.length &&
          this.isExpanded(projectPath, node.key)
        )
          this.toggleExpanded(projectPath, node.key);
    }
  }

  hasMoreSessions(projectPath: string | undefined) {
    return this.projectPaths.some((path) => {
      const key = this.homeRow(this.tree(path))?.node.key ?? this.projectHeadingKey(path);
      return (
        this.isExpanded(projectPath, key) &&
        this.props.sessionList.hasMoreActiveProjectSessions(path)
      );
    });
  }

  showMoreSessions() {
    for (const path of this.projectPaths) this.props.sessionList.showMoreSessions(path);
  }

  private homeRow(tree: ConversationNavigationTree): ConversationRow | undefined {
    const node = tree.roots.find((node) => node.relationship === "home");
    return node ? { node, depth: 0 } : undefined;
  }

  private scopeRows(
    scope: string,
    projectPath: string | undefined,
    resolved: boolean,
  ): ConversationRow[] {
    const tree = this.scopeTree(scope, resolved);
    const query = this.query(projectPath);
    const matching = query.trim() ? matchingConversationNavigationKeys(tree, query) : undefined;
    const visible = !matching
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
  ): readonly ConversationProjectGroup[] {
    const projects: ConversationProjectGroup[] = [];
    const list = this.props.sessionList;
    const searching = Boolean(this.query(projectPath).trim());
    for (const path of this.viewScopes(projectPath)) {
      const tree = this.tree(path);
      const home = this.homeRow(tree);
      const headingKey = home?.node.key ?? this.projectHeadingKey(path);
      const expanded = this.isExpanded(projectPath, headingKey);
      const rows = expanded || searching ? this.scopeRows(path, projectPath, false) : [];
      const archiveExpanded = (expanded || searching) && list.isArchiveExpanded(path);
      const archiveRows = archiveExpanded ? this.scopeRows(path, projectPath, true) : [];
      if (searching && !rows.length && !archiveRows.length) continue;
      const archiveCount = expanded ? this.archiveCount(path) : undefined;
      const showArchive =
        expanded && (searching ? archiveRows.length > 0 : archiveExpanded || archiveCount !== 0);
      projects.push({
        path,
        name: this.projectName(path),
        home,
        headingKey,
        expanded,
        active: expanded ? this.activeGroups(path, rows, searching, canAutoMerge(path)) : [],
        archive: showArchive
          ? {
              count: archiveCount,
              expanded: archiveExpanded,
              rows: archiveRows,
              hasMore: archiveExpanded && !searching && list.hasMoreResolvedProjectSessions(path),
            }
          : undefined,
      });
    }
    return projects;
  }

  private activeGroups(
    path: string,
    rows: readonly ConversationRow[],
    searching: boolean,
    autoMerge: boolean,
  ): ConversationRowGroup[] {
    const list = this.props.sessionList;
    const counts = list.activeSessionKindCounts(path);
    return sessionKinds.flatMap((kind) => {
      const key = this.kindKey(path, kind);
      const matches = rows.filter(
        ({ node }) =>
          node.target.kind === "project-session" &&
          list.sessionKindForDisplay(node.target.sessionId) === kind,
      );
      if (searching ? !matches.length : !counts[kind] && !(kind === "delegated" && autoMerge))
        return [];
      const expanded = searching
        ? !this.searchCollapsed[key]
        : list.isSessionKindGroupExpanded(path, kind);
      const running =
        kind === "delegated" && !expanded
          ? [...this.tree(path).byKey.values()].filter(
              ({ target, running }) =>
                target.kind === "project-session" &&
                (running || this.props.catalog.backgroundSession(target.sessionId)?.running) &&
                list.sessionKindForDisplay(target.sessionId) === "delegated",
            ).length
          : undefined;
      return [
        {
          kind,
          label: sessionKindLabels[kind],
          count: counts[kind],
          expanded,
          running,
          autoMerge: kind === "delegated" && autoMerge,
          rows: expanded ? matches : [],
        },
      ];
    });
  }

  /** Includes all archived family members; a cold archive can have an unknown total. */
  private archiveCount(path: string) {
    const count = this.props.catalog.resolvedSessionTotal(path);
    if (count === undefined) return undefined;
    // A just-resolved row can arrive through the active lane before the archive page refreshes.
    return Math.max(count, this.props.catalog.projectSessions(path, true).length);
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

interface ConversationRowGroup {
  readonly kind: SessionKind;
  readonly label: string;
  readonly count: number;
  readonly expanded: boolean;
  readonly running?: number;
  readonly autoMerge: boolean;
  readonly rows: readonly ConversationRow[];
}

interface ConversationProjectGroup {
  readonly path: string;
  readonly name: string;
  readonly home?: ConversationRow;
  readonly headingKey: string;
  readonly expanded: boolean;
  readonly active: readonly ConversationRowGroup[];
  readonly archive?: {
    readonly count?: number;
    readonly expanded: boolean;
    readonly rows: readonly ConversationRow[];
    readonly hasMore: boolean;
  };
}

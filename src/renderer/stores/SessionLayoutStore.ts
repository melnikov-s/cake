import { Store, observable, snapshot } from "r-state-tree";

export const MAX_SESSION_PANES = 4;

export type SessionSplitAxis = "x" | "y";

export interface SessionPaneNode {
  readonly kind: "pane";
  readonly paneId: string;
  readonly history: readonly string[];
  readonly historyCursor: number;
}

interface SessionSplitNode {
  readonly kind: "split";
  readonly splitId: string;
  readonly axis: SessionSplitAxis;
  readonly ratio: number;
  readonly first: SessionLayoutNode;
  readonly second: SessionLayoutNode;
}

export type SessionLayoutNode = SessionPaneNode | SessionSplitNode;

export interface SessionPane {
  readonly paneId: string;
  readonly sessionId: string;
  readonly number: number;
  readonly focused: boolean;
}

export interface SessionPanePlacement extends SessionPane {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Owns one persisted conversation split tree, pane focus, and per-pane navigation. */
export class SessionLayoutStore extends Store {
  @snapshot layout: SessionLayoutNode | undefined;
  @snapshot focusedPaneId: string | undefined;
  @snapshot private readonly childPaneIdsByParentSessionId: Record<string, string> = observable({});

  get panes(): readonly SessionPane[] {
    const paneNodes = this.layout ? collectPanes(this.layout) : [];
    return paneNodes.flatMap((pane, index) => {
      const sessionId = pane.history[pane.historyCursor];
      return sessionId
        ? [
            {
              paneId: pane.paneId,
              sessionId,
              number: index + 1,
              focused: pane.paneId === this.focusedPaneId,
            },
          ]
        : [];
    });
  }

  get panePlacements(): readonly SessionPanePlacement[] {
    if (!this.layout) return [];
    const bounds = new Map<string, Omit<SessionPanePlacement, keyof SessionPane>>();
    collectBounds(this.layout, { x: 0, y: 0, width: 1, height: 1 }, bounds);
    return this.panes.map((pane) => ({ ...pane, ...bounds.get(pane.paneId)! }));
  }

  get focusedPane() {
    return this.panes.find((pane) => pane.focused);
  }

  get focusedSessionId() {
    return this.focusedPane?.sessionId;
  }

  get canSplit() {
    return this.panes.length > 0 && this.panes.length < MAX_SESSION_PANES;
  }

  hasSession(sessionId: string) {
    return this.panes.some((pane) => pane.sessionId === sessionId);
  }

  paneForSession(sessionId: string) {
    return this.panes.find((pane) => pane.sessionId === sessionId);
  }

  /** The session's visible pane number, omitted when there is no split to distinguish. */
  paneNumber(sessionId: string) {
    const panes = this.panes;
    if (panes.length <= 1) return undefined;
    return panes.find((pane) => pane.sessionId === sessionId)?.number;
  }

  neighbors(sessionId: string) {
    const origin = this.panePlacements.find((pane) => pane.sessionId === sessionId);
    const empty = { left: [], right: [], above: [], below: [] };
    if (!origin) return empty;
    const others = this.panePlacements.filter((pane) => pane.paneId !== origin.paneId);
    const verticalOverlap = (pane: SessionPanePlacement) =>
      Math.min(origin.y + origin.height, pane.y + pane.height) - Math.max(origin.y, pane.y) > 0;
    const horizontalOverlap = (pane: SessionPanePlacement) =>
      Math.min(origin.x + origin.width, pane.x + pane.width) - Math.max(origin.x, pane.x) > 0;
    const adjacent = (left: number, right: number) => Math.abs(left - right) < 0.000_001;
    const target = (pane: SessionPanePlacement) => ({
      paneId: pane.paneId,
      sessionId: pane.sessionId,
    });
    return {
      left: others
        .filter((pane) => adjacent(pane.x + pane.width, origin.x) && verticalOverlap(pane))
        .map(target),
      right: others
        .filter((pane) => adjacent(origin.x + origin.width, pane.x) && verticalOverlap(pane))
        .map(target),
      above: others
        .filter((pane) => adjacent(pane.y + pane.height, origin.y) && horizontalOverlap(pane))
        .map(target),
      below: others
        .filter((pane) => adjacent(origin.y + origin.height, pane.y) && horizontalOverlap(pane))
        .map(target),
    };
  }

  ensureSession(sessionId: string): string {
    const existing = this.paneForSession(sessionId);
    if (existing) {
      this.focusedPaneId = existing.paneId;
      return existing.paneId;
    }
    if (!this.layout) {
      const paneId = crypto.randomUUID();
      this.layout = paneNode(paneId, sessionId);
      this.focusedPaneId = paneId;
      return paneId;
    }
    return this.showSession(sessionId);
  }

  focusPane(paneId: string) {
    if (!this.panes.some((pane) => pane.paneId === paneId)) return undefined;
    this.focusedPaneId = paneId;
    return this.focusedSessionId;
  }

  focusSession(sessionId: string) {
    const pane = this.paneForSession(sessionId);
    return pane ? this.focusPane(pane.paneId) : undefined;
  }

  showSession(sessionId: string): string {
    const existing = this.paneForSession(sessionId);
    if (existing) {
      this.focusedPaneId = existing.paneId;
      return existing.paneId;
    }
    if (!this.layout || !this.focusedPaneId) return this.ensureSession(sessionId);
    const paneId = this.focusedPaneId;
    this.layout = removeSessionFromOtherHistories(this.layout, sessionId, paneId);
    this.layout = updatePane(this.layout, paneId, (pane) => {
      const history = pane.history.slice(0, pane.historyCursor + 1);
      return { ...pane, history: [...history, sessionId], historyCursor: history.length };
    });
    return paneId;
  }

  splitFocused(sessionId: string, axis: SessionSplitAxis) {
    if (!this.layout || !this.focusedPaneId || !this.canSplit) return undefined;
    if (this.hasSession(sessionId)) return this.focusSession(sessionId);
    const sourcePaneId = this.focusedPaneId;
    const paneId = crypto.randomUUID();
    this.layout = replaceNode(this.layout, sourcePaneId, (node) => ({
      kind: "split",
      splitId: crypto.randomUUID(),
      axis,
      ratio: 0.5,
      first: node,
      second: paneNode(paneId, sessionId),
    }));
    this.focusedPaneId = paneId;
    return paneId;
  }

  /** Opens one family child beside its parent and reuses that slot for later children. */
  showChildSession(parentSessionId: string, childSessionId: string, axis: SessionSplitAxis = "x") {
    const existing = this.paneForSession(childSessionId);
    if (existing) {
      this.childPaneIdsByParentSessionId[parentSessionId] = existing.paneId;
      return this.focusPane(existing.paneId) ? existing.paneId : undefined;
    }
    const parentPane = this.paneForSession(parentSessionId);
    if (!parentPane || !this.layout) return undefined;
    const assignedPaneId = this.childPaneIdsByParentSessionId[parentSessionId];
    if (assignedPaneId && this.panes.some((pane) => pane.paneId === assignedPaneId)) {
      this.layout = removeSessionFromOtherHistories(this.layout, childSessionId, assignedPaneId);
      this.layout = updatePane(this.layout, assignedPaneId, (pane) =>
        paneNode(pane.paneId, childSessionId),
      );
      this.focusedPaneId = assignedPaneId;
      return assignedPaneId;
    }
    if (assignedPaneId) delete this.childPaneIdsByParentSessionId[parentSessionId];
    if (!this.canSplit) return undefined;
    this.focusedPaneId = parentPane.paneId;
    const paneId = this.splitFocused(childSessionId, axis);
    if (paneId) this.childPaneIdsByParentSessionId[parentSessionId] = paneId;
    return paneId;
  }

  closePane(paneId: string) {
    if (!this.layout || this.panes.length <= 1) return undefined;
    const currentPanes = collectPanes(this.layout);
    const closingIndex = currentPanes.findIndex((pane) => pane.paneId === paneId);
    const closing = currentPanes[closingIndex];
    if (!closing) return undefined;
    const nextLayout = removePane(this.layout, paneId);
    if (!nextLayout) return undefined;
    this.layout = nextLayout;
    for (const [parentSessionId, childPaneId] of Object.entries(this.childPaneIdsByParentSessionId))
      if (childPaneId === paneId || closing.history.includes(parentSessionId))
        delete this.childPaneIdsByParentSessionId[parentSessionId];
    const remaining = collectPanes(nextLayout);
    const nextPane =
      remaining[Math.min(remaining.length - 1, Math.max(0, closingIndex))] ?? remaining[0];
    if (
      this.focusedPaneId === paneId ||
      !remaining.some((pane) => pane.paneId === this.focusedPaneId)
    )
      this.focusedPaneId = nextPane?.paneId;
    return { removedSessionIds: [...closing.history], focusedSessionId: this.focusedSessionId };
  }

  removeSessions(sessionIds: readonly string[]) {
    if (!this.layout || sessionIds.length === 0) return;
    const removed = new Set(sessionIds);
    this.layout = pruneSessions(this.layout, removed);
    const remainingPaneIds = new Set(this.panes.map((pane) => pane.paneId));
    for (const [parentSessionId, childPaneId] of Object.entries(this.childPaneIdsByParentSessionId))
      if (removed.has(parentSessionId) || !remainingPaneIds.has(childPaneId))
        delete this.childPaneIdsByParentSessionId[parentSessionId];
    const panes = this.panes;
    if (panes.length === 0) {
      this.focusedPaneId = undefined;
      return;
    }
    if (!panes.some((pane) => pane.paneId === this.focusedPaneId))
      this.focusedPaneId = panes[0]!.paneId;
  }

  setSplitRatio(splitId: string, ratio: number) {
    if (!this.layout) return;
    this.layout = updateSplit(this.layout, splitId, (split) => ({
      ...split,
      ratio: Math.min(0.8, Math.max(0.2, ratio)),
    }));
  }

  goBack() {
    return this.navigateFocused(-1);
  }

  goForward() {
    return this.navigateFocused(1);
  }

  private navigateFocused(delta: -1 | 1) {
    if (!this.layout || !this.focusedPaneId) return undefined;
    let sessionId: string | undefined;
    this.layout = updatePane(this.layout, this.focusedPaneId, (pane) => {
      const historyCursor = Math.min(
        pane.history.length - 1,
        Math.max(0, pane.historyCursor + delta),
      );
      if (historyCursor === pane.historyCursor) return pane;
      sessionId = pane.history[historyCursor];
      return { ...pane, historyCursor };
    });
    return sessionId;
  }
}

function paneNode(paneId: string, sessionId: string): SessionPaneNode {
  return { kind: "pane", paneId, history: [sessionId], historyCursor: 0 };
}

function collectPanes(node: SessionLayoutNode): SessionPaneNode[] {
  return node.kind === "pane"
    ? [node]
    : [...collectPanes(node.first), ...collectPanes(node.second)];
}

function collectBounds(
  node: SessionLayoutNode,
  bounds: { x: number; y: number; width: number; height: number },
  result: Map<string, { x: number; y: number; width: number; height: number }>,
) {
  if (node.kind === "pane") {
    result.set(node.paneId, bounds);
    return;
  }
  if (node.axis === "x") {
    const firstWidth = bounds.width * node.ratio;
    collectBounds(node.first, { ...bounds, width: firstWidth }, result);
    collectBounds(
      node.second,
      { ...bounds, x: bounds.x + firstWidth, width: bounds.width - firstWidth },
      result,
    );
    return;
  }
  const firstHeight = bounds.height * node.ratio;
  collectBounds(node.first, { ...bounds, height: firstHeight }, result);
  collectBounds(
    node.second,
    { ...bounds, y: bounds.y + firstHeight, height: bounds.height - firstHeight },
    result,
  );
}

function updatePane(
  node: SessionLayoutNode,
  paneId: string,
  update: (pane: SessionPaneNode) => SessionPaneNode,
): SessionLayoutNode {
  if (node.kind === "pane") return node.paneId === paneId ? update(node) : node;
  return {
    ...node,
    first: updatePane(node.first, paneId, update),
    second: updatePane(node.second, paneId, update),
  };
}

function replaceNode(
  node: SessionLayoutNode,
  paneId: string,
  replace: (node: SessionLayoutNode) => SessionLayoutNode,
): SessionLayoutNode {
  if (node.kind === "pane") return node.paneId === paneId ? replace(node) : node;
  return {
    ...node,
    first: replaceNode(node.first, paneId, replace),
    second: replaceNode(node.second, paneId, replace),
  };
}

function removePane(node: SessionLayoutNode, paneId: string): SessionLayoutNode | undefined {
  if (node.kind === "pane") return node.paneId === paneId ? undefined : node;
  const first = removePane(node.first, paneId);
  const second = removePane(node.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

function pruneSessions(
  node: SessionLayoutNode,
  removed: ReadonlySet<string>,
): SessionLayoutNode | undefined {
  if (node.kind === "pane") {
    const currentSessionId = node.history[node.historyCursor];
    const history = node.history.filter((sessionId) => !removed.has(sessionId));
    if (history.length === 0) return undefined;
    const retainedCurrentIndex = currentSessionId ? history.indexOf(currentSessionId) : -1;
    return {
      ...node,
      history,
      historyCursor:
        retainedCurrentIndex >= 0
          ? retainedCurrentIndex
          : Math.min(node.historyCursor, history.length - 1),
    };
  }
  const first = pruneSessions(node.first, removed);
  const second = pruneSessions(node.second, removed);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

function removeSessionFromOtherHistories(
  node: SessionLayoutNode,
  sessionId: string,
  targetPaneId: string,
): SessionLayoutNode {
  if (node.kind === "pane") {
    if (node.paneId === targetPaneId || !node.history.includes(sessionId)) return node;
    const currentSessionId = node.history[node.historyCursor];
    const history = node.history.filter((candidate) => candidate !== sessionId);
    if (history.length === 0) return node;
    return {
      ...node,
      history,
      historyCursor: Math.max(0, history.indexOf(currentSessionId ?? "")),
    };
  }
  return {
    ...node,
    first: removeSessionFromOtherHistories(node.first, sessionId, targetPaneId),
    second: removeSessionFromOtherHistories(node.second, sessionId, targetPaneId),
  };
}

function updateSplit(
  node: SessionLayoutNode,
  splitId: string,
  update: (split: SessionSplitNode) => SessionSplitNode,
): SessionLayoutNode {
  if (node.kind === "pane") return node;
  if (node.splitId === splitId) return update(node);
  return {
    ...node,
    first: updateSplit(node.first, splitId, update),
    second: updateSplit(node.second, splitId, update),
  };
}

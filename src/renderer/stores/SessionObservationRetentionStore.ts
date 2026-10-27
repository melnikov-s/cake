import { Store, computed, observable, snapshot } from "r-state-tree";
import type { ProjectSessionStore } from "./ProjectSessionStore";

const IDLE_OBSERVATION_LIMIT = 4;

export interface SessionObservationRetentionStoreProps {
  findSession(sessionId: string): ProjectSessionStore | undefined;
  activeSessions(): readonly ProjectSessionStore[];
  selectedSessionId(): string | undefined;
  visibleSessionIds(): readonly string[];
}

/** Owns process-local Project Session observation pins and idle warm-retention policy. */
export class SessionObservationRetentionStore extends Store<SessionObservationRetentionStoreProps> {
  @snapshot private readonly materializedSessionIds: string[] = observable([]);
  /** Process-local LRU. Selected, visible, and running sessions are pinned outside this budget. */
  private readonly recentSessionIds: string[] = observable([]);

  /** One explicit destination may be loading before it occupies a visible pane. */
  private requestedSessionId: string | undefined;

  @computed
  get sessions(): readonly ProjectSessionStore[] {
    const byId = new Map<string, ProjectSessionStore>();
    for (const sessionId of this.recentSessionIds) {
      const session = this.activeSessionsById.get(sessionId);
      if (session) byId.set(sessionId, session);
    }
    for (const session of this.runningSessions) byId.set(session.sessionId, session);
    const visible = new Set(this.pinnedSessionIds);
    // Resolved history never enters idle/running calculations. Only the explicit
    // destination and visible panes can demand an archived transcript.
    if (this.requestedSessionId) visible.add(this.requestedSessionId);
    for (const sessionId of visible) {
      if (byId.has(sessionId) || !this.materializedIds.has(sessionId)) continue;
      const session = this.props.findSession(sessionId);
      if (session) byId.set(sessionId, session);
    }
    return [...byId.values()];
  }

  materialize(sessionId: string) {
    addUnique(this.materializedSessionIds, sessionId);
    this.retain(sessionId);
  }

  retain(sessionId: string) {
    if (!this.materializedIds.has(sessionId)) return;
    this.requestedSessionId = this.props.visibleSessionIds().includes(sessionId)
      ? undefined
      : sessionId;
    if (!this.activeSessionsById.has(sessionId)) return;
    this.touch(sessionId);
    this.trim();
  }

  remove(sessionId: string) {
    if (this.requestedSessionId === sessionId) this.requestedSessionId = undefined;
    removeValue(this.materializedSessionIds, sessionId);
    removeValue(this.recentSessionIds, sessionId);
  }

  private touch(sessionId: string) {
    removeValue(this.recentSessionIds, sessionId);
    this.recentSessionIds.push(sessionId);
  }

  @computed
  private get materializedIds(): ReadonlySet<string> {
    return new Set(this.materializedSessionIds);
  }

  @computed
  private get activeMaterializedSessions() {
    return this.props
      .activeSessions()
      .filter((session) => this.materializedIds.has(session.sessionId));
  }

  @computed
  private get activeSessionsById(): ReadonlyMap<string, ProjectSessionStore> {
    return new Map(this.activeMaterializedSessions.map((session) => [session.sessionId, session]));
  }

  /** Activity changes invalidate this scan; pane selection does not. Archives
   * have already been excluded by activeMaterializedSessions.
   */
  @computed
  private get runningSessions(): readonly ProjectSessionStore[] {
    return this.activeMaterializedSessions.filter(isRunning);
  }

  @computed
  private get pinnedSessionIds(): ReadonlySet<string> {
    const pinned = new Set(this.props.visibleSessionIds());
    const selected = this.props.selectedSessionId();
    if (selected) pinned.add(selected);
    return pinned;
  }

  private trim() {
    const sessionsById = this.activeSessionsById;
    const pinned = this.pinnedSessionIds;
    const running = new Set(this.runningSessions.map((session) => session.sessionId));
    for (let index = this.recentSessionIds.length - 1; index >= 0; index -= 1) {
      const sessionId = this.recentSessionIds[index]!;
      if (sessionsById.has(sessionId)) continue;
      this.recentSessionIds.splice(index, 1);
    }
    const idleIds = this.recentSessionIds.filter((sessionId) => {
      return !pinned.has(sessionId) && !running.has(sessionId);
    });
    while (idleIds.length > IDLE_OBSERVATION_LIMIT)
      removeValue(this.recentSessionIds, idleIds.shift()!);
  }

  constructor(props: SessionObservationRetentionStore["props"]) {
    super(props);
    this.reaction(
      () => this.props.visibleSessionIds(),
      (visible) => {
        if (this.requestedSessionId && visible.includes(this.requestedSessionId))
          this.requestedSessionId = undefined;
      },
    );
    this.reaction(
      () => this.pinnedSessionIds,
      (pinned, previous) => {
        for (const sessionId of previous)
          if (!pinned.has(sessionId) && this.activeSessionsById.has(sessionId))
            this.touch(sessionId);
        this.trim();
      },
    );
    this.reaction(
      () => this.runningSessions,
      (running, previous) => {
        const runningIds = new Set(running.map((session) => session.sessionId));
        for (const session of previous)
          if (!runningIds.has(session.sessionId) && this.activeSessionsById.has(session.sessionId))
            this.touch(session.sessionId);
        this.trim();
      },
    );
  }
}

function isRunning(session: ProjectSessionStore) {
  return (
    session.model.streaming ||
    session.model.activeTurnIds.length > 0 ||
    session.subagentActivityStore.activeRuns.length > 0
  );
}

function addUnique(values: string[], value: string) {
  if (!values.includes(value)) values.push(value);
}

function removeValue(values: string[], value: string) {
  const index = values.indexOf(value);
  if (index >= 0) values.splice(index, 1);
}

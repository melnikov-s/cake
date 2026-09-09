import { Store, observable, snapshot } from "r-state-tree";
import type { ProjectSessionStore } from "./ProjectSessionStore";

const IDLE_OBSERVATION_LIMIT = 20;

export interface SessionObservationRetentionStoreProps {
  sessions(): readonly ProjectSessionStore[];
  isActive(sessionId: string): boolean;
  isVisible?(sessionId: string): boolean;
}

/** Owns process-local Project Session observation pins and idle warm-retention policy. */
export class SessionObservationRetentionStore extends Store<SessionObservationRetentionStoreProps> {
  @snapshot private readonly materializedSessionIds: string[] = observable([]);
  /** Process-local LRU. Selected, visible, and running sessions are pinned outside this budget. */
  private readonly recentSessionIds: string[] = observable([]);

  get sessions(): readonly ProjectSessionStore[] {
    const recent = new Set(this.recentSessionIds);
    return this.props
      .sessions()
      .filter(
        (session) =>
          this.materializedSessionIds.includes(session.sessionId) &&
          (recent.has(session.sessionId) ||
            this.props.isActive(session.sessionId) ||
            this.props.isVisible?.(session.sessionId) ||
            isRunning(session)),
      );
  }

  materialize(sessionId: string) {
    addUnique(this.materializedSessionIds, sessionId);
    this.retain(sessionId);
  }

  retain(sessionId: string) {
    if (!this.materializedSessionIds.includes(sessionId)) return;
    this.touch(sessionId);
    this.trim();
  }

  remove(sessionId: string) {
    removeValue(this.materializedSessionIds, sessionId);
    removeValue(this.recentSessionIds, sessionId);
  }

  private touch(sessionId: string) {
    removeValue(this.recentSessionIds, sessionId);
    this.recentSessionIds.push(sessionId);
  }

  private trim() {
    const loadedIds = new Set(this.props.sessions().map((session) => session.sessionId));
    for (let index = this.recentSessionIds.length - 1; index >= 0; index -= 1) {
      const sessionId = this.recentSessionIds[index]!;
      if (loadedIds.has(sessionId) && this.materializedSessionIds.includes(sessionId)) continue;
      this.recentSessionIds.splice(index, 1);
    }
    const idleIds = this.recentSessionIds.filter((sessionId) => {
      const session = this.props.sessions().find((candidate) => candidate.sessionId === sessionId)!;
      return (
        !this.props.isActive(sessionId) && !this.props.isVisible?.(sessionId) && !isRunning(session)
      );
    });
    while (idleIds.length > IDLE_OBSERVATION_LIMIT)
      removeValue(this.recentSessionIds, idleIds.shift()!);
  }

  constructor(props: SessionObservationRetentionStore["props"]) {
    super(props);
    this.reaction(
      () =>
        this.props.sessions().map((session) => ({
          sessionId: session.sessionId,
          active: this.props.isActive(session.sessionId),
          visible: this.props.isVisible?.(session.sessionId) ?? false,
          running: isRunning(session),
        })),
      (sessions, previousSessions) => {
        const previousById = new Map(
          previousSessions.map((session) => [session.sessionId, session]),
        );
        for (const session of sessions) {
          const previous = previousById.get(session.sessionId);
          if (
            previous &&
            ((previous.active && !session.active) ||
              (previous.visible && !session.visible) ||
              (previous.running && !session.running))
          )
            this.touch(session.sessionId);
        }
        this.trim();
      },
    );
  }
}

function isRunning(session: ProjectSessionStore) {
  return (
    session.model.streaming ||
    session.model.activeTurnIds.length > 0 ||
    session.model.backgroundWorkActive
  );
}

function addUnique(values: string[], value: string) {
  if (!values.includes(value)) values.push(value);
}

function removeValue(values: string[], value: string) {
  const index = values.indexOf(value);
  if (index >= 0) values.splice(index, 1);
}

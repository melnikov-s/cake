import { batch } from "r-state-tree";
import type { ProjectSessionSignalsUpdate } from "../../contracts/project-sessions/project-session-signals";
import type { SessionCatalog } from "../models/SessionCatalog";

/** Background attention can update cached rows, but never materializes list details. */
export function applySessionSignalsUpdate(
  model: SessionCatalog,
  update: ProjectSessionSignalsUpdate,
) {
  batch(() => {
    const signals = model.signals;
    if (update._tag === "TitleChanged") {
      const existing = model.find(update.sessionId);
      if (existing) existing.title = update.title;
      return;
    }
    signals.sessions =
      update._tag === "Snapshot"
        ? update.sessions
        : update._tag === "Upserted"
          ? [
              ...signals.sessions.filter(
                (session) => session.sessionId !== update.session.sessionId,
              ),
              update.session,
            ]
          : signals.sessions.filter((session) => session.sessionId !== update.sessionId);
    if (update._tag === "Snapshot") signals.loaded = true;
    const affected =
      update._tag === "Snapshot"
        ? undefined
        : update._tag === "Upserted"
          ? update.session.sessionId
          : update.sessionId;
    for (let index = model.sessions.length - 1; index >= 0; index--) {
      const session = model.sessions[index]!;
      if (affected !== undefined && session.sessionId !== affected) continue;
      const signal = signals.find(session.sessionId);
      if (signal) {
        session.running = signal.running;
        session.workingStartedAt = signal.workingStartedAt;
        session.unread = signal.unread;
        session.recoveryIssue = signal.recoveryIssue;
        session.latestTurnOutcome = signal.latestTurnOutcome;
      } else if (!session.resolved) model.sessions.splice(index, 1);
    }
  });
}

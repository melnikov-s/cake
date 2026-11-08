import type { WorktreeLandingOperation } from "../../contracts/worktrees/worktree-landing-data";
import { diagnosticId, responsivenessRun } from "./responsiveness-diagnostics";

const terminal = (phase: string) => ["landed", "complete", "failed"].includes(phase);

/** One recorder per coordinator Scope. Retains only current operations, never history. */
export function makeLandingPhaseRecorder() {
  const current = new Map<
    string,
    { operation: WorktreeLandingOperation; started: number; phaseStarted: number }
  >();
  return (operations: ReadonlyMap<string, WorktreeLandingOperation>, now: number) => {
    const records: Array<Readonly<Record<string, string | number | boolean>>> = [];
    const next = new Map(
      [...operations.values()].map((operation) => [operation.operationId, operation]),
    );
    for (const [id, previous] of current) {
      if (next.has(id)) continue;
      if (!terminal(previous.operation.phase))
        records.push({
          run: responsivenessRun,
          landing: diagnosticId(id),
          session: diagnosticId(previous.operation.sessionId),
          workspace: diagnosticId(previous.operation.workspacePath),
          phase: "canceled",
          previousPhase: previous.operation.phase,
          durationMs: Math.max(0, now - previous.phaseStarted),
          totalDurationMs: Math.max(0, now - previous.started),
        });
      current.delete(id);
    }
    for (const [id, operation] of next) {
      const previous = current.get(id);
      if (previous?.operation.phase === operation.phase) continue;
      const record = {
        run: responsivenessRun,
        landing: diagnosticId(id),
        session: diagnosticId(operation.sessionId),
        workspace: diagnosticId(operation.workspacePath),
        phase: operation.phase,
      };
      if (previous)
        Object.assign(record, {
          previousPhase: previous.operation.phase,
          durationMs: Math.max(0, now - previous.phaseStarted),
          totalDurationMs: Math.max(0, now - previous.started),
        });
      if (operation.error) Object.assign(record, { error: diagnosticId(operation.error) });
      records.push(record);
      current.set(id, { operation, started: previous?.started ?? now, phaseStarted: now });
    }
    return records;
  };
}

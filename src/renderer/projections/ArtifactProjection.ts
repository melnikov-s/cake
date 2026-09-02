import { applySnapshot, toSnapshot, type Snapshot } from "r-state-tree";
import type { ArtifactRecord } from "../../ipc/artifact-contract";
import { artifactSnapshot } from "../../utils/session-snapshot";
import type { Session } from "../models/Session";

export function applyArtifactUpdate(session: Session, record: ArtifactRecord) {
  const current = toSnapshot(session);
  // SAFETY: current is Session's canonical snapshot and record crossed artifactRecordSchema.
  const next = {
    ...current,
    artifacts: [
      ...(current.artifacts ?? []).filter((artifact) => artifact.id !== record.artifact.id),
      artifactSnapshot(record),
    ],
  } as Snapshot<Session>;
  applySnapshot(session, next);
}

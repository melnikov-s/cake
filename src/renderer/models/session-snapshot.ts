import type { Snapshot } from "r-state-tree";
import type { SessionPreview, SessionSnapshot } from "../../ipc/session-contract";
import { toArtifactSnapshot } from "./artifact";
import { modelOptionKey } from "./model-option";
import type { SessionModel } from "./session";

/** Converts the validated IPC projection into SessionModel's canonical snapshot shape. */
export function toSessionModelSnapshot(snapshot: SessionSnapshot): Snapshot<SessionModel> {
  // SAFETY: Every field is sourced from the validated IPC projection and paired with
  // the SessionModel field that mirrors it. The cast contains Snapshot's distributive
  // array typing at this transport boundary.
  return {
    workspacePath: snapshot.workspacePath,
    sessionId: snapshot.sessionId,
    sessionFile: snapshot.sessionFile,
    parts: snapshot.parts,
    model: snapshot.model,
    models: snapshot.models.map((option) => ({ ...option, key: modelOptionKey(option) })),
    thinkingLevel: snapshot.thinkingLevel,
    availableThinkingLevels: snapshot.availableThinkingLevels,
    piSettings: snapshot.piSettings,
    streaming: snapshot.streaming,
    diagnostics: snapshot.diagnostics,
    commands: snapshot.commands,
    usage: snapshot.usage,
    resources: snapshot.compatibility.resources,
    resourceDiagnostics: snapshot.compatibility.diagnostics,
    tree: snapshot.tree,
    artifacts: (snapshot.artifacts ?? []).map(toArtifactSnapshot)
  } as Snapshot<SessionModel>;
}

export function toSessionPreviewSnapshot(preview: SessionPreview): Snapshot<SessionModel> {
  // SAFETY: Session previews are validated partial SessionModel snapshots.
  return {
    workspacePath: preview.workspacePath,
    sessionId: preview.sessionId,
    sessionFile: preview.sessionFile,
    parts: preview.parts
  } as Snapshot<SessionModel>;
}

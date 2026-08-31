import type { Snapshot } from "r-state-tree";
import type { ConversationSnapshot } from "../domain/conversation-data";
import { sessionSnapshotSchema } from "../ipc/session-contract";
import { modelOptionKey } from "./model-option-key";
import type { ArtifactRecord } from "../ipc/artifact-contract";
import type { Session } from "../renderer/models/Session";

/** Validates one authoritative conversation Snapshot into Session's canonical Model shape. */
export function toSessionSnapshot(snapshot: ConversationSnapshot): Snapshot<Session> {
  const parsed = sessionSnapshotSchema.parse({
    ...snapshot,
    workspacePath: snapshot.workingDirectory,
  });
  // SAFETY: every field is populated from the validated session contract and canonical child snapshots.
  return {
    workingDirectory: snapshot.workingDirectory,
    sessionId: parsed.sessionId,
    sessionFile: parsed.sessionFile,
    parts: parsed.parts,
    model: parsed.model,
    fastMode: parsed.fastMode ?? false,
    fastModeAvailable: parsed.fastModeAvailable ?? false,
    models: parsed.models.map((option) => ({ ...option, key: modelOptionKey(option) })),
    thinkingLevel: parsed.thinkingLevel,
    availableThinkingLevels: parsed.availableThinkingLevels,
    piSettings: parsed.piSettings,
    streaming: parsed.streaming,
    diagnostics: parsed.diagnostics,
    commands: parsed.commands,
    usage: parsed.usage,
    resources: parsed.compatibility.resources,
    resourceDiagnostics: parsed.compatibility.diagnostics,
    tree: parsed.tree,
    artifacts: (parsed.artifacts ?? []).map(artifactSnapshot),
    extensionUi: {
      title: parsed.extensionUi.title,
      statuses: parsed.extensionUi.statuses,
      notifications: [],
      compatibilityDiagnostics: [],
      editorText: undefined,
      editorTextRevision: 0,
    },
  } as Snapshot<Session>;
}

function artifactSnapshot(record: ArtifactRecord) {
  return {
    ...record.artifact,
    workspacePath: record.workspacePath,
    digest: record.digest,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

import { createStore, mount } from "r-state-tree";
import type { SavedDraft } from "../../../../src/services/storage/saved-draft-data";
import { describe, expect, it, vi } from "vitest";
import { ProjectPendingSessionsStore } from "../../../../src/renderer/stores/ProjectPendingSessionsStore";
import type { ProjectSessionStore } from "../../../../src/renderer/stores/ProjectSessionStore";
import { fakeSavedDrafts } from "../fakes/saved-drafts";

interface PendingSessionStub {
  sessionId: string;
  workspacePath: string;
  stagedCommandStore: {
    load: ReturnType<typeof vi.fn>;
    invalidate: ReturnType<typeof vi.fn>;
  };
}

function fixture() {
  const sessions = new Map<string, PendingSessionStub>();
  const persistNow = vi.fn(async () => undefined);
  const { client: savedDrafts, records } = fakeSavedDrafts();
  const prepareIdentity = (sessionId: string, workingDirectory: string) => {
    const existing = sessions.get(sessionId);
    if (existing) return existing as unknown as ProjectSessionStore;
    const session: PendingSessionStub = {
      sessionId,
      workspacePath: workingDirectory,
      stagedCommandStore: { load: vi.fn(), invalidate: vi.fn() },
    };
    sessions.set(sessionId, session);
    return session as unknown as ProjectSessionStore;
  };
  const store = mount(
    createStore(ProjectPendingSessionsStore, {
      savedDrafts,
      session: (sessionId) => sessions.get(sessionId) as unknown as ProjectSessionStore | undefined,
      prepareIdentity,
      relocateIdentity: (sessionId, workingDirectory) => {
        const session = sessions.get(sessionId)!;
        session.workspacePath = workingDirectory;
        return session as unknown as ProjectSessionStore;
      },
      materializeIdentity: (sessionId, workingDirectory) => {
        const session = sessions.get(sessionId)!;
        session.workspacePath = workingDirectory;
        return session as unknown as ProjectSessionStore;
      },
      removeSession: (sessionId) => {
        sessions.delete(sessionId);
        store.remove(sessionId);
      },
      persistNow,
      projectName: (workingDirectory) => workingDirectory,
    }),
  );
  return { sessions, store, persistNow, records };
}

// Retained while the real-Root relocation regression in saved-draft-workflow.test.tsx is
// blocked by SessionRegistryStore's temporary-session Working Directory collision check.
describe("ProjectPendingSessionsStore legacy relocation regression", () => {
  it("relocates an activated Draft from another client to its authoritative Working Directory", () => {
    const { sessions, store } = fixture();
    const id = "00000000-0000-4000-8000-000000000001";
    const saved: SavedDraft = {
      sessionId: id,
      projectPath: "/project",
      workingDirectory: "/project",
      title: "Shared task",
      text: "First turn",
      attachments: [],
      labelIds: [],
      resolved: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      modifiedAt: "2026-01-01T00:00:00.000Z",
      revision: 1,
      status: "saved",
    };
    store.applySavedDraftSnapshot([saved]);
    expect(store.isTemporary(id)).toBe(true);
    expect(sessions.get(id)?.workspacePath).toBe("/project");
    store.applySavedDraftSnapshot([
      { ...saved, status: "activated", workingDirectory: "/worktrees/task", revision: 3 },
    ]);
    expect(sessions.get(id)?.workspacePath).toBe("/worktrees/task");
    expect(store.isTemporary(id)).toBe(false);
    store[Symbol.dispose]();
  });
});

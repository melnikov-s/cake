import { createStore, mount } from "r-state-tree";
import type { SavedDraft } from "../../../../src/domain/project-sessions/saved-draft-data";
import { describe, expect, it, vi } from "vitest";
import { ProjectPendingSessionsStore } from "../../../../src/renderer/stores/ProjectPendingSessionsStore";
import type { ProjectSessionStore } from "../../../../src/renderer/stores/ProjectSessionStore";
import { PendingConversationStore } from "../../../../src/renderer/stores/PendingConversationStore";
import { fakeSavedDrafts } from "../fake-saved-drafts";

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

describe("ProjectPendingSessionsStore", () => {
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
  it("writes saved Draft title, resolved state and labels through shared revision CAS", async () => {
    const { store, records } = fixture();
    const id = "00000000-0000-4000-8000-000000000001";
    const saved: SavedDraft = {
      sessionId: id,
      projectPath: "/project",
      workingDirectory: "/project",
      title: "Original",
      text: "Start",
      attachments: [],
      labelIds: [],
      resolved: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      modifiedAt: "2026-01-01T00:00:00.000Z",
      revision: 1,
      status: "saved",
    };
    records.set(id, saved);
    store.applySavedDraftSnapshot([saved]);
    await store.updateSavedMetadata(id, { title: "Renamed", resolved: true, labelIds: ["label"] });
    expect(records.get(id)).toMatchObject({
      title: "Renamed",
      resolved: true,
      labelIds: ["label"],
      revision: 2,
    });
    expect(store.conversation(id)?.title).toBe("Renamed");
    expect(store.conversation(id)?.resolved).toBe(true);
    store[Symbol.dispose]();
  });

  it("releases a staged session while it submits and restores it after cancellation", () => {
    const { store } = fixture();
    store.prepareStaged("/project", "session-1");

    store.projectSubmission("session-1", "Start work");
    expect(store.isStaged("session-1")).toBe(false);

    store.cancelSubmission("session-1");
    expect(store.isStaged("session-1")).toBe(true);

    store[Symbol.dispose]();
  });

  it("shows a live generated title during the first turn without replacing an explicit name", () => {
    const { store } = fixture();
    store.prepareStaged("/project", "new-session");
    store.projectSubmission("new-session", "Investigate naming");
    expect(store.summaries[0]?.title).toBe("Investigate naming");

    store.applyLiveTitle("new-session", "Generated title");
    expect(store.summaries[0]?.title).toBe("Generated title");
    store.applyLiveTitle("new-session", "Later model response");
    expect(store.summaries[0]?.title).toBe("Generated title");

    store.prepareStaged("/project", "explicit-session");
    store.conversation("explicit-session")!.setName("My name");
    store.projectSubmission("explicit-session", "Investigate naming");
    store.applyLiveTitle("explicit-session", "Unwanted title");
    expect(store.conversation("explicit-session")?.title).toBe("My name");
    store[Symbol.dispose]();
  });

  it("owns staged, saved-draft, relocated, and materialized transitions", async () => {
    const { sessions, store, persistNow, records } = fixture();
    const session = store.prepareStaged("/project", "draft-1");
    const pendingConversation = store.conversation("draft-1")!;
    expect(pendingConversation).toBeInstanceOf(PendingConversationStore);
    expect(store.conversation("draft-1")).toBe(pendingConversation);
    pendingConversation.setName(" Planned work ");
    pendingConversation.setConfiguration({
      provider: "openai",
      modelId: "gpt-5",
      thinkingLevel: "high",
      fastMode: false,
    });
    store.relocate("draft-1", "/worktree");
    await store.createDraft("draft-1", "Do this later", []);

    expect(store.isStaged("draft-1")).toBe(false);
    expect(store.isDraft("draft-1")).toBe(true);
    expect(pendingConversation.name).toBe("Planned work");
    expect(session.workspacePath).toBe("/worktree");
    expect(sessions.get("draft-1")?.stagedCommandStore.load).toHaveBeenCalledWith("/worktree");
    expect(persistNow).not.toHaveBeenCalled();
    expect(records.get("draft-1")?.text).toBe("Do this later");
    await store.updateDraft("draft-1", "Updated from client", []);
    expect(store.savedRecord("draft-1")?.revision).toBe(2);
    expect(records.get("draft-1")?.text).toBe("Updated from client");
    expect(store.isTemporary("draft-1")).toBe(true);
    expect(store.materialize("draft-1", "/worktree")).toBe(session);
    expect(store.isTemporary("draft-1")).toBe(false);
    expect(sessions.get("draft-1")?.stagedCommandStore.invalidate).toHaveBeenCalledOnce();

    store[Symbol.dispose]();
  });
});

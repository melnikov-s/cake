import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { ProjectPendingSessionsStore } from "../../../../src/renderer/stores/ProjectPendingSessionsStore";
import type { ProjectSessionStore } from "../../../../src/renderer/stores/ProjectSessionStore";

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
  return { sessions, store, persistNow };
}

describe("ProjectPendingSessionsStore", () => {
  it("owns staged, saved-draft, relocated, and materialized transitions", async () => {
    const { sessions, store, persistNow } = fixture();
    const session = store.prepareStaged("/project", "draft-1");
    store.setName("draft-1", " Planned work ");
    store.setConfiguration("draft-1", {
      provider: "openai",
      modelId: "gpt-5",
      thinkingLevel: "high",
      fastMode: false,
    });
    store.relocate("draft-1", "/worktree");
    await store.createDraft("draft-1", "Do this later", []);

    expect(store.isStaged("draft-1")).toBe(false);
    expect(store.isDraft("draft-1")).toBe(true);
    expect(store.name("draft-1")).toBe("Planned work");
    expect(session.workspacePath).toBe("/worktree");
    expect(sessions.get("draft-1")?.stagedCommandStore.load).toHaveBeenCalledWith("/worktree");
    expect(persistNow).toHaveBeenCalledOnce();

    const prompt = store.activateDraft("draft-1");
    expect(prompt?.text).toBe("Do this later");
    expect(store.isTemporary("draft-1")).toBe(true);
    expect(store.materialize("draft-1", "/worktree")).toBe(session);
    expect(store.isTemporary("draft-1")).toBe(false);
    expect(sessions.get("draft-1")?.stagedCommandStore.invalidate).toHaveBeenCalledOnce();

    store[Symbol.dispose]();
  });
});

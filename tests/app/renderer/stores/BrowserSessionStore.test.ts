import { createStore, observable } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { TurnId } from "../../../../src/domain/conversations/conversation-data";
import type { ChatConfiguration } from "../../../../src/ipc/session-contract";
import type { SavedDraft } from "../../../../src/domain/project-sessions/saved-draft-data";
import { ClientError, type Client } from "../../../../src/renderer/client/Client";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";
import { BrowserSessionStore } from "../../../../src/renderer/stores/BrowserSessionStore";
import { mountWithClient } from "../mount-with-client";

const turnId = TurnId.make("00000000-0000-4000-8000-000000000002");
const configuration: ChatConfiguration = {
  provider: "test",
  modelId: "controlled",
  thinkingLevel: "off",
  fastMode: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(staged = true, record?: SavedDraft) {
  const saved = observable({ record });
  const projection = RootProjection.create();
  const connection = observable({ connected: true, known: false, catalogReady: true });
  const start = vi.fn<Client["projectSessions"]["start"]>(async () => turnId);
  const open = vi.fn<Client["projectSessions"]["open"]>(async () => undefined);
  const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () => turnId);
  const abort = vi.fn<Client["sessionChats"]["abort"]>(async () => undefined);
  const applyConfiguration = vi.fn<Client["sessionChats"]["applyConfiguration"]>(
    async () => undefined,
  );
  const client = {
    projectSessions: { start, open },
    sessionChats: { prompt, abort, applyConfiguration },
  } as unknown as Client;
  const mounted = mountWithClient(
    createStore(BrowserSessionStore, {
      sessionId: "session-1",
      projectPath: "/project",
      workingDirectory: "/project",
      staged,
      known: () => connection.known,
      connected: () => connection.connected,
      catalogReady: () => connection.catalogReady,
      model: projection.projectConversation("session-1", "/project"),
      savedDraft: () => saved.record,
      updateSavedDraft: async (record) => record,
      activateSavedDraft: async (record) => ({ record, workingDirectory: "/project" }),
      recoverUncertainDraft: async (record) => record,
      refreshSavedDrafts: async () => undefined,
    }),
    client,
  );
  return {
    ...mounted,
    connection,
    saved,
    start,
    open,
    prompt,
    abort,
    applyConfiguration,
    dispose() {
      mounted.root[Symbol.dispose]();
      projection[Symbol.dispose]();
    },
  };
}

describe("BrowserSessionStore", () => {
  it("blocks first-turn admission while another client owns an uncertain saved Draft claim", async () => {
    const f = fixture(true, {
      sessionId: "00000000-0000-4000-8000-000000000001",
      projectPath: "/project",
      workingDirectory: "/project",
      title: "Task",
      text: "First turn",
      attachments: [],
      labelIds: [],
      resolved: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      modifiedAt: "2026-01-01T00:00:00.000Z",
      revision: 2,
      status: "activating",
    });
    try {
      f.subject.chat.setDraft("duplicate turn");
      expect(f.subject.chat.canSubmit).toBe(false);
      expect(await f.subject.chat.submit()).toBe(false);
      expect(f.start).not.toHaveBeenCalled();
      expect(f.prompt).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });
  it("carries deferred configuration once and does not offer edits while first admission is pending", async () => {
    const f = fixture();
    const receipt = deferred<TurnId>();
    f.start.mockReturnValueOnce(receipt.promise);
    try {
      await f.subject.configuration.selectConfiguration(configuration);
      f.subject.chat.setDraft("First prompt");
      const submission = f.subject.chat.submit();
      expect(f.start).toHaveBeenCalledWith(
        expect.objectContaining({ text: "First prompt", configuration }),
        expect.objectContaining({ signal: f.subject.signal }),
      );
      expect(f.subject.chat.canSubmit).toBe(false);
      expect(f.subject.chat.modelPickerVisible).toBe(false);
      await expect(f.subject.chat.submit()).resolves.toBe(false);
      receipt.resolve(turnId);
      await expect(submission).resolves.toBe(true);
      expect(f.start).toHaveBeenCalledTimes(1);
      expect(f.subject.chat.draft).toBe("");
      expect(f.subject.configuration.deferred).toBe(false);
      expect(f.subject.chat.modelPickerVisible).toBe(false);
      f.subject.receivedSnapshot();
      expect(f.subject.chat.modelPickerVisible).toBe(true);
    } finally {
      receipt.resolve(turnId);
      f.dispose();
    }
  });

  it("does not submit against a configuration whose application is still pending", async () => {
    const f = fixture(false);
    const applied = deferred<void>();
    f.applyConfiguration.mockReturnValueOnce(applied.promise);
    try {
      await Promise.resolve();
      f.subject.receivedSnapshot();
      f.subject.chat.setDraft("Use selected model");
      const change = f.subject.configuration.selectConfiguration(configuration);
      expect(f.subject.chat.canSubmit).toBe(false);
      await expect(f.subject.chat.submit()).resolves.toBe(false);
      expect(f.prompt).not.toHaveBeenCalled();
      applied.resolve();
      await change;
      expect(f.subject.chat.canSubmit).toBe(true);
      await expect(f.subject.chat.submit()).resolves.toBe(true);
      expect(f.applyConfiguration).toHaveBeenCalledWith(
        { sessionId: "session-1", configuration },
        { signal: f.subject.signal },
      );
    } finally {
      applied.resolve();
      f.dispose();
    }
  });

  it("retains uncertain admission without replay until fresh catalog and conversation allow a deliberate decision", async () => {
    const f = fixture();
    f.start.mockRejectedValueOnce(
      new ClientError("transport", "projectSessions.start", "Lost receipt", "test"),
    );
    try {
      f.subject.chat.setDraft("Was this accepted?");
      await expect(f.subject.chat.submit()).resolves.toBe(false);
      expect(f.subject.uncertain).toBe(true);
      expect(f.subject.chat.draft).toBe("Was this accepted?");
      f.connection.connected = false;
      f.connection.catalogReady = false;
      f.subject.disconnected();
      f.subject.acknowledgeUncertainty(true);
      expect(f.subject.uncertain).toBe(true);
      f.connection.connected = true;
      f.connection.known = true;
      f.connection.catalogReady = true;
      await Promise.resolve();
      expect(f.subject.readyToReconcile).toBe(false);
      f.subject.receivedSnapshot();
      expect(f.subject.readyToReconcile).toBe(true);
      expect(f.subject.chat.canSubmit).toBe(false);
      expect(f.start).toHaveBeenCalledTimes(1);
      expect(f.prompt).not.toHaveBeenCalled();
      f.subject.acknowledgeUncertainty(false);
      expect(f.subject.chat.canSubmit).toBe(true);
      expect(f.subject.chat.draft).toBe("Was this accepted?");
    } finally {
      f.dispose();
    }
  });

  it("known rejection retains draft but does not claim unknown acceptance; offline turns cannot be stopped", async () => {
    const f = fixture();
    f.start.mockRejectedValueOnce(
      new ClientError("rejected", "projectSessions.start", "Rejected", "test"),
    );
    try {
      f.subject.chat.setDraft("Retry after fixing configuration");
      await expect(f.subject.chat.submit()).resolves.toBe(false);
      expect(f.subject.uncertain).toBe(false);
      expect(f.subject.chat.canSubmit).toBe(true);
      f.subject.model.streaming = true;
      f.subject.model.activeTurnIds.push("turn-1");
      expect(f.subject.chat.canStop).toBe(true);
      f.connection.connected = false;
      f.subject.disconnected();
      expect(f.subject.chat.canStop).toBe(false);
      expect(f.subject.chat.canSubmit).toBe(false);
      expect(f.abort).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });
});

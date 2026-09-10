import { createStore, mount, observable } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { CakeChatControlRequest } from "../../../../src/domain/cake-chats/cake-chat-data";
import type { JsonValue } from "../../../../src/ipc/json-contract";
import type { AppControlHost } from "../../../../src/renderer/app-control/AppControlBridge";
import type { Client } from "../../../../src/renderer/client/Client";
import { ApplicationControlStore } from "../../../../src/renderer/stores/ApplicationControlStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((complete) => (resolve = complete)), resolve };
}

function createHost(
  overrides: {
    projects?: AppControlHost["state"]["projects"];
    cakeChatSessions?: AppControlHost["state"]["cakeChatSessions"];
    create?: AppControlHost["sessions"]["create"];
  } = {},
): AppControlHost {
  return {
    sessionCoordination: {
      create: vi.fn(),
      get: vi.fn(),
      find: vi.fn(),
      record: vi.fn(),
      refresh: vi.fn(),
      close: vi.fn(),
    } as unknown as AppControlHost["sessionCoordination"],
    state: {
      currentSelection: () => ({ kind: "workbench" }),
      projects: overrides.projects ?? (() => []),
      sessions: () => [],
      cakeChatSessions: overrides.cakeChatSessions ?? (() => []),
      sessionActivity: () => undefined,
      managedWorktree: () => undefined,
    },
    settings: {
      get: () => ({
        section: "appearance",
        settings: {
          theme: "system",
          projectAvatarsEnabled: true,
          sessionAvatarsEnabled: true,
          workLogViewMode: "auto",
          workLogsExpansion: "collapsed",
        },
      }),
      update: async () => ({
        section: "appearance",
        settings: {
          theme: "system",
          projectAvatarsEnabled: true,
          sessionAvatarsEnabled: true,
          workLogViewMode: "auto",
          workLogsExpansion: "collapsed",
        },
      }),
    },
    sessions: {
      open: async () => false,
      create:
        overrides.create ??
        (async () => {
          throw new Error("not used");
        }),
      createDraft: async () => {
        throw new Error("not used");
      },
      sendMessage: async () => "turn",
      compact: async () => undefined,
      scheduleMessage: async () => {
        throw new Error("not used");
      },
      listScheduledMessages: async () => [],
      cancelScheduledMessage: async () => undefined,
      listPendingMessages: async () => ({ steering: [], followUp: [] }),
      dequeuePendingMessages: async () => ({ steering: [], followUp: [] }),
      abort: async () => undefined,
      rename: async () => undefined,
      setResolved: async () => undefined,
      setProjectSessionsResolved: async () => 0,
      setCakeChatSessionsResolved: async () => 0,
      setModel: async () => undefined,
    },
    presentation: {
      splitView: () => undefined,
      showNotification: async () => undefined,
      showAgentAction: () => undefined,
    },
  };
}

function mountStore(input: {
  host?: AppControlHost;
  requests?: CakeChatControlRequest[];
  openProjectChildSession?: (sessionId: string) => Promise<JsonValue>;
  respondProject?: ReturnType<typeof vi.fn>;
  respondCake?: ReturnType<typeof vi.fn>;
}) {
  const requests = observable(input.requests ?? []);
  const respondProject = input.respondProject ?? vi.fn(async () => undefined);
  const respondCake = input.respondCake ?? vi.fn(async () => undefined);
  const reportProjectError = vi.fn();
  const reportCakeChatError = vi.fn();
  const client = {
    projectSessions: { respondControl: respondProject },
    cakeChats: { respondControl: respondCake },
  } as unknown as Pick<Client, "cakeChats" | "projectSessions">;
  const store = mount(
    createStore(ApplicationControlStore, {
      client,
      host: input.host ?? createHost(),
      operations: {
        start: () => "00000000-0000-4000-8000-000000000000",
        finish: () => undefined,
      },
      cakeChatRequests: () => requests,
      projectContext: (sessionId) => ({
        source: { kind: "project-session", sessionId, title: "Project session" },
      }),
      forkProjectSession: async () => ({ ok: true, sessionId: "forked" }),
      openProjectChildSession:
        input.openProjectChildSession ?? (async () => ({ ok: true, childSessionId: "child" })),
      reportProjectError,
      reportCakeChatError,
    }),
  );
  return { store, requests, respondProject, respondCake, reportProjectError, reportCakeChatError };
}

const projectRequest = (controlRequestId: string) => ({
  sessionId: "project-session",
  controlRequestId,
  invocation: { _tag: "InvokeAppControl" as const, command: "app.state", input: {} },
});

describe("ApplicationControlStore", () => {
  it("deduplicates an active Project Session request and delivers one successful response", async () => {
    const delivery = deferred<void>();
    const respondProject = vi.fn(() => delivery.promise);
    const { store } = mountStore({ respondProject });
    const request = projectRequest("00000000-0000-4000-8000-000000000001");

    const first = store.handleProjectSessionRequest(request);
    await vi.waitFor(() => expect(respondProject).toHaveBeenCalledOnce());
    await store.handleProjectSessionRequest(request);
    expect(respondProject).toHaveBeenCalledWith(
      "project-session",
      request.controlRequestId,
      expect.objectContaining({ ok: true, name: "get_app_state" }),
      expect.any(Object),
    );

    delivery.resolve();
    await first;
    store[Symbol.dispose]();
  });

  it("returns invocation errors and child-family success or failure without repeating work", async () => {
    const openProjectChildSession = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, childSessionId: "child-1", paneId: "pane-2" })
      .mockRejectedValueOnce(new Error("child failed"));
    const { store, respondProject } = mountStore({ openProjectChildSession });
    const child = (id: string, childSessionId: string) => ({
      sessionId: "parent",
      controlRequestId: id,
      invocation: {
        _tag: "ProjectChildSession" as const,
        childSessionId,
        title: "Child",
        familyId: "family",
        familyChildOrder: 0,
        placement: "right" as const,
      },
    });

    const first = child("00000000-0000-4000-8000-000000000002", "child-1");
    await store.handleProjectSessionRequest(first);
    await store.handleProjectSessionRequest(first);
    await store.handleProjectSessionRequest(
      child("00000000-0000-4000-8000-000000000003", "child-2"),
    );
    await store.handleProjectSessionRequest({
      sessionId: "parent",
      controlRequestId: "00000000-0000-4000-8000-000000000004",
      invocation: { _tag: "InvokeAppControl", command: "sessions.open", input: {} },
    });

    expect(openProjectChildSession).toHaveBeenCalledTimes(2);
    expect(respondProject.mock.calls[0]?.[2]).toMatchObject({
      ok: true,
      childSessionId: "child-1",
    });
    expect(respondProject.mock.calls[1]?.[2]).toEqual({ ok: false, error: "child failed" });
    expect(respondProject.mock.calls[2]?.[2]).toMatchObject({
      ok: false,
      name: "sessions.open",
    });
    store[Symbol.dispose]();
  });

  it("consumes projected Cake Chat requests once and reports response-delivery errors", async () => {
    const respondCake = vi.fn(async () => {
      throw new Error("request expired");
    });
    const { store, requests, reportCakeChatError } = mountStore({
      host: createHost({
        cakeChatSessions: () => [
          {
            sessionId: "cake-chat",
            title: "Planner",
            resolved: false,
            createdAt: "2026-01-01T00:00:00.000Z",
            modifiedAt: "2026-01-01T00:00:00.000Z",
            messageCount: 0,
          },
        ],
      }),
      respondCake,
    });
    const request: CakeChatControlRequest = {
      _tag: "ControlRequested",
      sessionId: "cake-chat",
      controlRequestId: "00000000-0000-4000-8000-000000000005",
      invocation: { name: "app.state", arguments: {} },
    };

    requests.push(request, request);
    await vi.waitFor(() => expect(respondCake).toHaveBeenCalledOnce());
    expect(respondCake).toHaveBeenCalledWith(
      request.controlRequestId,
      expect.objectContaining({ ok: true, name: "get_app_state" }),
      expect.any(Object),
    );
    await vi.waitFor(() =>
      expect(reportCakeChatError).toHaveBeenCalledWith(
        expect.any(Error),
        "Cake Chat control response: app.state",
      ),
    );
    store[Symbol.dispose]();
  });

  it("does not deliver or report work that settles after disposal", async () => {
    const creation = deferred<{ workspacePath: string; sessionId: string }>();
    const host = createHost({
      projects: () => [
        {
          path: "/project",
          name: "Project",
          addedAt: "2026-01-01T00:00:00.000Z",
          lastOpenedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      create: () => creation.promise,
    });
    const { store, respondProject, reportProjectError } = mountStore({ host });
    const pending = store.handleProjectSessionRequest({
      sessionId: "project-session",
      controlRequestId: "00000000-0000-4000-8000-000000000006",
      invocation: {
        _tag: "InvokeAppControl",
        command: "sessions.create",
        input: { workspacePath: "/project", name: "Child", initialPrompt: "Start" },
      },
    });

    store[Symbol.dispose]();
    creation.resolve({ workspacePath: "/project", sessionId: "created" });
    await pending;

    expect(respondProject).not.toHaveBeenCalled();
    expect(reportProjectError).not.toHaveBeenCalled();
  });
});

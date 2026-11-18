/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Stream } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { DiscussionSessionError } from "../../../../src/contracts/discussion-sessions/discussion-session-data";
import type { CakeIpcClientService } from "../../../../src/ipc/client/CakeIpcClient";
import { ToastHost } from "../../../../src/renderer/components/toast-host";
import { observeModels } from "../../../../src/renderer/observers/models";
import { createRendererStoreFixture } from "../renderer-store-fixture";
import { projectRecord, sessionSummary } from "../fixtures/catalog-fixtures";
import { observerClient, observerRuntime } from "./observer-test-runtime";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it.each(["retry", "expire"])("can %s a stopped observation toast", async (mode) => {
  const observe = vi
    .fn<CakeIpcClientService["discussionSessions"]["observe"]>()
    .mockReturnValueOnce(
      Stream.fail(
        new DiscussionSessionError({
          operation: "observe",
          message: "That session is no longer available",
        }),
      ),
    )
    .mockReturnValue(Stream.never);
  const runtime = observerRuntime(
    observerClient({
      projects: { observeCatalog: () => Stream.never },
      automations: { observe: () => Stream.never },
      managedWorktrees: {
        observeCatalog: () => Stream.never,
        observeOperations: () => Stream.never,
      },
      projectSessions: { observeCatalog: () => Stream.never, observeSignals: () => Stream.never },
      cakeChats: {
        observeCatalog: () => Stream.never,
        observeSideChats: () => Stream.never,
        observeControls: () => Stream.never,
        observeSideChatMetadata: () => Stream.never,
      },
      conversations: { observe: () => Stream.never },
      discussionSessions: {
        observeMetadata: () => Stream.never,
        observe,
        observeCatalog: () =>
          Stream.make({
            _tag: "Snapshot",
            revision: 1,
            parentSessionId: "parent",
            threads: [
              {
                id: "thread-1",
                parentSessionId: "parent",
                workingDirectory: "/project",
                sidecarSessionId: "sidecar-1",
                anchor: {
                  path: "session:parent",
                  view: "session",
                  start: { diffLine: 0 },
                  end: { diffLine: 0 },
                  selectedText: "",
                  contextBefore: "",
                  contextAfter: "",
                  diff: "",
                },
                parts: [],
                status: "open",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          }).pipe(Stream.concat(Stream.never)),
      },
      subagents: { observe: () => Stream.never, observeMetadata: () => Stream.never },
      scheduledMessages: { observe: () => Stream.never },
    }),
  );
  using fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project" })],
    sessions: [sessionSummary({ sessionId: "parent", projectPath: "/project" })],
  });
  const parent = fixture.root.sessionRegistry.load("parent", "/project");
  const view = render(<ToastHost store={fixture.root.toastStore} />);
  const stop = observeModels(runtime, fixture.models, fixture.root);
  const user = userEvent.setup();
  try {
    await waitFor(() => expect(parent.props.discussionCatalog.threads).toHaveLength(1));
    expect(observe).not.toHaveBeenCalled();
    if (mode === "expire") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => {
      parent.openSideChat("thread-1");
      await vi.waitFor(() =>
        expect(fixture.root.toastStore.toasts[0]?.title).toBe("Updates stopped"),
      );
    });
    expect(screen.getByText("Updates stopped")).toBeDefined();
    expect(screen.getByText("That session is no longer available")).toBeDefined();
    expect(observe).toHaveBeenCalledOnce();
    if (mode === "expire") {
      act(() => vi.advanceTimersByTime(20_000));
      expect(screen.queryByText("Updates stopped")).toBeNull();
      expect(observe).toHaveBeenCalledOnce();
      // The failed open still has status and Retry on its owning pane.
      const pending = parent.conversationSessionStore.sideChatStore.target?.pending;
      expect(pending?.message()).toContain("That session is no longer available");
      expect(pending?.retry).toBeDefined();
      return;
    }
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(observe).toHaveBeenCalledTimes(2));
    expect(observe).toHaveBeenLastCalledWith({
      parentSessionId: "parent",
      threadId: "thread-1",
      workingDirectory: "/project",
    });
    expect(screen.queryByText("Updates stopped")).toBeNull();
  } finally {
    view.unmount();
    stop();
    await runtime.dispose();
  }
});

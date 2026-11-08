/** @vitest-environment jsdom */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { StartupTimingProbe } from "../../../src/renderer/components/startup-timing-probe";
import { rendererStartupTiming } from "../../../src/renderer/lib/startup-timing";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";

vi.mock("../../../src/renderer/lib/startup-timing", () => ({ rendererStartupTiming: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function fixture(withComposer = false) {
  const f = createRendererStoreFixture({
    projects: [projectRecord({ path: "/cake" })],
    sessions: [sessionSummary({ sessionId: "restored", projectPath: "/cake" })],
  });
  const session = f.root.sessionRegistry.load("restored", "/cake");
  f.root.navigationStore.selectProjectSession("restored");
  f.root.projectWorkbenchStore.showLoadedSession("restored");
  f.root.sessionLayoutStore.ensureSession("restored");
  const view = render(
    <StrictMode>
      <StartupTimingProbe rootStore={f.root}>
        <div>Committed child</div>
        {withComposer && (
          <textarea
            data-dictation-submission-owner={session.conversationSessionStore.chatStore.id}
          />
        )}
      </StartupTimingProbe>
    </StrictMode>,
  );
  return {
    ...f,
    model: f.models.projectConversation("restored", "/cake"),
    [Symbol.dispose]() {
      view.unmount();
      f[Symbol.dispose]();
    },
  };
}

it("separates first commit from a committed live selected-chat projection and reports once", async () => {
  using f = fixture();
  expect(rendererStartupTiming).toHaveBeenCalledWith("first-commit");
  expect(rendererStartupTiming).not.toHaveBeenCalledWith("selected-chat-projection-commit");
  await act(async () => {
    f.model.historyOnly = true;
    f.model.observedSnapshotRevision = 1;
  });
  expect(rendererStartupTiming).not.toHaveBeenCalledWith("selected-chat-projection-commit");
  await act(async () => {
    f.model.historyOnly = false;
    f.model.observationError = "failed";
  });
  expect(rendererStartupTiming).not.toHaveBeenCalledWith("selected-chat-projection-commit");
  await act(async () => {
    f.model.observationError = undefined;
  });
  expect(rendererStartupTiming).toHaveBeenCalledWith("selected-chat-projection-commit");
  await act(async () => {
    f.model.observedSnapshotRevision = 2;
  });
  expect(
    vi
      .mocked(rendererStartupTiming)
      .mock.calls.filter(([phase]) => phase === "selected-chat-projection-commit"),
  ).toHaveLength(1);
});

it("reports the selected editable composer before live transcript readiness, once under StrictMode", async () => {
  using f = fixture(true);
  expect(rendererStartupTiming).toHaveBeenCalledWith("selected-chat-composer-editable-commit");
  expect(rendererStartupTiming).not.toHaveBeenCalledWith("selected-chat-projection-commit");
  await act(async () => {
    f.model.observedSnapshotRevision = 1;
  });
  expect(
    vi
      .mocked(rendererStartupTiming)
      .mock.calls.filter(([phase]) => phase === "selected-chat-composer-editable-commit"),
  ).toHaveLength(1);
  expect(
    vi
      .mocked(rendererStartupTiming)
      .mock.calls.filter(([phase]) => phase === "selected-chat-projection-commit"),
  ).toHaveLength(1);
});

it("uses Chromium's buffered paint timestamp rather than observer receipt time and cleans up", () => {
  const disconnect = vi.fn();
  const observe = vi.fn();
  vi.stubGlobal(
    "PerformanceObserver",
    class {
      static supportedEntryTypes = ["paint"];
      constructor(
        readonly callback: (list: {
          getEntries(): Array<{ name: string; startTime: number }>;
        }) => void,
      ) {}
      observe(options: unknown) {
        observe(options);
        this.callback({ getEntries: () => [{ name: "first-contentful-paint", startTime: 123.4 }] });
      }
      disconnect = disconnect;
    },
  );
  const f = fixture();
  expect(rendererStartupTiming).toHaveBeenCalledWith("first-contentful-paint", 123.4);
  expect(observe).toHaveBeenCalledWith({ type: "paint", buffered: true });
  f[Symbol.dispose]();
  expect(disconnect).toHaveBeenCalled();
});

it("does not attribute a different selection's readiness to the initial selected chat", async () => {
  using f = fixture();
  await act(async () => {
    f.root.appShellStore.showSettings();
  });
  expect(rendererStartupTiming).toHaveBeenCalledWith("selected-chat-changed");
  await act(async () => {
    f.model.observedSnapshotRevision = 1;
  });
  expect(rendererStartupTiming).not.toHaveBeenCalledWith("selected-chat-projection-commit");
});

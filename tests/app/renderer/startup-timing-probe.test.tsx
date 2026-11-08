/** @vitest-environment jsdom */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StartupTimingProbe } from "../../../src/renderer/components/startup-timing-probe";
import { rendererStartupTiming } from "../../../src/renderer/lib/startup-timing";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";

vi.mock("../../../src/renderer/lib/startup-timing", () => ({ rendererStartupTiming: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function fixture() {
  const f = createRendererStoreFixture({
    projects: [projectRecord({ path: "/cake" })],
    sessions: [sessionSummary({ sessionId: "restored", projectPath: "/cake" })],
  });
  f.root.sessionRegistry.load("restored", "/cake");
  f.root.navigationStore.selectProjectSession("restored");
  f.root.projectWorkbenchStore.showLoadedSession("restored");
  f.root.sessionLayoutStore.ensureSession("restored");
  const view = render(
    <StartupTimingProbe rootStore={f.root}>
      <div>Committed child</div>
    </StartupTimingProbe>,
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

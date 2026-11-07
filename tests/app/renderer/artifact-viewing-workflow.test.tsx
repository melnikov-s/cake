/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it, vi } from "vitest";
import { ArtifactHost } from "../../../src/renderer/components/artifact-host";
import type { ArtifactRecord } from "../../../src/contracts/artifacts/artifact-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { artifactObserverWorkflowEvents } from "./artifact-observer-workflow-events";

const record = (id: string): ArtifactRecord => ({
  artifact: {
    protocol: "cake.artifact/v1",
    id,
    sessionId: "deleted-creator",
    revision: 1,
    kind: "markdown",
    title: id,
    payload: { markdown: `${id} document` },
    fallback: { markdown: id },
  },
  workspacePath: "/project",
  digest: "a".repeat(64),
  createdAt: "",
  updatedAt: "",
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("reports inline visibility only after viewport observation and removes it when scrolled away", async () => {
  let observeVisibility: (visible: boolean) => void = () => {
    throw new Error("Observer not mounted");
  };
  vi.stubGlobal(
    "IntersectionObserver",
    class implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = "0px";
      readonly scrollMargin = "0px";
      readonly thresholds = [0];
      private element: Element | undefined;
      constructor(callback: IntersectionObserverCallback) {
        observeVisibility = (isIntersecting) => {
          const target = this.element;
          if (!target) throw new Error("No observed artifact");
          const bounds = target.getBoundingClientRect();
          callback(
            [
              {
                target,
                isIntersecting,
                boundingClientRect: bounds,
                intersectionRect: bounds,
                intersectionRatio: isIntersecting ? 1 : 0,
                rootBounds: null,
                time: 0,
              },
            ],
            this,
          );
        };
      }
      observe(element: Element) {
        this.element = element;
      }
      unobserve() {
        this.element = undefined;
      }
      disconnect() {
        this.element = undefined;
      }
      takeRecords() {
        return [];
      }
    },
  );
  const reportViewing = vi.fn<Client["artifacts"]["reportViewing"]>(async () => {});
  using fixture = createRendererStoreFixture({ client: { artifacts: { reportViewing } } });
  const view = render(
    <StoreProvider store={fixture.root}>
      <ArtifactHost record={record("historical")} presentation="inline" />
    </StoreProvider>,
  );
  try {
    expect(reportViewing).not.toHaveBeenCalled();
    act(() => observeVisibility(true));
    await waitFor(() =>
      expect(reportViewing).toHaveBeenLastCalledWith(
        {
          navigation: expect.any(Object),
          visible: [{ lineageId: "historical", revision: 1, surface: "inline" }],
        },
        expect.anything(),
      ),
    );
    act(() => observeVisibility(false));
    await waitFor(() =>
      expect(reportViewing).toHaveBeenLastCalledWith(
        { navigation: expect.any(Object), visible: [] },
        expect.anything(),
      ),
    );
  } finally {
    view.unmount();
  }
});

it("reports visible and interacted artifacts, promotes fullscreen in the same window, republishes after reconnect and clears on close", async () => {
  const reportViewing = vi.fn<Client["artifacts"]["reportViewing"]>(async () => {});
  using fixture = createRendererStoreFixture({
    client: {
      artifacts: {
        reportViewing,
        catalog: async () => ({ items: [], offset: 0, limit: 50, total: 0, hasMore: false }),
      },
      electron: { setFullscreenSurfaceOpen: async () => {} },
    },
  });
  await using events = artifactObserverWorkflowEvents(fixture.root);
  const user = userEvent.setup();
  const view = render(
    <StoreProvider store={fixture.root}>
      <StoreProvider store={fixture.root.fullscreenSurfaceStore}>
        <ArtifactHost record={record("report")} presentation="inline" />
        <ArtifactHost record={record("appendix")} viewingSurface="library" />
      </StoreProvider>
    </StoreProvider>,
  );
  try {
    await waitFor(() =>
      expect(reportViewing).toHaveBeenLastCalledWith(
        {
          navigation: expect.any(Object),
          visible: [
            { lineageId: "report", revision: 1, surface: "inline" },
            { lineageId: "appendix", revision: 1, surface: "library" },
          ],
          active: { lineageId: "appendix", revision: 1, surface: "library" },
        },
        expect.anything(),
      ),
    );
    reportViewing.mockClear();
    await act(() => events.emit({ type: "renderer-events-ready", channel: "artifacts" }));
    await waitFor(() =>
      expect(reportViewing).toHaveBeenCalledWith(
        expect.objectContaining({
          active: { lineageId: "appendix", revision: 1, surface: "library" },
        }),
        expect.anything(),
      ),
    );
    await user.click(screen.getByText("report document"));
    await waitFor(() =>
      expect(reportViewing).toHaveBeenLastCalledWith(
        expect.objectContaining({
          active: { lineageId: "report", revision: 1, surface: "inline" },
        }),
        expect.anything(),
      ),
    );
    await user.click(screen.getByRole("button", { name: "View report fullscreen" }));
    await waitFor(() =>
      expect(reportViewing).toHaveBeenLastCalledWith(
        {
          navigation: expect.any(Object),
          visible: [{ lineageId: "report", revision: 1, surface: "fullscreen" }],
          active: { lineageId: "report", revision: 1, surface: "fullscreen" },
        },
        expect.anything(),
      ),
    );
    await user.click(screen.getByRole("button", { name: "Exit fullscreen report" }));
    await waitFor(() =>
      expect(reportViewing).toHaveBeenLastCalledWith(
        expect.objectContaining({
          visible: expect.arrayContaining([
            { lineageId: "appendix", revision: 1, surface: "library" },
          ]),
          active: { lineageId: "report", revision: 1, surface: "inline" },
        }),
        expect.anything(),
      ),
    );
  } finally {
    view.unmount();
  }
  await waitFor(() =>
    expect(reportViewing).toHaveBeenLastCalledWith(
      { navigation: expect.any(Object), visible: [] },
      expect.anything(),
    ),
  );
});

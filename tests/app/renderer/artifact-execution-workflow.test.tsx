/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime, Queue, Schema } from "effect";
import { artifactEventSchema } from "../../../src/contracts/application/cake-rpc-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArtifactDigest,
  decodeArtifactLineageId,
  decodeArtifactRevisionNumber,
  type ArtifactLineageDetail,
  type ArtifactRevision,
} from "../../../src/contracts/artifacts/artifact-lineage";
import { ArtifactRuntimeError } from "../../../src/contracts/artifacts/artifact-runtime";
import * as artifacts from "../../../src/domain/artifacts/globalArtifacts";
import * as schedules from "../../../src/domain/automations/artifactSchedules";
import { ArtifactRuntime } from "../../../src/services/artifact-runtime/ArtifactRuntime";
import { ArtifactViewsLive } from "../../../src/services/artifacts/ArtifactViews";
import { AutomationRecords } from "../../../src/services/automations/AutomationRecords";
import {
  ClientConnections,
  ClientConnectionsLive,
} from "../../../src/services/clients/ClientConnections";
import { ClientEvents } from "../../../src/services/clients/ClientEvents";
import { ClientEventsLive } from "../../../src/services/clients/ClientEventsLive";
import { ArtifactStorage } from "../../../src/services/storage/ArtifactStorage";
import {
  AutomationStorage,
  type AutomationLedger,
} from "../../../src/services/storage/AutomationStorage";
import { ArtifactLibrary } from "../../../src/renderer/components/artifact-library";
import { observeArtifactEvents } from "../../../src/renderer/observers/artifact-events";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { observerClient, observerRuntime } from "./observers/observer-test-runtime";

const lineageId = decodeArtifactLineageId("live-dashboard");
const revision: ArtifactRevision = {
  lineageId,
  metadata: {
    revision: decodeArtifactRevisionNumber(1),
    digest: Schema.decodeUnknownSync(ArtifactDigest)("a".repeat(64)),
    kind: "widget",
    publishedAt: "2026-01-01T00:00:00.000Z",
    publishedBySessionId: "deleted-creator",
    workingDirectory: "/project",
  },
  snapshot: {
    protocol: "cake.artifact/v1",
    id: lineageId,
    sessionId: "deleted-creator",
    revision: 1,
    kind: "widget",
    title: "Live dashboard",
    payload: {
      language: "html",
      source: "<p>Dashboard</p>",
      brief: "Dashboard",
      browser: { digest: "b".repeat(64) },
      runtime: { source: "return { tools: {} };", tools: [] },
    },
    fallback: { markdown: "Dashboard" },
  },
};
const detail: ArtifactLineageDetail = {
  lineage: {
    id: lineageId,
    global: true,
    title: "Live dashboard",
    createdAt: revision.metadata.publishedAt,
    latestRevision: revision.metadata.revision,
    latest: revision.metadata,
    stableRef: `cake://artifact/${lineageId}`,
  },
  links: [],
  stableRef: `cake://artifact/${lineageId}`,
};

/** Real domain authority -> focused backend channel -> observer -> selected Store -> UI.
 * Only runtime/process and persistence boundaries are faked. */
async function fixture(initiallyRunning = true) {
  let status = {
    lineageId,
    revision: 1,
    running: initiallyRunning,
    lastError: null as string | null,
  };
  let failNextStart = false;
  let ledger: AutomationLedger = {
    automations: [],
    occurrences: [],
    runs: [],
    artifactSchedules: [],
    pausedArtifactIds: [],
  };
  const backend = ManagedRuntime.make(
    Layer.mergeAll(
      ClientEventsLive,
      ClientConnectionsLive,
      ArtifactViewsLive.pipe(Layer.provide(ClientConnectionsLive)),
      Layer.mock(ArtifactStorage, { read: () => Effect.succeed(revision) }),
      AutomationRecords.layer.pipe(
        Layer.provide(
          Layer.succeed(AutomationStorage, {
            load: () => Effect.succeed(ledger),
            save: (value) =>
              Effect.sync(() => {
                ledger = value;
              }),
          }),
        ),
      ),
      Layer.mock(ArtifactRuntime, {
        status: () => Effect.sync(() => status),
        stop: () =>
          Effect.sync(() => {
            status = { ...status, running: false };
            return status;
          }),
        lifecycle: (input) =>
          Effect.gen(function* () {
            if (input.event === "start") {
              if (failNextStart) {
                failNextStart = false;
                status = { ...status, running: false, lastError: "Automatic startup failed" };
                return yield* new ArtifactRuntimeError({
                  operation: "start",
                  message: "Automatic startup failed",
                });
              }
              status = { ...status, running: true, lastError: null };
            }
            return status;
          }),
      }),
    ),
  );
  const connectionId = await backend.runPromise(
    Effect.gen(function* () {
      yield* (yield* AutomationRecords).initialize();
      return (yield* ClientConnections).desktop(37);
    }),
  );
  const runtimeStatus = vi.fn(async () => backend.runPromise(artifacts.executionStatus(lineageId)));
  const catalog = vi.fn(async () => ({
    items: [detail.lineage],
    offset: 0,
    limit: 50,
    total: 1,
    hasMore: false,
  }));
  const renderer = createRendererStoreFixture({
    client: {
      artifacts: {
        catalog,
        detail: async () => detail,
        history: async () => ({
          items: [revision.metadata],
          offset: 0,
          limit: 50,
          total: 1,
          hasMore: false,
        }),
        readExact: async () => revision,
        stateRead: async () => ({ lineageId, version: 0, value: null }),
        runtimeStatus,
      },
      inlineWidgets: {
        open: async () => ({
          token: "execution-view",
          url: "cake-widget://document/execution-view",
        }),
      },
    },
  });
  const events = await backend.runPromise(ClientEvents);
  const observer = observerRuntime(
    observerClient({ events: { artifacts: () => events.artifacts(connectionId) } }),
  );
  const stop = observeArtifactEvents(observer, renderer.root);
  const view = render(
    <ArtifactLibrary
      store={renderer.root.artifactLibraryStore}
      referencePreviews={renderer.root.artifactReferencePreviewStore}
      sessions={renderer.root.sessionCatalogStore}
      inlineWidgets={renderer.root.inlineWidgetStore}
    />,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /Live dashboard/ }));
  await screen.findByText(initiallyRunning ? "Running" : "Stopped");
  return {
    backend,
    renderer,
    catalog,
    runtimeStatus,
    connectionId,
    failStart() {
      failNextStart = true;
    },
    async invalidateUnselected() {
      const otherId = decodeArtifactLineageId("unselected");
      events.broadcast({ type: "artifact-execution-invalidated", lineageId: otherId });
      while (true) {
        const consumed = Schema.decodeUnknownSync(artifactEventSchema)(
          await Effect.runPromise(Queue.take(observer.consumed)),
        );
        if (consumed.type === "artifact-execution-invalidated" && consumed.lineageId === otherId)
          return;
      }
    },
    async [Symbol.asyncDispose]() {
      view.unmount();
      stop();
      await observer.dispose();
      renderer[Symbol.dispose]();
      await backend.dispose();
    },
  };
}

afterEach(cleanup);

describe("Live artifact execution projection", () => {
  it("projects agent pause/resume/start/restart through the focused event without refreshing the catalog", async () => {
    await using f = await fixture();
    const catalogCalls = f.catalog.mock.calls.length;
    await act(() =>
      f.backend.runPromise(artifacts.controlRuntime(lineageId, "pause", "actual-agent")),
    );
    await screen.findByText("Background paused");
    expect(screen.getByRole("button", { name: "Resume background" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Start runtime" })).toBeDefined();
    await act(() =>
      f.backend.runPromise(artifacts.controlRuntime(lineageId, "start", "other-view-agent")),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "Start runtime" })).toBeNull());
    expect(screen.getByText("Background paused")).toBeDefined();
    await act(() =>
      f.backend.runPromise(artifacts.controlRuntime(lineageId, "resume", "actual-agent")),
    );
    await screen.findByText("Running");
    expect(screen.getByRole("button", { name: "Pause background" })).toBeDefined();
    f.failStart();
    await act(async () => {
      await f.backend.runPromise(
        artifacts.controlRuntime(lineageId, "restart", "actual-agent").pipe(Effect.result),
      );
    });
    await screen.findByText("Automatic startup failed");
    await screen.findByText("Failed");
    await act(() =>
      f.backend.runPromise(artifacts.controlRuntime(lineageId, "restart", "actual-agent")),
    );
    await screen.findByText("Running");
    await waitFor(() => expect(screen.queryByText("Automatic startup failed")).toBeNull());
    expect(f.catalog).toHaveBeenCalledTimes(catalogCalls);
  });

  it("projects failed automatic first-view startup and later schedule edits without manual status refresh", async () => {
    await using f = await fixture(false);
    f.failStart();
    await act(() =>
      f.backend.runPromise(
        artifacts.reportViewing(f.connectionId, {
          visible: [{ lineageId, revision: revision.metadata.revision, surface: "library" }],
        }),
      ),
    );
    await screen.findByText("Automatic startup failed");
    await screen.findByText("Failed");
    await act(() =>
      f.backend.runPromise(
        schedules.configureArtifactSchedule({
          lineageId,
          name: "refresh",
          handler: "refresh",
          input: null,
          schedule: { _tag: "Interval", startsAt: "2026-01-01T00:00:00.000Z", everySeconds: 60 },
        }),
      ),
    );
    await waitFor(() =>
      expect(f.renderer.root.artifactLibraryStore.detailStore.execution?.schedules).toHaveLength(1),
    );
    // Arrange one persisted due occurrence without waiting on elapsed wall time.
    await f.backend.runPromise(
      Effect.gen(function* () {
        yield* (yield* AutomationRecords).transact((current) =>
          Effect.succeed({
            ledger: {
              ...current,
              artifactSchedules: current.artifactSchedules.map((item) => ({
                ...item,
                nextScheduledAt: "2000-01-01T00:00:00.000Z",
              })),
            },
            result: undefined,
          }),
        );
      }),
    );
    await act(() =>
      f.backend.runPromise(
        schedules.runArtifactSchedulePass(() => Effect.fail(new Error("Scheduled refresh failed"))),
      ),
    );
    await waitFor(() =>
      expect(
        f.renderer.root.artifactLibraryStore.detailStore.execution?.schedules[0],
      ).toMatchObject({ lastOutcome: "failed", lastError: "Scheduled refresh failed" }),
    );
    await act(() =>
      f.backend.runPromise(schedules.removeArtifactSchedule({ lineageId, name: "refresh" })),
    );
    await waitFor(() =>
      expect(f.renderer.root.artifactLibraryStore.detailStore.execution?.schedules).toHaveLength(0),
    );
    const reads = f.runtimeStatus.mock.calls.length;
    await act(() => f.invalidateUnselected());
    expect(f.runtimeStatus).toHaveBeenCalledTimes(reads);
  });
});

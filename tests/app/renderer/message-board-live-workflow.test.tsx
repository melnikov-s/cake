/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import * as boards from "../../../src/domain/artifacts/messageBoards";
import * as artifacts from "../../../src/domain/artifacts/artifactWorkflows";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { ArtifactLibrary } from "../../../src/renderer/components/artifact-library";
import { messageBoardHarness } from "../helpers/messageBoardHarness";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { messageBoardEvents } from "./message-board-event-fixture";
import type { TestClientOverrides } from "./test-client";
import type { ArtifactLineageId } from "../../../src/contracts/artifacts/artifact-lineage";

const family = {
  familyId: "family",
  parentSessionId: "parent",
  projectPath: "/project",
  workingDirectory: "/project",
  createdAt: "2026-01-01T00:00:00Z",
  children: [
    {
      sessionId: "child",
      parentSessionId: "parent",
      requestId: "child",
      workingDirectory: "/project",
      createdAt: "2026-01-01T00:00:00Z",
    },
  ],
};
const otherFamily = { ...family, familyId: "other", parentSessionId: "other-parent", children: [] };
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Deferred not initialized");
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function makeBackend(events: ReturnType<typeof messageBoardEvents>) {
  return ManagedRuntime.make(
    Layer.merge(
      Layer.merge(messageBoardHarness().layer, events.layer),
      Layer.mock(SessionFamilyStorage, {
        familyForMember: (id) => Effect.succeed(id === "other-parent" ? otherFamily : family),
        list: () => Effect.succeed([family, otherFamily]),
      }),
    ),
  );
}
async function setup(
  makeOverrides: (
    backend: ReturnType<typeof makeBackend>,
    boardId: ArtifactLineageId,
  ) => TestClientOverrides["artifacts"] = () => ({}),
) {
  const events = messageBoardEvents();
  const backend = makeBackend(events);
  const board = await backend.runPromise(boards.ensureBoard(family, "First board"));
  const otherBoard = await backend.runPromise(boards.ensureBoard(otherFamily, "Other board"));
  await backend.runPromise(
    boards.append("parent", {
      description: "First finding",
      body: "Stable evidence",
      audience: ["child"],
    }),
  );
  await backend.runPromise(
    boards.append("other-parent", { description: "Other finding", body: "Other evidence" }),
  );
  const fixture = createRendererStoreFixture({
    client: {
      artifacts: {
        catalog: (input) => backend.runPromise(artifacts.searchGlobalLineages(input)),
        detail: (id) => backend.runPromise(artifacts.lineageDetail(id)),
        history: (input) =>
          backend.runPromise(
            artifacts.paginatedHistory(input.lineageId, input.offset, input.limit),
          ),
        readExact: (id, revision) => backend.runPromise(artifacts.readExactRevision(id, revision)),
        boardEntries: (input) => backend.runPromise(boards.browse(input.lineageId, input)),
        boardBody: (input) =>
          backend.runPromise(boards.browseBody(input.lineageId, input.sequence)),
        boardReceipts: (input) =>
          backend.runPromise(boards.browseReceipts(input.lineageId, input.sequence)),
        ...makeOverrides(backend, board.lineageId),
      },
    },
  });
  const stopEvents = events.observe(fixture.root);
  const view = render(
    <ArtifactLibrary
      store={fixture.root.artifactLibraryStore}
      referencePreviews={fixture.root.artifactReferencePreviewStore}
      sessions={fixture.root.sessionCatalogStore}
      inlineWidgets={fixture.root.inlineWidgetStore}
    />,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /First board/ }));
  await screen.findByRole("button", { name: /^#1 · First finding$/ });
  return {
    backend,
    board,
    otherBoard,
    fixture,
    events,
    user,
    async dispose() {
      stopEvents();
      view.unmount();
      fixture[Symbol.dispose]();
      await events.dispose();
      await backend.dispose();
    },
  };
}
afterEach(cleanup);

describe("live Workboard workflow", () => {
  it("catches an invalidation during a page query, preserves expanded evidence and retries failed updates", async () => {
    const requested = deferred<void>();
    const release = deferred<void>();
    let hold = false;
    let fail = false;
    let queries = 0;
    const f = await setup((backend, boardId) => ({
      boardEntries: async (input) => {
        const page = await backend.runPromise(boards.browse(input.lineageId, input));
        if (!input.recent && input.lineageId === boardId) {
          queries += 1;
          if (fail) {
            fail = false;
            throw new Error("Board connection interrupted");
          }
          if (hold) {
            hold = false;
            requested.resolve();
            await release.promise;
          }
        }
        return page;
      },
    }));
    try {
      await f.user.click(screen.getByRole("button", { name: /^#1 · First finding$/ }));
      await screen.findByText("Stable evidence");
      hold = true;
      await act(() =>
        f.backend.runPromise(
          boards.append("child", { description: "Second finding", body: "Second evidence" }),
        ),
      );
      await requested.promise;
      await act(() =>
        f.backend.runPromise(
          boards.append("child", { description: "Third finding", body: "Third evidence" }),
        ),
      );
      await act(async () => release.resolve());
      await screen.findByRole("button", { name: /^#3 · Third finding$/ });
      expect(screen.getAllByRole("button", { name: /^#2 · Second finding$/ })).toHaveLength(1);
      expect(screen.getByText("Stable evidence")).toBeDefined();
      const before = queries;
      await act(() =>
        f.backend.runPromise(
          boards.append("other-parent", {
            description: "Unrelated change",
            body: "Other evidence",
          }),
        ),
      );
      // Observe completion of the unrelated preview query before checking isolation.
      await screen.findByText(/#2 · Unrelated change/);
      expect(queries).toBe(before);
      fail = true;
      await act(() =>
        f.backend.runPromise(
          boards.append("child", { description: "Fourth finding", body: "Fourth evidence" }),
        ),
      );
      await screen.findByText("Board connection interrupted");
      expect(screen.getByText("Stable evidence")).toBeDefined();
      await f.user.click(screen.getByRole("button", { name: "Retry board update" }));
      await screen.findByRole("button", { name: /^#4 · Fourth finding$/ });
      expect(screen.queryByText("Board connection interrupted")).toBeNull();
    } finally {
      release.resolve();
      await f.dispose();
    }
  });

  it("updates visible receipts without letting an older expansion response overwrite them", async () => {
    const requested = deferred<void>();
    const release = deferred<void>();
    let hold = true;
    const f = await setup((backend) => ({
      boardReceipts: async (input) => {
        const receipts = await backend.runPromise(
          boards.browseReceipts(input.lineageId, input.sequence),
        );
        if (hold) {
          hold = false;
          requested.resolve();
          await release.promise;
        }
        return receipts;
      },
    }));
    try {
      await f.user.click(screen.getByRole("button", { name: "Agent receipts for #1" }));
      await requested.promise;
      await act(() =>
        f.backend.runPromise(boards.recordIntake("child", f.board.lineageId, [1], "readAt")),
      );
      await waitFor(() =>
        expect(screen.getByText(/Notified: Not recorded · Read:/).textContent).not.toContain(
          "Read: Not recorded",
        ),
      );
      await act(async () => release.resolve());
      expect(screen.getByText(/Notified: Not recorded · Read:/).textContent).not.toContain(
        "Read: Not recorded",
      );
    } finally {
      release.resolve();
      await f.dispose();
    }
  });

  it("cancels old board work on switching and disposal and ignores late bodies/pages", async () => {
    const pageRequested = deferred<void>();
    const bodyRequested = deferred<void>();
    const releasePage = deferred<void>();
    const releaseBody = deferred<void>();
    let hold = false;
    let pageSignal: AbortSignal | undefined;
    let bodySignal: AbortSignal | undefined;
    const f = await setup((backend, boardId) => ({
      boardEntries: async (input, options) => {
        const page = await backend.runPromise(boards.browse(input.lineageId, input));
        if (hold && !input.recent && input.lineageId === boardId) {
          hold = false;
          pageSignal = options?.signal;
          pageRequested.resolve();
          await releasePage.promise;
        }
        return page;
      },
      boardBody: async (input, options) => {
        const body = await backend.runPromise(boards.browseBody(input.lineageId, input.sequence));
        bodySignal = options?.signal;
        bodyRequested.resolve();
        await releaseBody.promise;
        return body;
      },
    }));
    try {
      await f.user.click(screen.getByRole("button", { name: /^#1 · First finding$/ }));
      await bodyRequested.promise;
      hold = true;
      await act(() =>
        f.backend.runPromise(
          boards.append("child", { description: "Late old finding", body: "Old board evidence" }),
        ),
      );
      await pageRequested.promise;
      await f.user.click(screen.getByRole("button", { name: /Other board/ }));
      await screen.findByRole("button", { name: /^#1 · Other finding$/ });
      expect(pageSignal?.aborted).toBe(true);
      expect(bodySignal?.aborted).toBe(true);
      await act(async () => {
        releaseBody.resolve();
        releasePage.resolve();
      });
      expect(screen.queryByRole("button", { name: /^#2 · Late old finding$/ })).toBeNull();
      expect(screen.queryByText("Stable evidence")).toBeNull();
      // Start one more real body request and verify terminal owner cancellation.
      await f.user.click(screen.getByRole("button", { name: /^#1 · Other finding$/ }));
      await screen.findByText("Other evidence");
      f.fixture.root[Symbol.dispose]();
      expect(bodySignal?.aborted).toBe(true);
    } finally {
      releaseBody.resolve();
      releasePage.resolve();
      await f.dispose();
    }
  });
});

/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as boards from "../../../src/domain/artifacts/messageBoards";
import * as artifacts from "../../../src/domain/artifacts/artifactWorkflows";
import { MessageBoardStorage } from "../../../src/services/storage/MessageBoardStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { ArtifactLibrary } from "../../../src/renderer/components/artifact-library";
import { messageBoardHarness } from "../helpers/messageBoardHarness";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { sessionSummary } from "./fixtures/catalog-fixtures";

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
      workingDirectory: "/child-worktree",
      createdAt: "2026-01-01T00:00:00Z",
    },
  ],
};
afterEach(cleanup);

describe("message-board artifact workflow", () => {
  it.each(["parent", "unrelated"])(
    "opens a full-width Workboard from session %s, pages entries and expands bodies/receipts without changing agent readership",
    async (activeSessionId) => {
      const backend = ManagedRuntime.make(
        Layer.merge(
          messageBoardHarness().layer,
          Layer.mock(SessionFamilyStorage, {
            familyForMember: () => Effect.succeed(family),
            list: () => Effect.succeed([family]),
          }),
        ),
      );
      try {
        const board = await backend.runPromise(boards.ensureBoard(family));
        for (let sequence = 1; sequence <= 21; sequence += 1)
          await backend.runPromise(
            boards.append("parent", {
              description: `Finding ${sequence}`,
              body: `Evidence body ${sequence}`,
              ...(sequence === 1 ? { audience: ["child"] } : {}),
            }),
          );
        await backend.runPromise(boards.recordIntake("child", board.lineageId, [1], "notifiedAt"));
        const before = await backend.runPromise(
          Effect.flatMap(MessageBoardStorage, (storage) => storage.receipts(board.lineageId)),
        );
        const fixture = createRendererStoreFixture({
          sessions: [
            sessionSummary({ sessionId: "parent", projectPath: "/project", familyId: "family" }),
            sessionSummary({ sessionId: "unrelated", projectPath: "/project" }),
          ],
          client: {
            artifacts: {
              catalog: (input) => backend.runPromise(artifacts.searchGlobalLineages(input)),
              detail: (id) => backend.runPromise(artifacts.lineageDetail(id)),
              history: (input) =>
                backend.runPromise(
                  artifacts.paginatedHistory(input.lineageId, input.offset, input.limit),
                ),
              readExact: (id, revision) =>
                backend.runPromise(artifacts.readExactRevision(id, revision)),
              boardEntries: (input) => backend.runPromise(boards.browse(input.lineageId, input)),
              boardBody: (input) =>
                backend.runPromise(boards.browseBody(input.lineageId, input.sequence)),
              boardReceipts: (input) =>
                backend.runPromise(boards.browseReceipts(input.lineageId, input.sequence)),
            },
          },
        });
        fixture.root.artifactLibraryStore.open(activeSessionId);
        const view = render(
          <ArtifactLibrary
            store={fixture.root.artifactLibraryStore}
            referencePreviews={fixture.root.artifactReferencePreviewStore}
            sessions={fixture.root.sessionCatalogStore}
            inlineWidgets={fixture.root.inlineWidgetStore}
          />,
        );
        try {
          const user = userEvent.setup();
          await user.selectOptions(
            screen.getByRole("combobox", { name: "Filter artifacts by kind" }),
            "message-board",
          );
          await user.click(await screen.findByRole("button", { name: /Workboard/ }));
          await screen.findByRole("button", { name: /#1 · Finding 1/ });
          expect(screen.getByText("Append-only coordination log")).toBeDefined();
          expect(screen.queryByText("Shared with workgroup")).toBeNull();
          expect(
            within(screen.getByRole("main").parentElement!).queryByRole("complementary"),
          ).toBeNull();
          expect(screen.getByRole("button", { name: "Copy reference" })).toBeDefined();
          expect(screen.getByRole("button", { name: "Copy ID" })).toBeDefined();
          expect(screen.queryByRole("button", { name: /Unlink|Link to this/ })).toBeNull();
          expect(screen.queryByRole("combobox", { name: "Selected artifact revision" })).toBeNull();
          expect(screen.queryByText("Revision history")).toBeNull();
          expect(screen.queryByText(/Revision 1 of 1|Following latest|Pinned r/)).toBeNull();
          expect(
            screen.queryByRole("button", {
              name: /Copy exact revision reference|Copy readable path|Pin r|Follow latest|Compare with latest|Restore as new latest|Load older revisions/,
            }),
          ).toBeNull();
          const copy = vi.spyOn(navigator.clipboard, "writeText");
          await user.click(screen.getByRole("button", { name: "Copy reference" }));
          expect(copy).toHaveBeenCalledWith(`cake://artifact/${board.lineageId}`);
          await user.click(screen.getByRole("button", { name: "Copy ID" }));
          expect(copy).toHaveBeenLastCalledWith(board.lineageId);
          expect(screen.queryByText("Evidence body 1")).toBeNull();
          await user.click(screen.getByRole("button", { name: /#1 · Finding 1/ }));
          expect(await screen.findByText("Evidence body 1")).toBeDefined();
          await user.click(screen.getByRole("button", { name: "Agent receipts for #1" }));
          await screen.findByText(/Notified: .*Read: Not recorded/);
          expect(screen.queryByRole("button", { name: /^#21 · Finding 21/ })).toBeNull();
          await user.click(screen.getByRole("button", { name: "Load more entries" }));
          await screen.findByRole("button", { name: /^#21 · Finding 21/ });
          expect(
            await backend.runPromise(
              Effect.flatMap(MessageBoardStorage, (storage) => storage.receipts(board.lineageId)),
            ),
          ).toEqual(before);
          await backend.runPromise(
            boards.append("child", {
              description: "Integration unblocked",
              body: "Additional evidence",
            }),
          );
          await user.click(screen.getByRole("button", { name: /^Refresh$/ }));
          await waitFor(() =>
            expect(screen.getByRole("button", { name: "Load more entries" })).toBeDefined(),
          );
          await user.click(screen.getByRole("button", { name: "Load more entries" }));
          await screen.findByRole("button", { name: /^#22 · Integration unblocked/ });
        } finally {
          view.unmount();
          fixture[Symbol.dispose]();
        }
      } finally {
        await backend.dispose();
      }
    },
  );
});

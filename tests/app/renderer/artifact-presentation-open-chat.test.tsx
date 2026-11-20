/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import type { ArtifactRecord } from "../../../src/contracts/artifacts/artifact-contract";
import { ArtifactPresentationSurface } from "../../../src/renderer/components/artifact-presentation-surface";
import { createRendererStoreFixture } from "./renderer-store-fixture";

afterEach(cleanup);

it("opens the fullscreen artifact's chat on the Chat tab even after To-dos was the last tab", async () => {
  using fixture = createRendererStoreFixture({
    client: { electron: { setFullscreenSurfaceOpen: async () => undefined } },
  });
  fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID);
  // The Workspace pane last showed To-dos, which shares the companion's tab state.
  act(() => fixture.root.workspaceNavigatorStore.show("todos"));
  const record = {
    artifact: {
      id: "cake-s4-table",
      revision: 1,
      kind: "table",
      title: "S4 table",
      sessionId: CAKE_CHAT_SESSION_ID,
    },
  } as unknown as ArtifactRecord;
  const view = render(
    <StoreProvider store={fixture.root}>
      <StoreProvider store={fixture.root.fullscreenSurfaceStore}>
        <ArtifactPresentationSurface
          record={record}
          sessionId={CAKE_CHAT_SESSION_ID}
          onClose={() => undefined}
        >
          <p>Artifact body</p>
        </ArtifactPresentationSurface>
      </StoreProvider>
    </StoreProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Open chat" }));
  const tabs = screen.getByRole("group", { name: "Companion content" });
  expect(tabs.querySelector('button[aria-pressed="true"]')?.textContent).toBe("Chat");
  view.unmount();
});

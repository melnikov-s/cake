/** @vitest-environment jsdom */
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Effect, Layer, Queue } from "effect";
import { mount } from "effect-state-tree";
import { observer, StoreProvider, useStore } from "effect-state-tree/react";
import { expect, it } from "vitest";
import { CakeIpcClient } from "../../../src/ipc/client/CakeIpcClient";
import {
  SessionCatalogStore,
  SessionCatalogStoreFactory,
} from "../../../src/renderer/stores/SessionCatalogStore";
import { makeCatalogTestClient } from "./stores/catalog-test-client";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("reactively projects Session catalog indexes through the Effect Store facade", async () => {
  const controlled = await Effect.runPromise(makeCatalogTestClient());
  const handle = await Effect.runPromise(
    mount(SessionCatalogStoreFactory, {
      managedWorktrees: [],
      loading: true,
      revision: 0,
      sourceRevision: -1,
    }).pipe(Effect.provide(Layer.succeed(CakeIpcClient)(controlled.client))),
  );
  const View = observer(function View() {
    const store = useStore(SessionCatalogStore);
    return (
      <div>
        {store
          .projectSessions("/project")
          .map((session) => session.id)
          .join(",")}
      </div>
    );
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <StoreProvider stores={[[SessionCatalogStore, handle.instance]]}>
          <View />
        </StoreProvider>,
      );
      await Effect.runPromise(
        Queue.offer(controlled.sessionUpdates, {
          _tag: "Snapshot",
          revision: 1,
          sessions: [
            {
              sessionId: "first",
              title: "First",
              createdAt: "2026-08-01T00:00:00.000Z",
              modifiedAt: "2026-08-01T00:00:00.000Z",
              messageCount: 1,
              resolved: false,
              unread: false,
              projectPath: "/project",
              projectName: "Project",
              workingDirectory: "/project",
            },
          ],
        }),
      );
      await Effect.runPromise(handle.instance.awaitHydrated());
    });
    expect(container.textContent).toBe("first");
    await act(async () => {
      await Effect.runPromise(
        Queue.offer(controlled.sessionUpdates, {
          _tag: "Event",
          revision: 2,
          event: {
            _tag: "Upserted",
            session: {
              sessionId: "second",
              title: "Second",
              createdAt: "2026-08-02T00:00:00.000Z",
              modifiedAt: "2026-08-02T00:00:00.000Z",
              messageCount: 1,
              resolved: false,
              unread: false,
              projectPath: "/project",
              projectName: "Project",
              workingDirectory: "/project",
            },
          },
        }),
      );
      await Effect.runPromise(Effect.yieldNow);
    });
    expect(container.textContent).toBe("second,first");
  } finally {
    act(() => root.unmount());
    await Effect.runPromise(handle.dispose);
  }
});

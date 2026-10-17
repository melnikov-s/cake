import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoreProvider } from "r-state-tree/react";
import type {
  ArtifactRecord,
  CakeArtifactV1,
} from "../../../src/contracts/artifacts/artifact-contract";
import { ArtifactHost } from "../../../src/renderer/components/artifact-host";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

export const artifactBase = {
  protocol: "cake.artifact/v1" as const,
  id: "artifact",
  sessionId: "session",
  revision: 1,
  fallback: { markdown: "Readable fallback" },
  interaction: { mode: "present" as const },
};

export function renderArtifactHost(artifact: CakeArtifactV1, client: TestClientOverrides = {}) {
  const fixture = createRendererStoreFixture({
    client: {
      ...client,
      electron: { setFullscreenSurfaceOpen: async () => undefined, ...client.electron },
    },
  });
  const content = (value: CakeArtifactV1) => {
    const record: ArtifactRecord = {
      artifact: value,
      workspacePath: "/project",
      digest: "a".repeat(64),
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    return (
      <StoreProvider store={fixture.root}>
        <StoreProvider store={fixture.root.fullscreenSurfaceStore}>
          <ArtifactHost
            record={record}
            inlineWidgets={fixture.root.inlineWidgetStore}
            stateSessionId="viewer"
          />
        </StoreProvider>
      </StoreProvider>
    );
  };
  const view = render(content(artifact));
  return {
    ...view,
    user: userEvent.setup(),
    async update(value: CakeArtifactV1) {
      await act(async () => view.rerender(content(value)));
    },
    // Browser bootstrap invokes this exact transport lifecycle callback after a
    // backend reconnect. There is deliberately no product UI action for it.
    publishBackendReconnect() {
      act(() => fixture.root.inlineWidgetStore.backendReconnected());
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

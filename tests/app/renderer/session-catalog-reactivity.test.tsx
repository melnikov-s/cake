/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createStore, mount } from "r-state-tree";
import { observer } from "r-state-tree/react";
import { expect, it, vi } from "vitest";
import { SessionCatalogStore } from "../../../src/renderer/stores/SessionCatalogStore";

const summary = (id: string) => ({
  id,
  title: id,
  created: new Date(0).toISOString(),
  modified: new Date(0).toISOString(),
  messageCount: 1,
  resolved: false,
  workspacePath: "/project",
  workspaceName: "Project",
});

it("updates observed project indexes without mutating state during render", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const store = mount(createStore(SessionCatalogStore));
  store.replace([summary("first")]);
  const View = observer(() => (
    <div>
      {store
        .projectSessions("/project")
        .map((item) => item.id)
        .join(",")}
    </div>
  ));
  const container = document.createElement("div");
  const root = createRoot(container);

  try {
    await act(async () => root.render(<View />));
    expect(container.textContent).toBe("first");
    expect(consoleError).not.toHaveBeenCalled();

    await act(async () =>
      store.applyWorkspace("/project", "Project", [summary("first"), summary("second")]),
    );
    expect(container.textContent).toBe("first,second");
    expect(consoleError).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    store[Symbol.dispose]();
    consoleError.mockRestore();
  }
});

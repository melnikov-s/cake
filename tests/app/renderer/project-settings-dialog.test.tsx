/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { ProjectSettingsDialog } from "../../../src/renderer/components/project-settings-dialog";
import type { Client } from "../../../src/renderer/client/Client";
import { projectRecord } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

const projectPath = "/work/cake";

function renderProjectSettings(client: TestClientOverrides) {
  const rootFixture = createRendererStoreFixture({
    client,
    projects: [projectRecord({ path: projectPath, name: "Cake" })],
  });
  const store = rootFixture.root.projectSettingsStore;
  store.open(projectPath);
  const view = render(<ProjectSettingsDialog store={store} />);
  return {
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      rootFixture[Symbol.dispose]();
    },
  };
}

const setProjectSettings = () =>
  vi.fn<Client["workspaces"]["setProjectSettings"]>(async () => defaultApplicationState());

afterEach(cleanup);

describe("Project settings workflow", () => {
  it("saves edited personal instructions and closes the dialog", async () => {
    const save = setProjectSettings();
    using fixture = renderProjectSettings({ workspaces: { setProjectSettings: save } });

    const instructions = screen.getByRole("textbox", { name: "Custom instructions" });
    await fixture.user.clear(instructions);
    await fixture.user.type(instructions, "  Prefer incremental changes.  ");
    await fixture.user.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(save).toHaveBeenCalledWith(
      projectPath,
      expect.objectContaining({ customInstructions: "Prefer incremental changes." }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("shows a selected custom icon and persists it", async () => {
    const save = setProjectSettings();
    const chooseAttachments = vi.fn<Client["filesystem"]["chooseAttachments"]>(async () => [
      { kind: "image", name: "cake.png", mimeType: "image/png", data: "aWNvbg==" },
    ]);
    using fixture = renderProjectSettings({
      filesystem: { chooseAttachments },
      workspaces: { setProjectSettings: save },
    });

    await fixture.user.click(screen.getByRole("button", { name: "Choose icon…" }));
    expect(await screen.findByText("Custom icon")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(save).toHaveBeenCalledWith(
      projectPath,
      expect.objectContaining({ icon: { mimeType: "image/png", data: "aWNvbg==" } }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

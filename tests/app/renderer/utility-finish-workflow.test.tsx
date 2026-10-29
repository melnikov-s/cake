/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import { WorkbenchLanding } from "../../../src/renderer/components/workbench-landing";
import { createRendererStoreFixture } from "./renderer-store-fixture";

function renderUtilityFinishLanding(chooseProject: Client["electron"]["chooseProject"]) {
  const fixture = createRendererStoreFixture({ client: { electron: { chooseProject } } });
  const view = render(
    <StoreProvider store={fixture.root}>
      <WorkbenchLanding />
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

afterEach(cleanup);

// Error without context is covered by transcript-rendering-workflow's failed
// prompt. Here the real folder-opening workflow adds context to both a string
// failure and an Error without losing the original diagnostic or preventing retry.
it("shows, copies and dismisses folder-picker diagnostics and accepts another attempt", async () => {
  const failure = new Error("Folder permission denied");
  failure.stack = "Error: Folder permission denied\n    at chooseProject (desktop.ts:20:4)";
  const chooseProject = vi
    .fn<Client["electron"]["chooseProject"]>()
    .mockRejectedValueOnce("Folder picker unavailable")
    .mockRejectedValueOnce(failure);
  using fixture = renderUtilityFinishLanding(chooseProject);
  const copy = vi.spyOn(navigator.clipboard, "writeText");

  for (const [attempt, message, original] of [
    [1, "Folder picker unavailable", "Folder picker unavailable"],
    [2, failure.message, failure.stack],
  ] as const) {
    await fixture.user.click(screen.getByRole("button", { name: "Open project" }));
    const error = await screen.findByRole("alert");
    expect(within(error).getByText(message)).toBeDefined();
    await fixture.user.click(within(error).getByText("Technical details"));
    const details = `${original}\n\nContext:\nChoosing a project folder`;
    expect(error.querySelector("pre")?.textContent).toBe(details);
    await fixture.user.click(
      within(error).getByRole("button", { name: "Copy full error details" }),
    );
    expect(copy).toHaveBeenLastCalledWith(details);
    expect(chooseProject).toHaveBeenCalledTimes(attempt);
    expect(chooseProject).toHaveBeenLastCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await fixture.user.click(within(error).getByRole("button", { name: "Dismiss error" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  }
});

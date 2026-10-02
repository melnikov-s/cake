/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultApplicationState } from "../../../src/domain/application/application-data";
import type { Client } from "../../../src/renderer/client/Client";
import { SettingsPage } from "../../../src/renderer/components/settings-page";
import { createRendererStoreFixture } from "./renderer-store-fixture";

function renderInstructions(options: { failFirstSave?: boolean } = {}) {
  let revision = 1;
  const save = vi.fn<Client["workspaces"]["setGlobalCustomInstructions"]>(async (instructions) => {
    if (options.failFirstSave && save.mock.calls.length === 1) {
      throw new Error("Instructions could not be saved");
    }
    const state = { ...defaultApplicationState(), globalCustomInstructions: instructions };
    fixture.root.settingsStore.applyApplicationState(++revision, state);
    return state;
  });
  const fixture = createRendererStoreFixture({
    client: { workspaces: { setGlobalCustomInstructions: save } },
  });
  fixture.root.settingsStore.applyApplicationState(revision, {
    ...defaultApplicationState(),
    globalCustomInstructions: "Original preference",
  });
  fixture.root.settingsStore.selectPage("prompts");
  const view = render(<SettingsPage settings={fixture.root.settingsStore} />);
  return {
    user: userEvent.setup(),
    save,
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

function instructionsField() {
  return screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Global instructions" });
}

async function editInstructions(user: ReturnType<typeof userEvent.setup>, value: string) {
  await user.clear(instructionsField());
  await user.type(instructionsField(), value);
  await user.click(screen.getByRole("heading", { name: "Global custom instructions" }));
}

afterEach(cleanup);

describe("Global instructions workflow", () => {
  it("loads personal guidance, saves trimmed edits on blur, and resets it", async () => {
    using fixture = renderInstructions();
    expect(instructionsField().value).toBe("Original preference");

    await fixture.user.clear(instructionsField());
    await fixture.user.type(instructionsField(), "  Prefer incremental changes.  ");
    expect(fixture.save).not.toHaveBeenCalled();
    await fixture.user.click(screen.getByRole("heading", { name: "Global custom instructions" }));

    await waitFor(() => expect(instructionsField().value).toBe("Prefer incremental changes."));
    expect(fixture.save).toHaveBeenCalledWith(
      "Prefer incremental changes.",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    const section = screen.getByRole("region", { name: "Global custom instructions" });
    await fixture.user.click(within(section).getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(instructionsField().value).toBe(""));
    expect(fixture.save).toHaveBeenLastCalledWith(
      "",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(within(section).getByRole<HTMLButtonElement>("button", { name: "Reset" }).disabled).toBe(
      true,
    );
  });

  it("restores saved guidance and shows a save failure, then permits another edit", async () => {
    using fixture = renderInstructions({ failFirstSave: true });
    await editInstructions(fixture.user, "Unsaved preference");

    expect(await screen.findByText("Instructions could not be saved")).toBeDefined();
    await waitFor(() => expect(instructionsField().value).toBe("Original preference"));

    await editInstructions(fixture.user, "Replacement preference");
    await waitFor(() => expect(screen.queryByText("Instructions could not be saved")).toBeNull());
    expect(instructionsField().value).toBe("Replacement preference");
    expect(fixture.save).toHaveBeenLastCalledWith(
      "Replacement preference",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

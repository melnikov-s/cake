/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultApplicationState } from "../../../src/domain/application/application-data";
import { defaultCakePrompts } from "../../../src/domain/application/cake-prompts";
import type { Client } from "../../../src/renderer/client/Client";
import { SettingsPage } from "../../../src/renderer/components/settings-page";
import { createRendererStoreFixture } from "./renderer-store-fixture";

function renderPrompts(service: Client["workspaces"]["setCakePrompts"]) {
  let revision = 0;
  const setCakePrompts = vi.fn<Client["workspaces"]["setCakePrompts"]>(async (prompts, options) => {
    const state = await service(prompts, options);
    // Deliver the authoritative application projection, not just the RPC return value.
    fixture.root.settingsStore.applyApplicationState(++revision, state);
    return state;
  });
  const fixture = createRendererStoreFixture({ client: { workspaces: { setCakePrompts } } });
  fixture.root.settingsStore.applyApplicationState(revision, defaultApplicationState());
  fixture.root.settingsStore.selectPage("prompts");
  const view = render(<SettingsPage settings={fixture.root.settingsStore} />);
  return {
    user: userEvent.setup(),
    setCakePrompts,
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

afterEach(cleanup);

describe("Cake prompt settings workflow", () => {
  it("saves on blur, displays the authoritative prompt, and resets to the default", async () => {
    const draft = "Commit the worktree now.";
    const authoritative = "Commit the worktree now. Include a summary.";
    using fixture = renderPrompts(async (prompts) => ({
      ...defaultApplicationState(),
      cakePrompts: {
        ...prompts,
        worktreeCommit: prompts.worktreeCommit === draft ? authoritative : prompts.worktreeCommit,
      },
    }));
    const prompt = screen.getByRole("textbox", { name: "Commit before merge" });
    expect(
      screen.getByDisplayValue(defaultCakePrompts().worktreeCommit, {
        normalizer: (value) => value,
      }),
    ).toBe(prompt);
    await fixture.user.click(prompt);
    await fixture.user.tab();
    expect(fixture.setCakePrompts).not.toHaveBeenCalled();

    await fixture.user.clear(prompt);
    await fixture.user.type(prompt, draft);
    expect(fixture.setCakePrompts).not.toHaveBeenCalled();
    await fixture.user.tab();

    expect(await screen.findByDisplayValue(authoritative)).toBe(prompt);
    expect(fixture.setCakePrompts).toHaveBeenCalledWith(
      { ...defaultCakePrompts(), worktreeCommit: draft },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const reset = within(screen.getByRole("region", { name: "Worktree automation" })).getAllByRole(
      "button",
      { name: "Reset" },
    )[0]!;
    await fixture.user.click(reset);
    await waitFor(() => expect(fixture.setCakePrompts).toHaveBeenCalledTimes(2));
    expect(fixture.setCakePrompts).toHaveBeenLastCalledWith(
      defaultCakePrompts(),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(
      await screen.findByDisplayValue(defaultCakePrompts().worktreeCommit, {
        normalizer: (value) => value,
      }),
    ).toBe(prompt);
    expect(reset.hasAttribute("disabled")).toBe(true);
  });

  it("shows a failed save, restores the persisted prompt, and allows another edit", async () => {
    let fail = true;
    using fixture = renderPrompts(async (prompts) => {
      if (fail) {
        fail = false;
        throw new Error("Prompt could not be saved");
      }
      return { ...defaultApplicationState(), cakePrompts: prompts };
    });
    const prompt = screen.getByRole("textbox", { name: "Commit before merge" });
    await fixture.user.clear(prompt);
    await fixture.user.type(prompt, "Unsaved prompt");
    await fixture.user.tab();
    expect(await screen.findByText("Prompt could not be saved")).toBeDefined();
    expect(
      await screen.findByDisplayValue(defaultCakePrompts().worktreeCommit, {
        normalizer: (value) => value,
      }),
    ).toBe(prompt);

    await fixture.user.clear(prompt);
    await fixture.user.type(prompt, "Try this prompt instead.");
    await fixture.user.tab();
    await waitFor(() => expect(fixture.setCakePrompts).toHaveBeenCalledTimes(2));
    expect(fixture.setCakePrompts).toHaveBeenLastCalledWith(
      { ...defaultCakePrompts(), worktreeCommit: "Try this prompt instead." },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByDisplayValue("Try this prompt instead.")).toBe(prompt);
    await waitFor(() => expect(screen.queryByText("Prompt could not be saved")).toBeNull());
  });
});

/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultApplicationState,
  type ApplicationState,
} from "../../../src/domain/application/application-data";
import type { ModelOption, UtilityModel } from "../../../src/ipc/session-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { SettingsPage } from "../../../src/renderer/components/settings-page";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const models: ModelOption[] = ["Quick", "Careful", "Remote"].map((name) => ({
  provider: "openai",
  providerName: "OpenAI",
  id: name.toLowerCase(),
  name,
  reasoning: true,
  availableThinkingLevels: ["off", "low", "high"],
  input: ["text"],
  authenticated: true,
  available: true,
  authTypes: ["api_key"],
}));
const saved: UtilityModel = { provider: "openai", modelId: "quick", thinkingLevel: "low" };
function applicationState(utilityModel?: UtilityModel): ApplicationState {
  return { ...defaultApplicationState(), utilityModel };
}
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function renderSettings(
  setUtilityModel: Client["workspaces"]["setUtilityModel"],
  initial: UtilityModel | undefined = saved,
) {
  const fixture = createRendererStoreFixture({
    client: {
      workspaces: { setUtilityModel },
      models: { list: async () => models, refresh: async () => undefined },
    },
  });
  fixture.root.settingsStore.applyApplicationState(0, applicationState(initial));
  await fixture.root.settingsStore.providers.refreshModels();
  const view = render(<SettingsPage settings={fixture.root.settingsStore} />);
  return {
    user: userEvent.setup(),
    async publish(revision: number, model: UtilityModel) {
      await act(async () => {
        fixture.root.settingsStore.applyApplicationState(revision, applicationState(model));
      });
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
function selection() {
  return screen.getByRole("button", { name: "Utility model" });
}
async function choose(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(selection());
  const change = screen.queryByRole("button", { name: "Change model" });
  if (change) await user.click(change);
  await user.click(screen.getByRole("button", { name: new RegExp(name) }));
  await user.click(screen.getByRole("button", { name: "Apply" }));
}
afterEach(cleanup);

describe("Utility model settings workflow", () => {
  it("serializes model, reasoning, and clear saves while showing the latest choice", async () => {
    const first = deferred<ApplicationState>();
    const second = deferred<ApplicationState>();
    const save = vi
      .fn<Client["workspaces"]["setUtilityModel"]>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockImplementation(async (model) => applicationState(model));
    using fixture = await renderSettings(save);

    await choose(fixture.user, "Careful");
    expect(selection().textContent).toContain("Careful");
    await fixture.user.click(selection());
    await fixture.user.click(screen.getByRole("button", { name: "High" }));
    expect(selection().textContent).toContain("High");
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenNthCalledWith(
      1,
      { provider: "openai", modelId: "careful", thinkingLevel: "off" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    await act(async () => first.resolve(applicationState(saved)));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(selection().textContent).toContain("High");
    expect(save).toHaveBeenNthCalledWith(
      2,
      { provider: "openai", modelId: "careful", thinkingLevel: "high" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await fixture.user.click(selection());
    await fixture.user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(selection().textContent).toContain("No utility model");
    expect(save).toHaveBeenCalledTimes(2);
    await act(async () => second.resolve(applicationState(saved)));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(3));
    expect(save).toHaveBeenLastCalledWith(
      undefined,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(selection().textContent).toContain("No utility model");
  });

  it("keeps the local pending selection visible, then adopts the newer application event, ignoring stale revisions", async () => {
    const pending = deferred<ApplicationState>();
    const save = vi.fn<Client["workspaces"]["setUtilityModel"]>(() => pending.promise);
    using fixture = await renderSettings(save);
    await choose(fixture.user, "Careful");
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    const remote = { ...saved, modelId: "remote", thinkingLevel: "off" as const };
    await fixture.publish(2, remote);
    expect(selection().textContent).toContain("Careful");
    await act(async () => pending.resolve(applicationState({ ...saved, modelId: "careful" })));
    await waitFor(() => expect(selection().textContent).toContain("Remote"));
    await fixture.publish(1, saved);
    await fixture.publish(2, { ...saved, modelId: "careful" });
    expect(selection().textContent).toContain("Remote");
    expect(save).toHaveBeenCalledOnce();
  });

  it("restores the saved selection after a failed clear and lets the user retry", async () => {
    const pending = deferred<ApplicationState>();
    const save = vi
      .fn<Client["workspaces"]["setUtilityModel"]>()
      .mockReturnValueOnce(pending.promise)
      .mockImplementation(async (model) => applicationState(model));
    using fixture = await renderSettings(save);
    await fixture.user.click(selection());
    await fixture.user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(selection().textContent).toContain("No utility model");
    await act(async () => pending.reject(new Error("Utility model save failed")));
    await screen.findByText("Utility model save failed");
    expect(selection().textContent).toContain("Quick");
    await fixture.user.click(selection());
    await fixture.user.click(screen.getByRole("button", { name: "Clear selection" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(selection().textContent).toContain("No utility model");
    expect(screen.queryByText("Utility model save failed")).toBeNull();
  });

  it("aborts the pending service request when the settings owner is disposed", async () => {
    const pending = deferred<ApplicationState>();
    const save = vi.fn<Client["workspaces"]["setUtilityModel"]>(() => pending.promise);
    const fixture = await renderSettings(save);
    try {
      await choose(fixture.user, "Careful");
      await waitFor(() => expect(save).toHaveBeenCalledOnce());
    } finally {
      fixture[Symbol.dispose]();
    }
    expect(save.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await act(async () => pending.resolve(applicationState({ ...saved, modelId: "remote" })));
    expect(save).toHaveBeenCalledOnce();
  });
});

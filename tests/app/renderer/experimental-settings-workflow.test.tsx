/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, SubscriptionRef } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import {
  defaultApplicationState,
  type RendererApplicationProjection,
} from "../../../src/contracts/application/application-data";
import { CakeIpcClient, type CakeIpcClientService } from "../../../src/ipc/client/CakeIpcClient";
import type { Client } from "../../../src/renderer/client/Client";
import { SettingsPage } from "../../../src/renderer/components/settings-page";
import { observeApplicationState } from "../../../src/renderer/observers/application-state";
import { observeStream } from "../../../src/renderer/observers/observe-stream";
import type { Runtime } from "../../../src/renderer/runtime";
import { createRendererStoreFixture } from "./renderer-store-fixture";

afterEach(cleanup);

function setup(saveFailure = false) {
  const projections = Effect.runSync(
    SubscriptionRef.make<RendererApplicationProjection>({
      revision: 0,
      state: defaultApplicationState(),
    }),
  );
  const save = vi.fn<Client["application"]["setExperimentalFeatures"]>(async ({ features }) => {
    if (saveFailure) throw new Error("Could not persist experimental settings");
    const previous = Effect.runSync(SubscriptionRef.get(projections));
    const state = { ...previous.state, experimentalFeatures: features };
    await Effect.runPromise(
      SubscriptionRef.set(projections, { revision: previous.revision + 1, state }),
    );
    return state;
  });
  const fixture = createRendererStoreFixture({
    client: { application: { setExperimentalFeatures: save } },
  });
  const application = { observeState: () => SubscriptionRef.changes(projections) } satisfies Pick<
    CakeIpcClientService["application"],
    "observeState"
  >;
  // The observation adapter uses only this typed external boundary in this fixture.
  const client = { application } as unknown as CakeIpcClientService;
  const execute: Runtime["execute"] = (effect, signal) =>
    Effect.runPromise(
      Effect.provideService(effect, CakeIpcClient, client),
      signal ? { signal } : undefined,
    );
  const cancel = observeApplicationState(
    {
      execute,
      observe: (source, consume, options) => observeStream(execute, source, consume, options),
      dispose: async () => undefined,
    },
    fixture.root,
  );
  const view = render(<SettingsPage settings={fixture.root.settingsStore} />);
  return {
    ...fixture,
    save,
    projections,
    user: userEvent.setup(),
    [Symbol.dispose]() {
      cancel();
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

it("enables and disables the default-off experiment from Settings using authoritative observations", async () => {
  using f = setup();
  await f.user.click(screen.getByRole("button", { name: /^Experimental/ }));
  const toggle = screen.getByRole("switch", { name: "Dynamic workflows" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await f.user.click(toggle);
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  expect(f.save).toHaveBeenLastCalledWith(
    { features: { dynamicWorkflows: true } },
    expect.anything(),
  );
  await waitFor(() => expect(toggle).not.toHaveProperty("disabled", true));
  await f.user.click(toggle);
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  expect(f.save).toHaveBeenLastCalledWith(
    { features: { dynamicWorkflows: false } },
    expect.anything(),
  );
  // An older observation cannot resurrect an enabled feature.
  await act(async () => {
    await Effect.runPromise(
      SubscriptionRef.set(f.projections, {
        revision: 1,
        state: { ...defaultApplicationState(), experimentalFeatures: { dynamicWorkflows: true } },
      }),
    );
  });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
});

it("keeps a failed enable off and exposes the persistence error in Settings", async () => {
  using f = setup(true);
  await f.user.click(screen.getByRole("button", { name: /^Experimental/ }));
  const toggle = screen.getByRole("switch", { name: "Dynamic workflows" });
  await f.user.click(toggle);
  expect(await screen.findByText("Could not persist experimental settings")).toBeDefined();
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await waitFor(() => expect(toggle).not.toHaveProperty("disabled", true));
  expect(f.save).toHaveBeenCalledTimes(1);
});

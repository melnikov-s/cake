/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultApplicationState,
  type SessionLabel,
} from "../../../src/domain/application/application-data";
import type { Client } from "../../../src/renderer/client/Client";
import { LabelSettings } from "../../../src/renderer/components/label-settings";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const feature: SessionLabel = { id: "feature", name: "Feature", color: "sky" };

function renderLabels(
  labels: readonly SessionLabel[],
  service: Client["projectWorkflow"]["mutateGlobal"],
) {
  let revision = 0;
  const mutateGlobal = vi.fn<Client["projectWorkflow"]["mutateGlobal"]>(async (input, options) => {
    const updated = await service(input, options);
    // Simulate the authoritative application snapshot delivered after a successful mutation.
    rootFixture.root.settingsStore.applyApplicationState(++revision, {
      ...defaultApplicationState(),
      globalSessionLabels: updated,
    });
    return updated;
  });
  const rootFixture = createRendererStoreFixture({
    client: { projectWorkflow: { mutateGlobal } },
  });
  rootFixture.root.settingsStore.applyApplicationState(revision, {
    ...defaultApplicationState(),
    globalSessionLabels: [...labels],
  });
  const view = render(
    <LabelSettings
      store={rootFixture.root.settingsStore.globalLabels}
      title="Global labels"
      description="Labels available across projects."
    />,
  );
  return {
    user: userEvent.setup(),
    mutateGlobal,
    [Symbol.dispose]() {
      view.unmount();
      rootFixture[Symbol.dispose]();
    },
  };
}

afterEach(cleanup);

describe("Global label settings workflow", () => {
  it("creates a named, colored label and displays the authoritative result", async () => {
    using fixture = renderLabels([], async ({ mutation }) => {
      if (mutation._tag !== "AddLabel") throw new Error("Expected label creation");
      return [mutation.label];
    });

    expect(screen.getByText("No labels yet.")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Add label" }));
    expect(screen.getByRole("button", { name: "Create" }).hasAttribute("disabled")).toBe(true);
    await fixture.user.type(
      screen.getByRole("textbox", { name: "New label name" }),
      "  In review  ",
    );
    await fixture.user.click(
      within(screen.getByRole("radiogroup", { name: "New label color" })).getByRole("radio", {
        name: "cyan",
      }),
    );
    await fixture.user.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText("In review")).toBeDefined();
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "New label name" })).toBeNull(),
    );
    expect(fixture.mutateGlobal).toHaveBeenCalledWith(
      {
        mutation: {
          _tag: "AddLabel",
          label: { id: expect.any(String), name: "In review", color: "cyan" },
        },
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await fixture.user.click(screen.getByRole("button", { name: "Edit In review" }));
    expect(
      within(screen.getByRole("radiogroup", { name: "Color for In review" }))
        .getByRole("radio", { name: "cyan" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("renames and deletes an existing label through its editor", async () => {
    const service = vi
      .fn<Client["projectWorkflow"]["mutateGlobal"]>()
      .mockResolvedValueOnce([{ ...feature, name: "Product" }])
      .mockResolvedValueOnce([]);
    using fixture = renderLabels([feature], service);

    await fixture.user.click(screen.getByRole("button", { name: "Edit Feature" }));
    const name = screen.getByRole("textbox", { name: "Feature label name" });
    await fixture.user.clear(name);
    await fixture.user.type(name, "  Product  ");
    await fixture.user.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText("Product")).toBeDefined();
    expect(fixture.mutateGlobal).toHaveBeenNthCalledWith(
      1,
      { mutation: { _tag: "UpdateLabel", labelId: feature.id, name: "Product" } },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    await fixture.user.click(screen.getByRole("button", { name: "Edit Product" }));
    await fixture.user.click(screen.getByRole("button", { name: "Delete Product" }));
    expect(await screen.findByText("No labels yet.")).toBeDefined();
    expect(screen.queryByText("Product")).toBeNull();
    expect(fixture.mutateGlobal).toHaveBeenNthCalledWith(
      2,
      { mutation: { _tag: "DeleteLabel", labelId: feature.id } },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("retains an unsaved label after a service failure so the user can retry", async () => {
    const service = vi
      .fn<Client["projectWorkflow"]["mutateGlobal"]>()
      .mockRejectedValueOnce(new Error("Service unavailable"))
      .mockImplementationOnce(async ({ mutation }) => {
        if (mutation._tag !== "AddLabel") throw new Error("Expected label creation");
        return [mutation.label];
      });
    using fixture = renderLabels([], service);

    await fixture.user.click(screen.getByRole("button", { name: "Add label" }));
    await fixture.user.type(screen.getByRole("textbox", { name: "New label name" }), "Retry me");
    await fixture.user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create" }).hasAttribute("disabled")).toBe(false),
    );
    expect(screen.getByRole("textbox", { name: "New label name" }).getAttribute("value")).toBe(
      "Retry me",
    );
    expect(screen.getByText("No labels yet.")).toBeDefined();

    await fixture.user.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("Retry me")).toBeDefined();
    expect(fixture.mutateGlobal).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "New label name" })).toBeNull(),
    );
  });
});

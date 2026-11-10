/** @vitest-environment jsdom */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { StoreProvider } from "r-state-tree/react";
import { ProjectRail } from "../../../src/renderer/components/project-rail";
import type { AddProjectPlacement } from "../../../src/renderer/components/project-rail-add-project";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord } from "./fixtures/catalog-fixtures";

afterEach(cleanup);

function setup(addProjectPlacement?: AddProjectPlacement) {
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/cake", name: "Cake" }), projectRecord({ path: "/docs" })],
  });
  const chooseProject = vi
    .spyOn(fixture.root.navigationStore, "chooseProject")
    .mockResolvedValue(undefined);
  render(
    <StoreProvider store={fixture.root}>
      <ProjectRail addProjectPlacement={addProjectPlacement} />
    </StoreProvider>,
  );
  const rail = screen.getByRole("navigation", { name: "Projects and global utilities" });
  return {
    chooseProject,
    rail,
    heading: rail.querySelector<HTMLElement>('[data-slot="navigation-rail-section"]')!,
    projects: within(rail).getByRole("region", { name: "Projects" }),
    [Symbol.dispose]() {
      cleanup();
      fixture[Symbol.dispose]();
    },
  };
}

it("separates primary actions, the labelled project list and quieter utilities", () => {
  using f = setup();
  const rail = within(f.rail);
  const order = (name: string) => rail.getByRole("button", { name });
  const position = (a: Element, b: Element) => a.compareDocumentPosition(b);
  // New session and Search stay at the top with Cake Chat; utilities stay at the bottom.
  expect(position(order("New session"), f.heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(
    position(order("Search sessions"), f.heading) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(position(f.heading, order("Settings")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(f.heading.textContent).toContain("Projects");
  // Content rows are full-strength; actions and utilities inherit the quieter rail tone.
  expect(order("Open Cake Chat").classList.contains("text-foreground")).toBe(true);
  expect(order("Open Project Chat for Cake").classList.contains("text-foreground")).toBe(true);
  expect(order("New session").classList.contains("text-foreground")).toBe(false);
  expect(order("Settings").classList.contains("text-foreground")).toBe(false);
  expect(order("Settings").classList.contains("h-7")).toBe(true);
  expect(order("Open Project Chat for Cake").classList.contains("h-8")).toBe(true);
  // Browser sharing is a status icon with a dot, not a labelled row; its name carries status.
  const sharing = rail.getByRole("button", { name: /^Browser sharing:/ });
  expect(sharing.querySelector('[data-slot="icon-button-label"]')).toBeNull();
  expect(sharing.querySelector(".rounded-full")).not.toBeNull();
});

it("puts Add project on the Projects heading by default", async () => {
  using f = setup();
  const add = within(f.heading).getByRole("button", { name: "Add project" });
  expect(within(f.projects).queryByRole("button", { name: "Add project" })).toBeNull();
  await userEvent.setup().click(add);
  expect(f.chooseProject).toHaveBeenCalledTimes(1);
});

it("can instead end the project list with a quiet Add project row", async () => {
  using f = setup("row");
  expect(within(f.heading).queryByRole("button")).toBeNull();
  const buttons = within(f.projects).getAllByRole("button");
  const add = buttons.at(-1)!;
  expect(add.getAttribute("aria-label")).toBe("Add project");
  expect(add.classList.contains("text-foreground")).toBe(false);
  await userEvent.setup().click(add);
  expect(f.chooseProject).toHaveBeenCalledTimes(1);
});

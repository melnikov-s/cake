/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  InsetDisclosures,
  type InsetDisclosureSection,
} from "../../../src/renderer/components/ui/inset-disclosures";
import { Button } from "../../../src/renderer/components/ui/button";
import { ChatIcon } from "../../../src/renderer/components/ui/icons";

afterEach(cleanup);

const onOpen = vi.fn();
const sections = (activity = 3, attention = 2): InsetDisclosureSection[] =>
  [
    { id: "activity", label: "Activity", count: activity, regionLabel: "Running work" },
    { id: "attention", label: "Needs attention", count: attention, regionLabel: "Queued review" },
  ]
    .filter((section) => section.count > 0)
    .map((section) => ({
      ...section,
      icon: <ChatIcon />,
      summary: section.id === "activity" ? "running" : "to-dos",
      accessibleLabel: `${section.label}, ${section.count}`,
      onOpen,
      renderContent: () => <Button>Open {section.label} item</Button>,
    }));

it("expands exclusively and collapses without consuming work", async () => {
  const user = userEvent.setup();
  render(<InsetDisclosures sections={sections()} />);
  const activity = screen.getByRole("button", { name: "Activity, 3" });
  const attention = screen.getByRole("button", { name: "Needs attention, 2" });
  expect(activity.getAttribute("aria-expanded")).toBe("false");
  await user.click(activity);
  expect(screen.getByRole("region", { name: "Running work" }).id).toBe(
    activity.getAttribute("aria-controls"),
  );
  await user.click(attention);
  expect(activity.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByRole("region", { name: "Queued review" })).toBeTruthy();
  await user.click(attention);
  expect(screen.queryByRole("region")).toBeNull();
  expect(attention.textContent).toContain("2");
});

it("supports native activation, header navigation and panel Escape without intercepting composer Escape", async () => {
  const user = userEvent.setup();
  render(
    <>
      <InsetDisclosures sections={sections()} />
      <textarea aria-label="Composer" />
    </>,
  );
  const activity = screen.getByRole("button", { name: "Activity, 3" });
  const attention = screen.getByRole("button", { name: "Needs attention, 2" });
  activity.focus();
  await user.keyboard("{Enter}{ArrowDown}");
  expect(document.activeElement).toBe(attention);
  await user.keyboard(" ");
  expect(attention.getAttribute("aria-expanded")).toBe("true");
  for (const key of ["{ArrowDown}", "{Home}", "{ArrowUp}", "{End}"]) {
    await user.keyboard(key);
    expect(document.activeElement).toBe(
      key === "{ArrowDown}" || key === "{Home}" ? activity : attention,
    );
  }
  screen.getByRole("button", { name: "Open Needs attention item" }).focus();
  await user.keyboard("{Escape}");
  expect(document.activeElement).toBe(attention);
  expect(attention.getAttribute("aria-expanded")).toBe("false");
  await user.keyboard("{Enter}");
  const composer = screen.getByRole("textbox");
  await user.type(composer, "Unsent draft");
  await user.keyboard("{Escape}");
  expect(document.activeElement).toBe(composer);
  expect(attention.getAttribute("aria-expanded")).toBe("true");
  expect((composer as HTMLTextAreaElement).value).toBe("Unsent draft");
});

it("retains collapse and focus across live totals, empty/repopulated sections and sibling updates", async () => {
  const user = userEvent.setup();
  const view = render(
    <>
      <InsetDisclosures sections={sections()} />
      <textarea aria-label="Composer" />
    </>,
  );
  const activity = screen.getByRole("button", { name: "Activity, 3" });
  await user.click(activity);
  await user.click(activity);
  const composer = screen.getByRole("textbox");
  composer.focus();
  view.rerender(
    <>
      <InsetDisclosures sections={sections(4, 7)} />
      <textarea aria-label="Composer" />
    </>,
  );
  expect(document.activeElement).toBe(composer);
  expect(screen.queryByRole("region")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Activity, 4" }));
  view.rerender(<InsetDisclosures sections={sections(0, 7)} />);
  expect(screen.queryByRole("region")).toBeNull();
  view.rerender(<InsetDisclosures sections={sections(1, 7)} />);
  expect(screen.queryByRole("region")).toBeNull();
  view.rerender(<InsetDisclosures sections={sections(0, 0)} />);
  expect(screen.queryByRole("button")).toBeNull();
});

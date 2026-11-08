/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HoverCard } from "../../../src/renderer/components/ui/hover-card";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});
const render = (description = "A selectable description") => {
  act(() =>
    root.render(
      <HoverCard description={description} descriptionId="task-description">
        <button aria-describedby={description ? "task-description" : undefined}>Task title</button>
        <a href="#report">Report</a>
      </HoverCard>,
    ),
  );
  return container.querySelector("button")!;
};
const advance = () => act(() => vi.advanceTimersByTime(250));
const bubble = () => document.querySelector<HTMLElement>('[role="tooltip"]');

it("opens on focus without stealing focus, describes the title, and dismisses with Escape", () => {
  const title = render();
  expect(bubble()).toBeNull();
  act(() => title.focus());
  advance();
  expect(document.activeElement).toBe(title);
  expect(document.getElementById(title.getAttribute("aria-describedby")!)?.textContent).toBe(
    "A selectable description",
  );
  act(() => title.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  advance();
  expect(bubble()).toBeNull();
  expect(document.activeElement).toBe(title);
});

it("lets the pointer cross the gap into selectable prose, then dismisses after leaving", () => {
  const title = render();
  act(() => title.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
  advance();
  expect(bubble()).not.toBeNull();
  const anchor = title.parentElement!;
  act(() =>
    anchor.dispatchEvent(
      new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
    ),
  );
  act(() =>
    bubble()!.dispatchEvent(
      new MouseEvent("pointerover", { bubbles: true, relatedTarget: document.body }),
    ),
  );
  advance();
  expect(bubble()).not.toBeNull();
  act(() =>
    bubble()!.dispatchEvent(
      new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
    ),
  );
  advance();
  expect(bubble()).toBeNull();
});

it("restores row focus when dismissing from the scrollable bubble", () => {
  const title = render();
  act(() => title.focus());
  advance();
  act(() => bubble()!.focus());
  act(() =>
    bubble()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  advance();
  expect(bubble()).toBeNull();
  expect(document.activeElement).toBe(title);
});

it("does not compete with link tooltips or show an empty description", () => {
  const title = render();
  act(() => title.focus());
  advance();
  act(() => container.querySelector("a")!.focus());
  advance();
  expect(bubble()).toBeNull();
  render("");
  act(() => title.focus());
  advance();
  expect(bubble()).toBeNull();
  expect(title.hasAttribute("aria-describedby")).toBe(false);
});

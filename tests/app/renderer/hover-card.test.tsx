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
  // A known pointer position; the first event of a page has nothing to compare against.
  document.body.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
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
// Every call is real pointer travel to a fresh position, unless a position is given.
let travel = 0;
const pointAt = (target: Element, position = { clientX: (travel += 7), clientY: 3 }) =>
  act(() => {
    target.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, ...position }));
    target.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, ...position }));
  });
const leave = (target: Element) =>
  act(() =>
    target.dispatchEvent(
      new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
    ),
  );
const keyboardFocus = (target: HTMLElement, key = "Tab") =>
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true }),
    );
    target.focus();
  });

it("opens on keyboard focus without stealing focus, describes the title, and dismisses with Escape", () => {
  const title = render();
  expect(bubble()).toBeNull();
  keyboardFocus(title);
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
  pointAt(title);
  advance();
  expect(bubble()).not.toBeNull();
  leave(title.parentElement!);
  pointAt(bubble()!);
  advance();
  expect(bubble()).not.toBeNull();
  leave(bubble()!);
  advance();
  expect(bubble()).toBeNull();
});

it("stays closed for programmatic focus, click focus and a resting pointer", () => {
  // The pointer rests where the row is about to mount.
  pointAt(document.body, { clientX: 40, clientY: 40 });
  const title = render();
  // Mounting or layout moving the row under the cursor resends events in place.
  pointAt(title, { clientX: 40, clientY: 40 });
  advance();
  expect(bubble()).toBeNull();
  // Programmatic and initial focus, including after non-navigation keys.
  act(() => title.focus());
  advance();
  expect(bubble()).toBeNull();
  act(() => title.blur());
  keyboardFocus(title, "Enter");
  advance();
  expect(bubble()).toBeNull();
  act(() => title.blur());
  // Pointer-click focus is not a keyboard request, and leaving still closes.
  pointAt(title);
  advance();
  expect(bubble()).not.toBeNull();
  act(() => {
    title.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    title.focus();
  });
  leave(title.parentElement!);
  advance();
  expect(document.activeElement).toBe(title);
  expect(bubble()).toBeNull();
  // The next real movement over the row opens it again.
  pointAt(title);
  advance();
  expect(bubble()).not.toBeNull();
});

it("keeps a keyboard-opened description while focus stays on the row", () => {
  const title = render();
  keyboardFocus(title);
  advance();
  pointAt(title);
  leave(title.parentElement!);
  advance();
  expect(bubble()).not.toBeNull();
  keyboardFocus(container.querySelector("a")!);
  advance();
  expect(bubble()).toBeNull();
});

it("restores row focus when dismissing from the scrollable bubble", () => {
  const title = render();
  keyboardFocus(title);
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
  keyboardFocus(title);
  advance();
  keyboardFocus(container.querySelector("a")!);
  advance();
  expect(bubble()).toBeNull();
  render("");
  keyboardFocus(title);
  advance();
  expect(bubble()).toBeNull();
  expect(title.hasAttribute("aria-describedby")).toBe(false);
});

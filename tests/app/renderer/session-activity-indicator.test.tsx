/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SessionActivityIndicator } from "../../../src/renderer/components/session-activity-indicator";
import { sessionActivityWithInheritedWorking } from "../../../src/renderer/lib/session-activity";

afterEach(cleanup);

it.each(["running", "waiting", "unread", "blocked", "error", "stopped"] as const)(
  "preserves the parent's own %s indication over inherited working",
  (own) => {
    expect(sessionActivityWithInheritedWorking(own, true)).toBe(own);
    expect(sessionActivityWithInheritedWorking(own, false)).toBe(own);
  },
);

it("shows inherited work as running, and all-idle as idle", () => {
  expect(sessionActivityWithInheritedWorking(undefined, true)).toBe("running");
  expect(sessionActivityWithInheritedWorking(undefined, false)).toBeUndefined();
});

it("transitions from idle to running, waiting, error, completion, read and stopped without gray dots", () => {
  const view = render(<SessionActivityIndicator activity={undefined} />);
  expect(screen.queryByRole("img")).toBeNull();
  for (const [activity, label, color] of [
    ["running", "Running", "bg-accent"],
    ["waiting", "Waiting for your answer", "bg-attention"],
    ["error", "Error", "bg-destructive"],
    ["unread", "Ready, unread", "bg-success"],
    ["running", "Running", "bg-accent"],
  ] as const) {
    view.rerender(<SessionActivityIndicator activity={activity} />);
    const dot = screen.getByRole("img", { name: label });
    expect(dot.classList).toContain(color);
    expect(dot.classList).not.toContain("bg-muted-foreground");
    expect(dot.classList).not.toContain("bg-primary");
  }
  view.rerender(<SessionActivityIndicator activity={undefined} />);
  expect(screen.queryByRole("img")).toBeNull();
  view.rerender(<SessionActivityIndicator activity="stopped" />);
  expect(screen.queryByRole("img")).toBeNull();
});

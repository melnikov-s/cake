// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionActivity } from "../../../src/renderer/lib/session-activity";
import {
  SessionListItem,
  type SessionListItemProps,
} from "../../../src/renderer/components/ui/session-list-item";

afterEach(cleanup);
const props: SessionListItemProps = {
  session: {
    sessionId: "layout-session",
    title: "Review tutorial navigation and sidebar layout",
    modifiedAt: new Date(0).toISOString(),
  },
  selected: false,
  resolved: false,
  activityTime: "1 day ago",
  labels: [],
  avatarSeed: "layout",
  avatarsEnabled: false,
  onOpen: vi.fn(),
};

describe("session row action track", () => {
  it("uses no trailing track for an idle destination without actions", () => {
    const { container } = render(<SessionListItem {...props} />);
    expect(container.querySelector('[data-slot="nav-trailing"]')).toBeNull();
    expect(screen.getByTitle(props.session.title)).toBeDefined();
  });

  it("keeps activity and resolve in one track and resolves without selecting", () => {
    const onOpen = vi.fn();
    const onResolve = vi.fn();
    const { container } = render(
      <SessionListItem {...props} activity="unread" onOpen={onOpen} onResolve={onResolve} />,
    );
    expect(container.querySelectorAll('[data-slot="nav-trailing"]')).toHaveLength(1);
    expect(screen.getByRole("img", { name: "Ready, unread" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: `Resolve ${props.session.title}` }));
    expect(onResolve).toHaveBeenCalledWith("layout-session", true);
    expect(onOpen).not.toHaveBeenCalled();
  });

  // Every activity the row can display; the indicator draws nothing for `stopped`.
  const statuses = [
    ["waiting", "Waiting for your answer"],
    ["running", "Running"],
    ["blocked", "Needs your input"],
    ["unread", "Ready, unread"],
    ["error", "Error"],
    ["stopped", undefined],
  ] as const satisfies ReadonlyArray<readonly [SessionActivity, string | undefined]>;

  it.each(statuses)(
    "replaces the %s status with Resolve on hover or focus in the same slot",
    (activity, statusLabel) => {
      const onOpen = vi.fn();
      const onResolve = vi.fn();
      const { container } = render(
        <SessionListItem {...props} activity={activity} onOpen={onOpen} onResolve={onResolve} />,
      );
      const track = container.querySelector<HTMLElement>(".session-meta")!;
      const resolve = screen.getByRole("button", { name: `Resolve ${props.session.title}` });
      expect(track.contains(resolve)).toBe(true);
      // Hidden at rest; revealed by row hover or keyboard focus anywhere in the row.
      expect(resolve.className).toMatch(/(^| )opacity-0( |$)/);
      expect(resolve.className).toContain("group-hover/session:opacity-100");
      expect(resolve.className).toContain("group-focus-within/session:opacity-100");
      expect(resolve.className).toContain("col-start-1 row-start-1");
      if (statusLabel) {
        const status = screen.getByRole("img", { name: statusLabel }).parentElement!;
        expect(track.contains(status)).toBe(true);
        // Status yields to Resolve in the same grid cell, so nothing shifts.
        expect(status.className).toContain("group-hover/session:opacity-0");
        expect(status.className).toContain("group-focus-within/session:opacity-0");
        expect(status.className).toContain("pointer-events-none");
        expect(status.className).toContain("col-start-1 row-start-1");
      }
      fireEvent.click(resolve);
      expect(onResolve).toHaveBeenCalledWith("layout-session", true);
      expect(onOpen).not.toHaveBeenCalled();
    },
  );

  it.each(statuses)("keeps hover Resolve over the %s status on a selected row", (activity) => {
    render(<SessionListItem {...props} selected activity={activity} onResolve={vi.fn()} />);
    const resolve = screen.getByRole("button", { name: `Resolve ${props.session.title}` });
    expect(resolve.className).toContain("group-hover/session:opacity-100");
  });

  it("omits the action track for an idle family child but retains disclosure and selection", () => {
    const onOpen = vi.fn();
    const onToggleFamily = vi.fn();
    const { container } = render(
      <SessionListItem
        {...props}
        session={{
          ...props.session,
          familyParentSessionId: "parent",
          familyChildSessionIds: ["grandchild"],
        }}
        onOpen={onOpen}
        onResolve={vi.fn()}
        onToggleFamily={onToggleFamily}
        familyCollapsed
      />,
    );
    expect(container.querySelector('[data-slot="nav-trailing"]')).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: `Expand children of ${props.session.title}` }),
    );
    expect(onToggleFamily).toHaveBeenCalledWith("layout-session");
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^Review tutorial/ }));
    expect(onOpen).toHaveBeenCalledWith("layout-session");
  });
});

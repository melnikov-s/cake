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

describe("session row metadata", () => {
  it("shows base-relative committed stats without changing navigation or status controls", () => {
    const onOpen = vi.fn();
    const onResolve = vi.fn();
    const { container, rerender } = render(
      <SessionListItem
        {...props}
        managedWorktree={{
          branch: "agent/task",
          baseBranch: "main",
          state: "active",
          commitStats: { commitCount: 3, additions: 120, deletions: 35 },
        }}
        activity="running"
        onOpen={onOpen}
        onResolve={onResolve}
      />,
    );
    expect(container.querySelector('[data-slot="commit-change-stats"]')?.textContent).toBe(
      "3 commits · +120 −35",
    );
    expect(screen.getByRole("img", { name: "Running" })).toBeDefined();
    fireEvent.click(screen.getByText(props.session.title));
    expect(onOpen).toHaveBeenCalledWith(props.session.sessionId);
    fireEvent.click(screen.getByRole("button", { name: `Resolve ${props.session.title}` }));
    expect(onResolve).toHaveBeenCalled();
    rerender(
      <SessionListItem
        {...props}
        managedWorktree={{
          branch: "agent/task",
          baseBranch: "main",
          state: "active",
          commitStats: { commitCount: 1, additions: 0, deletions: 0 },
        }}
      />,
    );
    expect(screen.getByText("1 commit · +0 −0")).toBeDefined();
  });

  it.each([undefined, { commitCount: 0, additions: 0, deletions: 0 }])(
    "hides unavailable and empty committed stats (%j)",
    (commitStats) => {
      const { container } = render(
        <SessionListItem
          {...props}
          managedWorktree={{
            branch: "agent/task",
            baseBranch: "main",
            state: "active",
            commitStats,
          }}
        />,
      );
      expect(container.querySelector('[data-slot="commit-change-stats"]')).toBeNull();
    },
  );

  it.each([
    ["time only", "1 day ago", undefined, undefined, "1 day ago"],
    ["branch only", "", "feature", undefined, "feature"],
    ["source only", "", undefined, { kind: "cake-chat", name: "Cake Chat" }, "Cake Chat"],
    ["time and branch", "1 day ago", "feature", undefined, "1 day ago·feature"],
    [
      "source and branch",
      "",
      "feature",
      { kind: "cake-chat", name: "Cake Chat" },
      "Cake Chat·feature",
    ],
    [
      "source, time and branch",
      "1 day ago",
      "feature",
      { kind: "cake-chat", name: "Cake Chat" },
      "Cake Chat·1 day ago·feature",
    ],
  ] as const)(
    "formats %s without dangling separators",
    (_, activityTime, branch, source, expected) => {
      const { container } = render(
        <SessionListItem
          {...props}
          session={{ ...props.session, worktreeName: branch }}
          activityTime={activityTime}
          source={source}
        />,
      );
      expect(container.querySelector('[data-slot="session-description"]')?.textContent).toBe(
        expected,
      );
    },
  );

  it.each(["", "   "])("omits the subtitle when metadata is empty (%j)", (activityTime) => {
    const { container } = render(<SessionListItem {...props} activityTime={activityTime} />);
    expect(container.querySelector('[data-slot="session-description"]')).toBeNull();
    expect(container.querySelector("time")).toBeNull();
    expect(screen.getByTitle(props.session.title)).toBeDefined();
  });

  it("retains working metadata even without a timestamp", () => {
    const { container } = render(<SessionListItem {...props} activity="running" activityTime="" />);
    expect(container.querySelector('[data-slot="session-description"]')?.textContent).toBe(
      "Working",
    );
    expect(screen.getByRole("img", { name: "Running" })).toBeDefined();
  });

  it("retains the navigation idle status without a type label or subtitle", () => {
    const { container } = render(<SessionListItem {...props} showIdleStatus activityTime="" />);
    expect(screen.getByLabelText("Idle")).toBeDefined();
    expect(container.querySelector('[data-slot="session-description"]')).toBeNull();
  });
});

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

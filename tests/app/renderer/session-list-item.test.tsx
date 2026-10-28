// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

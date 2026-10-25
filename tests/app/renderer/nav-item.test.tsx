/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NavItem } from "../../../src/renderer/components/ui/nav-item";
import { Button } from "../../../src/renderer/components/ui/button";

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  cleanup();
});

function fixture(selectableText = true) {
  const select = vi.fn();
  const complete = vi.fn();
  const navigate = vi.fn();
  render(
    <NavItem
      wholeRowAction
      selectableText={selectableText}
      label="Task title"
      onClick={select}
      trailing={<Button onClick={complete}>Done</Button>}
    >
      <p>Current outcome</p>
      <a href="#report" onClick={navigate}>
        Report
      </a>
    </NavItem>,
  );
  const action = screen.getByRole("button", { name: "Task title" });
  const prose = screen.getByText("Current outcome");
  const done = screen.getByRole("button", { name: "Done" });
  const link = screen.getByRole("link", { name: "Report" });
  return { select, complete, navigate, action, prose, done, link };
}

function selectText(element: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(element);
  window.getSelection()?.addRange(range);
}

it.each(["action", "prose", "done", "link"] as const)(
  "a selection drag ending on %s does not activate any action",
  (target) => {
    const f = fixture();
    fireEvent.mouseDown(f.prose, { clientX: 10, clientY: 10 });
    selectText(f.prose);
    expect(fireEvent.click(f[target], { detail: 1, clientX: 30, clientY: 20 })).toBe(false);
    expect(f.select).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.navigate).not.toHaveBeenCalled();
    expect(window.getSelection()?.toString()).toBe("Current outcome");
  },
);

it("a drag remains non-activating even if its selection collapses over a control", () => {
  const f = fixture();
  fireEvent.mouseDown(f.prose, { clientX: 10, clientY: 10 });
  fireEvent.click(f.done, { detail: 1, clientX: 30, clientY: 20 });
  expect(f.complete).not.toHaveBeenCalled();
});

it("Shift-click extends text selection without selecting the row", () => {
  const f = fixture();
  selectText(f.prose);
  fireEvent.mouseDown(f.prose, { clientX: 10, clientY: 10 });
  fireEvent.click(f.prose, { detail: 1, clientX: 10, clientY: 10, shiftKey: true });
  expect(f.select).not.toHaveBeenCalled();
});

it("existing text selection does not block fresh clicks or keyboard activation", () => {
  const f = fixture();
  selectText(f.prose);
  for (const target of [f.action, f.prose, f.done, f.link]) {
    fireEvent.mouseDown(target, { clientX: 10, clientY: 10 });
    fireEvent.click(target, { detail: 1, clientX: 10, clientY: 10 });
  }
  expect(f.select).toHaveBeenCalledTimes(2);
  expect(f.complete).toHaveBeenCalledOnce();
  expect(f.navigate).toHaveBeenCalledOnce();
  expect(f.action).toBe(document.activeElement);
  // Native Enter/Space activation has detail=0 and ignores previous pointer coordinates.
  fireEvent.click(f.action, { detail: 0 });
  expect(f.select).toHaveBeenCalledTimes(3);
});

it("does not change ordinary non-selectable navigation rows", () => {
  const f = fixture(false);
  selectText(f.prose);
  fireEvent.mouseDown(f.prose, { clientX: 10, clientY: 10 });
  fireEvent.click(f.prose, { detail: 1, clientX: 30, clientY: 20 });
  expect(f.select).toHaveBeenCalledOnce();
});

describe("NavItem press activation", () => {
  it("activates once on primary down, then accepts keyboard and assistive clicks", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<NavItem label="Session" activateOnMouseDown onClick={onClick} />);
    const action = screen.getByRole("button", { name: "Session" });
    await user.pointer({ target: action, keys: "[MouseLeft>]" });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick.mock.calls[0]![0].type).toBe("mousedown");
    await user.pointer({ keys: "[/MouseLeft]" });
    expect(onClick).toHaveBeenCalledTimes(1);
    action.focus();
    await user.keyboard("{Enter} ");
    expect(onClick).toHaveBeenCalledTimes(3);
    fireEvent.click(action, { detail: 0 });
    expect(onClick).toHaveBeenCalledTimes(4);
  });

  it("leaves nested trailing controls and non-primary input independent", async () => {
    const onClick = vi.fn();
    const onResolve = vi.fn();
    const onContextMenu = vi.fn();
    const user = userEvent.setup();
    render(
      <NavItem
        label="Session"
        activateOnMouseDown
        onClick={onClick}
        onContextMenu={onContextMenu}
        trailing={<Button onClick={onResolve}>Resolve</Button>}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Resolve" }));
    expect(onResolve).toHaveBeenCalledTimes(1);
    const action = screen.getByRole("button", { name: "Session" });
    await user.pointer({ target: action, keys: "[MouseRight][MouseMiddle]" });
    expect(onContextMenu).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it.each(["shiftKey", "altKey", "metaKey"] as const)(
    "retains primary-button %s activation without a second open",
    (modifier) => {
      const onClick = vi.fn();
      render(<NavItem label="Session" activateOnMouseDown onClick={onClick} />);
      const action = screen.getByRole("button", { name: "Session" });
      fireEvent.mouseDown(action, { button: 0, [modifier]: true });
      expect(onClick).toHaveBeenCalledTimes(1);
      expect(onClick.mock.calls[0]![0][modifier]).toBe(true);
      fireEvent.click(action, { detail: 1, [modifier]: true });
      expect(onClick).toHaveBeenCalledTimes(1);
    },
  );

  it("leaves control-click to native context-menu/click semantics", () => {
    const onClick = vi.fn();
    render(<NavItem label="Session" activateOnMouseDown onClick={onClick} />);
    const action = screen.getByRole("button", { name: "Session" });
    fireEvent.mouseDown(action, { button: 0, ctrlKey: true });
    expect(onClick).not.toHaveBeenCalled();
    // Platforms that emit a primary click for Ctrl still retain that activation.
    fireEvent.click(action, { detail: 1, ctrlKey: true });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("honors action mousedown cancellation and aria-disabled", () => {
    const onClick = vi.fn();
    const view = render(
      <NavItem
        label="Session"
        activateOnMouseDown
        onClick={onClick}
        actionProps={{ onMouseDown: (event) => event.preventDefault() }}
      />,
    );
    fireEvent.mouseDown(screen.getByRole("button"), { button: 0 });
    expect(onClick).not.toHaveBeenCalled();
    view.rerender(
      <NavItem
        label="Session"
        activateOnMouseDown
        onClick={onClick}
        actionProps={{ "aria-disabled": true }}
      />,
    );
    fireEvent.mouseDown(screen.getByRole("button"), { button: 0 });
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("keeps ordinary navigation and destination pickers on click by default", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<NavItem label="Destination" onClick={onClick} />);
    await user.pointer({ target: screen.getByRole("button"), keys: "[MouseLeft>]" });
    expect(onClick).not.toHaveBeenCalled();
    await user.pointer({ keys: "[/MouseLeft]" });
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

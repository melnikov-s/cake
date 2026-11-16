/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ContextMenu } from "../../../src/renderer/components/ui/context-menu";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("keeps the default block anchor and its submenu actions", async () => {
  const user = userEvent.setup();
  const select = vi.fn();
  const { container } = render(
    <ContextMenu
      label="Block actions"
      items={[{ label: "More", items: [{ label: "Run", onSelect: select }] }]}
    >
      <div>Block content</div>
    </ContextMenu>,
  );
  const child = screen.getByText("Block content");
  expect(child.parentElement?.tagName).toBe("DIV");
  expect(container.firstElementChild).toBe(child.parentElement);
  fireEvent.contextMenu(child);
  const menu = screen.getByRole("menu", { name: "Block actions" });
  expect(container.contains(menu)).toBe(false);
  await user.keyboard("{ArrowRight}");
  await user.click(screen.getByRole("menuitem", { name: "Run" }));
  expect(select).toHaveBeenCalledExactlyOnceWith();
  expect(screen.queryByRole("menu")).toBeNull();
});

it("uses a span anchor without changing interactive menu panels", async () => {
  const user = userEvent.setup();
  const errors = vi.spyOn(console, "error");
  const { container } = render(
    <p>
      Before{" "}
      <ContextMenu
        as="span"
        label="Inline actions"
        items={[{ label: "Choose", content: (close) => <button onClick={close}>Done</button> }]}
      >
        <button>Inline content</button>
      </ContextMenu>{" "}
      after.
    </p>,
  );
  const child = screen.getByRole("button", { name: "Inline content" });
  expect(child.parentElement?.tagName).toBe("SPAN");
  fireEvent.keyDown(child, { key: "ContextMenu" });
  await user.click(screen.getByRole("menuitem", { name: "Choose" }));
  const panel = screen.getByRole("dialog", { name: "Choose" });
  expect(container.contains(panel)).toBe(false);
  expect(panel.closest("p")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(container.querySelector("p")?.textContent).toBe("Before Inline content after.");
  expect(container.querySelector("p div")).toBeNull();
  expect(errors).not.toHaveBeenCalled();
});

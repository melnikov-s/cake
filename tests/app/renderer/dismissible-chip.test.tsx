/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { DismissibleChip } from "../../../src/renderer/components/ui/dismissible-chip";

describe("DismissibleChip", () => {
  function fixture(disabled = false) {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onClick = vi.fn();
    const onRemove = vi.fn();
    act(() =>
      root.render(
        <DismissibleChip
          aria-label="Reveal source"
          removeLabel="Remove source"
          onClick={onClick}
          onRemove={onRemove}
          disabled={disabled}
        >
          source.ts:3
        </DismissibleChip>,
      ),
    );
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
    return {
      container,
      buttons,
      onClick,
      onRemove,
      [Symbol.dispose]() {
        act(() => root.unmount());
        container.remove();
      },
    };
  }
  it("renders separate accessible primary and remove controls with the supplied remove tooltip", () => {
    using f = fixture();
    expect(f.buttons).toHaveLength(2);
    expect(f.buttons[0]?.getAttribute("aria-label")).toBe("Reveal source");
    expect(f.buttons[1]?.getAttribute("aria-label")).toBe("Remove source");
    expect(f.buttons[0]?.contains(f.buttons[1]!)).toBe(false);
    act(() => f.buttons[1]!.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true })));
    expect(f.buttons[1]?.getAttribute("aria-label")).toBe("Remove source");
  });
  it("invokes only navigation for the body and only removal for the X", () => {
    using f = fixture();
    act(() => f.buttons[0]!.click());
    expect(f.onClick).toHaveBeenCalledOnce();
    expect(f.onRemove).not.toHaveBeenCalled();
    act(() => f.buttons[1]!.click());
    expect(f.onClick).toHaveBeenCalledOnce();
    expect(f.onRemove).toHaveBeenCalledOnce();
  });
  it("disables both controls when disabled", () => {
    using f = fixture(true);
    expect(f.buttons.map((button) => button.disabled)).toEqual([true, true]);
    act(() => {
      f.buttons[0]!.click();
      f.buttons[1]!.click();
    });
    expect(f.onClick).not.toHaveBeenCalled();
    expect(f.onRemove).not.toHaveBeenCalled();
  });
});

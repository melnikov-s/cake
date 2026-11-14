/**
 * @vitest-environment jsdom
 */
import { act, createRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NumberedIconButton } from "../../../src/renderer/components/ui/numbered-icon-button";
import { ArtifactIcon } from "../../../src/renderer/components/ui/icons";
import {
  Popover,
  PopoverContent,
  PopoverNumberedIconTrigger,
} from "../../../src/renderer/components/ui/popover";

afterEach(cleanup);

describe("NumberedIconButton", () => {
  it.each([
    [1, "1"],
    [7, "7"],
    [12, "12"],
    [35, "35"],
    [99, "99"],
    [100, "99+"],
    [1234567, "99+"],
    [Number.MAX_SAFE_INTEGER, "99+"],
  ])("shows count %i as %s in a corner bubble on the shared square target", (count, shown) => {
    render(
      <NumberedIconButton count={count} tooltip={`${count} artifacts`}>
        <ArtifactIcon />
      </NumberedIconButton>,
    );
    const button = screen.getByRole("button", { name: `${count} artifacts` });
    const badge = screen.getByText(shown);
    expect(badge.getAttribute("data-slot")).toBe("count-badge");
    expect(badge.classList.contains("bg-muted")).toBe(true);
    expect(badge.classList.contains("text-muted-foreground")).toBe(true);
    expect(badge.classList.contains("h-3.5")).toBe(true);
    expect(badge.classList.contains("min-w-3.5")).toBe(true);
    expect(badge.classList.contains("text-[0.625rem]")).toBe(true);
    expect(badge.classList.contains("font-semibold")).toBe(true);
    expect(badge.classList.contains("font-sans")).toBe(true);
    for (const inherited of ["text-xs", "font-medium", "font-mono", "leading-tight"])
      expect(badge.classList.contains(inherited)).toBe(false);
    expect(badge.classList.contains("tabular-nums")).toBe(true);
    expect(badge.classList.contains("whitespace-nowrap")).toBe(true);
    expect(badge.closest('[aria-hidden="true"]')).not.toBeNull();
    // The bubble overlays the corner; it never widens the target.
    expect(badge.parentElement!.classList.contains("absolute")).toBe(true);
    expect(button.classList.contains("size-7")).toBe(true);
    expect(button.classList.contains("w-auto")).toBe(false);
    expect(button.className).toContain("[@media(pointer:coarse)]:min-h-11");
    expect(button.className).toContain("[@media(pointer:coarse)]:min-w-11");
    expect(button.querySelector("svg")!.getAttribute("width")).toBe("18");
  });

  it.each([
    [undefined, ""],
    [0, ""],
    [1, "1"],
    [10, "10"],
    [99, "99"],
    [100, "99+"],
  ])("reserves readable inline count space for %s without overlaying the glyph", (count, shown) => {
    render(
      <NumberedIconButton
        count={count}
        countPlacement="inline"
        tooltip={`Review changes${count === undefined ? "" : ` · ${count} commits`}`}
        aria-pressed
        pressedAppearance="subtle"
      >
        <ArtifactIcon />
      </NumberedIconButton>,
    );
    const button = screen.getByRole("button", { name: /^Review changes/ });
    expect(button.textContent).toBe(shown);
    expect(button.classList.contains("text-foreground")).toBe(true);
    expect(button.classList.contains("size-7")).toBe(true);
    expect(button.classList.contains("w-auto")).toBe(Boolean(shown));
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.classList.contains("aria-pressed:text-accent")).toBe(true);
    expect(button.querySelector("svg")!.getAttribute("width")).toBe("18");
    const badge = button.querySelector('[data-slot="count-badge"]');
    if (!shown) {
      expect(badge).toBeNull();
      return;
    }
    expect(badge!.parentElement!.classList.contains("absolute")).toBe(false);
    expect(badge!.closest('[aria-hidden="true"]')).not.toBeNull();
    for (const utility of ["text-foreground", "text-xs", "font-semibold", "tabular-nums"])
      expect(badge!.classList.contains(utility)).toBe(true);
    expect(badge!.classList.contains("text-muted-foreground")).toBe(false);
  });

  it("shows the plain icon for zero", () => {
    render(
      <NumberedIconButton count={0} tooltip="0 artifacts">
        <ArtifactIcon />
      </NumberedIconButton>,
    );
    const button = screen.getByRole("button", { name: "0 artifacts" });
    expect(button.textContent).toBe("");
    expect(button.querySelector('[data-slot="count-badge"]')).toBeNull();
    expect(button.querySelector("svg")).not.toBeNull();
  });

  it("omits an unknown count, forwards refs and retains disabled and pressed behavior", () => {
    const ref = createRef<HTMLButtonElement>();
    const click = vi.fn();
    render(
      <NumberedIconButton
        ref={ref}
        tooltip="Review changes"
        disabled
        aria-pressed
        pressedAppearance="subtle"
        onClick={click}
      >
        <ArtifactIcon />
      </NumberedIconButton>,
    );
    const button = screen.getByRole("button", { name: "Review changes" });
    expect(button.textContent).toBe("");
    expect(ref.current).toBe(button);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.classList.contains("aria-pressed:text-accent")).toBe(true);
    fireEvent.click(button);
    expect(click).not.toHaveBeenCalled();
  });

  it("preserves count meaning supplied as an accessible description", () => {
    render(
      <NumberedIconButton count={3} tooltip="To-do" aria-description="3 open to-dos">
        <ArtifactIcon />
      </NumberedIconButton>,
    );
    const button = screen.getByRole("button", { name: "To-do" });
    expect(button.getAttribute("aria-description")).toBe("3 open to-dos");
    expect(screen.getByText("3").closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it("retains tooltip text and click handling", () => {
    vi.useFakeTimers();
    try {
      const click = vi.fn();
      render(
        <NumberedIconButton count={4} tooltip="Artifacts" ariaLabel="4 artifacts" onClick={click}>
          <ArtifactIcon />
        </NumberedIconButton>,
      );
      const button = screen.getByRole("button", { name: "4 artifacts" });
      fireEvent.click(button);
      expect(click).toHaveBeenCalledOnce();
      fireEvent.mouseOver(button);
      act(() => vi.advanceTimersByTime(120));
      expect(screen.getByRole("tooltip").textContent).toBe("Artifacts");
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves popover trigger semantics and respects prevented opening", () => {
    const click = vi.fn();
    render(
      <Popover>
        <PopoverNumberedIconTrigger count={35} tooltip="35 artifacts" onClick={click}>
          <ArtifactIcon />
        </PopoverNumberedIconTrigger>
        <PopoverContent aria-label="Artifacts">Contents</PopoverContent>
      </Popover>,
    );
    const button = screen.getByRole("button", { name: "35 artifacts" });
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(click).toHaveBeenCalledOnce();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(button.getAttribute("aria-controls")!)?.textContent).toBe(
      "Contents",
    );
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    click.mockImplementation((event) => event.preventDefault());
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });
});

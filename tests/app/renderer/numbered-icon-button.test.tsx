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
  it.each([0, 1, 4, 35, 1234, 1234567])(
    "shows the exact count %i in an opaque inset bubble",
    (count) => {
      render(
        <NumberedIconButton count={count} tooltip={`${count} artifacts`}>
          <ArtifactIcon />
        </NumberedIconButton>,
      );
      const button = screen.getByRole("button", { name: `${count} artifacts` });
      const badge = screen.getByText(String(count));
      expect(badge.classList.contains("bg-card")).toBe(true);
      expect(badge.classList.contains("min-w-4")).toBe(true);
      expect(badge.closest('[aria-hidden="true"]')).not.toBeNull();
      expect(button.classList.contains("min-w-8")).toBe(true);
      expect(button.classList.contains("w-auto")).toBe(true);
    },
  );

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

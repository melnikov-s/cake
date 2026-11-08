/** @vitest-environment jsdom */
import { StrictMode, useState } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { PaneTabs } from "../../../src/renderer/components/ui/pane-tabs";

const items = Array.from({ length: 8 }, (_, index) => ({
  id: String(index),
  title: `Side chat ${index}: ${"Long title ".repeat(8)}`,
}));

function Surface() {
  const [selected, select] = useState("0");
  return (
    <PaneTabs
      id="test-tabs"
      label="Side chats"
      panelId="test-panel"
      items={items}
      value={selected}
      onValueChange={select}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each([240, 416])(
  "keeps manual keyboard navigation and overflow scrolling inside a %ipx pane",
  async (width) => {
    const measure = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const rect = measure.call(this);
        if (this.getAttribute("role") === "tablist")
          return { ...rect, left: 100, right: 100 + width, width };
        if (this.getAttribute("role") === "tab") {
          const index = Number(this.id.split("-").at(-1));
          const left = 100 + index * 140 - this.parentElement!.scrollLeft;
          return { ...rect, left, right: left + 140, width: 140 };
        }
        return rect;
      },
    );
    render(
      <StrictMode>
        <Surface />
      </StrictMode>,
    );
    const user = userEvent.setup();
    const strip = screen.getByRole("tablist", { name: "Side chats" });
    const tabs = within(strip).getAllByRole("tab");
    expect(strip.classList.contains("overflow-x-auto")).toBe(true);
    expect(strip.classList.contains("min-w-0")).toBe(true);
    expect(strip.classList.contains("max-w-full")).toBe(true);
    expect(tabs[0]!.getAttribute("tabindex")).toBe("0");
    expect(tabs[1]!.getAttribute("tabindex")).toBe("-1");
    await user.tab();
    expect(document.activeElement).toBe(tabs[0]);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(tabs[7]);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    expect(strip.scrollLeft).toBe(8 * 140 - width);
    expect(document.documentElement.scrollLeft).toBe(0);
    await user.keyboard("{Enter}");
    expect(tabs[7]!.getAttribute("aria-selected")).toBe("true");
    expect(tabs[7]!.getAttribute("aria-controls")).toBe("test-panel");
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(tabs[0]);
    expect(strip.scrollLeft).toBe(0);
    await user.keyboard(" ");
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(tabs[7]);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(tabs[0]);
  },
);

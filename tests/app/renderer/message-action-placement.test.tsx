/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { messageActionPlacement } from "../../../src/renderer/lib/message-action-placement";
import { Message, MessageContent } from "../../../src/renderer/components/ai-elements/message";
import { IconButton } from "../../../src/renderer/components/ui/icon-button";

const viewport = { top: 100, bottom: 600, left: 50, right: 850 };
const row = { width: 92, height: 28 };
const column = { width: 28, height: 92 };
const message = { top: 150, bottom: 500, left: 100, right: 800 };
const place = (bounds: Partial<typeof message>, area = viewport) =>
  messageActionPlacement({ message: { ...message, ...bounds }, viewport: area, row, column });

afterEach(cleanup);

describe("message action placement", () => {
  it("keeps the footer whenever the bottom is visible, including the exact boundary", () => {
    expect(place({})).toEqual({ kind: "footer" });
    expect(place({ top: -200, bottom: 600 })).toEqual({ kind: "footer" });
    expect(place({ bottom: 601 })).toEqual({ kind: "above", top: 114, left: 100 });
  });

  it("moves above the entire message, never over its body", () => {
    const bounds = { top: 150, bottom: 900 };
    const result = place(bounds);
    expect(result).toEqual({ kind: "above", top: 114, left: 100 });
    if ("top" in result) expect(result.top + row.height).toBeLessThan(bounds.top);
    expect(place({ top: 100, bottom: 900 })).toEqual({ kind: "hidden" });
  });

  it("transitions from above to side to footer as a long message scrolls", () => {
    expect(place({ top: 150, bottom: 950 }).kind).toBe("above");
    expect(place({ top: 99, bottom: 899 })).toEqual({ kind: "side", top: 304, left: 808 });
    expect(place({ top: -200, bottom: 600 }).kind).toBe("footer");
  });

  it("uses an external right rail or falls back to an external left rail", () => {
    const right = place({ top: 0, bottom: 900 });
    expect(right).toEqual({ kind: "side", top: 304, left: 808 });
    if ("left" in right) expect(right.left).toBeGreaterThan(message.right);
    const left = place({ top: 0, bottom: 900, right: 840 });
    expect(left).toEqual({ kind: "side", top: 304, left: 64 });
    if ("left" in left) expect(left.left + column.width).toBeLessThan(message.left);
  });

  it("hides side actions in narrow layouts rather than overlapping or clipping", () => {
    expect(place({ top: 0, bottom: 900, left: 70, right: 830 })).toEqual({ kind: "hidden" });
    expect(place({ top: 0, bottom: 900, left: 86, right: 814 })).toEqual({
      kind: "side",
      top: 304,
      left: 822,
    });
    expect(place({ top: 0, bottom: 900 }, { ...viewport, bottom: 180 })).toEqual({
      kind: "hidden",
    });
    expect(place({ top: 150, bottom: 900 }, { ...viewport, right: 180 })).toEqual({
      kind: "hidden",
    });
  });

  it.each([
    { top: -500, bottom: 100 },
    { top: 600, bottom: 900 },
    { left: -500, right: 50 },
    { left: 850, right: 1000 },
  ])("never floats controls for an offscreen message: %o", (bounds) => {
    expect(place(bounds)).toEqual({ kind: "hidden" });
  });

  it("uses the actual inset chat viewport, not window bounds", () => {
    expect(place({ top: 150, bottom: 900 }, { ...viewport, top: 140 }).kind).toBe("hidden");
    expect(place({ top: 0, bottom: 900 }, { ...viewport, left: 90, right: 810 }).kind).toBe(
      "hidden",
    );
  });

  it("keeps one set of existing named actions with their callbacks and disabled semantics", () => {
    const copy = vi.fn();
    const reply = vi.fn();
    render(
      <Message
        actions={
          <>
            <IconButton ariaLabel="Copy message" onClick={copy}>
              Copy
            </IconButton>
            <IconButton ariaLabel="Reply to message" onClick={reply} disabled>
              Reply
            </IconButton>
          </>
        }
      >
        <MessageContent>Message body</MessageContent>
      </Message>,
    );
    expect(screen.getAllByRole("button")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    fireEvent.click(screen.getByRole("button", { name: "Reply to message" }));
    expect(copy).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
    const body = screen.getByText("Message body");
    expect(body.querySelector("button")).toBeNull();
    const clearance = body.parentElement?.querySelector('[data-slot="message-action-clearance"]');
    expect(clearance?.getAttribute("aria-hidden")).toBe("true");
    expect(clearance?.querySelector("button")).toBeNull();
    expect(
      body.parentElement?.querySelectorAll('[data-slot="message-action-toolbar"]'),
    ).toHaveLength(1);
  });
});

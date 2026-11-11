/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  messageActionPlacement,
  messageActionViewport,
} from "../../../src/renderer/lib/message-action-placement";
import { Message, MessageContent } from "../../../src/renderer/components/ai-elements/message";
import { MarkdownLinkProvider } from "../../../src/renderer/components/ai-elements/markdown";
import { ChatTextMessage } from "../../../src/renderer/components/chat-message";
import { SessionMessage } from "../../../src/renderer/components/session-message";
import { SkillMessage } from "../../../src/renderer/components/skill-message";
import { IconButton } from "../../../src/renderer/components/ui/icon-button";

const viewport = { top: 100, bottom: 600, left: 50, right: 850 };
const row = { width: 92, height: 28 };
const column = { width: 28, height: 92 };
const message = { top: 150, bottom: 500, left: 100, right: 800 };
const place = (bounds: Partial<typeof message>, area = viewport) =>
  messageActionPlacement({ message: { ...message, ...bounds }, viewport: area, row, column });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

describe("message action viewport", () => {
  const scroller = {
    top: 100,
    left: 50,
    clientTop: 0,
    clientLeft: 0,
    clientWidth: 800,
    clientHeight: 500,
  };
  const window = { width: 1000, height: 800 };

  it("ends above an overlaying composer and follows its measured height", () => {
    expect(messageActionViewport({ scroller, window })).toEqual(viewport);
    expect(messageActionViewport({ scroller, window, composerTop: 520 }).bottom).toBe(520);
    expect(messageActionViewport({ scroller, window, composerTop: 300 }).bottom).toBe(300);
    // An in-flow composer below the transcript changes nothing.
    expect(messageActionViewport({ scroller, window, composerTop: 640 })).toEqual(viewport);
  });

  it("moves the footer above the message once a tall composer covers its bottom", () => {
    const short = messageActionViewport({ scroller, window, composerTop: 520 });
    const tall = messageActionViewport({ scroller, window, composerTop: 400 });
    expect(place({}, short)).toEqual({ kind: "footer" });
    expect(place({}, tall)).toEqual({ kind: "above", top: 114, left: 100 });
    // Taller still: the composer covers the message's top half, so the rail is used.
    expect(place({ top: 99 }, tall)).toEqual({ kind: "side", top: 204, left: 808 });
  });

  it("aligns a floated row with right-aligned messages", () => {
    expect(
      messageActionPlacement({
        message: { top: 150, bottom: 900, left: 400, right: 800 },
        viewport,
        row,
        column,
        align: "end",
      }),
    ).toEqual({ kind: "above", top: 114, left: 708 });
  });
});

type Rect = { top: number; bottom: number; left: number; right: number };
function rect({ top, bottom, left, right }: Rect) {
  return { top, bottom, left, right, x: left, y: top, width: right - left, height: bottom - top };
}

describe("shared message action bar", () => {
  it("flips to a visible position when the live composer grows over the footer", () => {
    let composerTop = 560;
    const observed: Element[] = [];
    let notify = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          notify = callback;
        }
        observe(element: Element) {
          observed.push(element);
        }
        disconnect() {}
      },
    );
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback),
    );
    const resize = () =>
      act(() => {
        notify();
        for (const frame of frames.splice(0)) frame(0);
      });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains("transcript") ? 600 : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains("transcript") ? 800 : 0;
      },
    );
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        const element = this as HTMLElement;
        if (element.classList.contains("transcript"))
          return rect({ top: 0, bottom: 600, left: 0, right: 800 }) as DOMRect;
        if (element.classList.contains("workbench-composer"))
          return rect({ top: composerTop, bottom: 600, left: 0, right: 800 }) as DOMRect;
        const slot = element.dataset.slot;
        if (slot === "message")
          return rect({ top: 100, bottom: 520, left: 100, right: 700 }) as DOMRect;
        if (slot === "message-content")
          return rect({ top: 136, bottom: 480, left: 100, right: 700 }) as DOMRect;
        if (slot === "message-actions")
          return rect({ top: 486, bottom: 514, left: 100, right: 700 }) as DOMRect;
        if (element.tagName === "BUTTON")
          return rect({ top: 0, bottom: 28, left: 0, right: 28 }) as DOMRect;
        return rect({ top: 0, bottom: 0, left: 0, right: 0 }) as DOMRect;
      },
    );

    const { container } = render(
      <div data-slot="chat">
        <div className="transcript">
          <Message
            actions={<IconButton ariaLabel="Copy response">Copy</IconButton>}
            fullscreen={{ label: "View response fullscreen", onClick: () => {} }}
          >
            <MessageContent>Long response</MessageContent>
          </Message>
        </div>
        <div data-slot="composer-dock">
          <div className="workbench-composer" />
        </div>
      </div>,
    );
    const toolbar = container.querySelector<HTMLElement>('[data-slot="message-action-toolbar"]')!;
    expect(toolbar.dataset.placement).toBe("footer");
    expect(observed).toContain(container.querySelector('[data-slot="composer-dock"]'));

    // The draft grows: the composer now covers the message's last lines and footer.
    composerTop = 400;
    resize();
    expect(toolbar.dataset.placement).toBe("above");
    // Above the body, never over it: 136 (body top) - 8 (gap) - 28 (row), relative to the slot.
    expect(toolbar.style.top).toBe(`${136 - 8 - 28 - 486}px`);

    composerTop = 560;
    resize();
    expect(toolbar.dataset.placement).toBe("footer");
  });

  it("places fullscreen in the same action group as Copy, after it", () => {
    const { container } = render(
      <Message
        actions={<IconButton ariaLabel="Copy response">Copy</IconButton>}
        fullscreen={{ label: "View response fullscreen", onClick: () => {} }}
      >
        <MessageContent>Body</MessageContent>
      </Message>,
    );
    const toolbar = container.querySelector<HTMLElement>('[data-slot="message-action-toolbar"]')!;
    expect(
      within(toolbar)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Copy response", "View response fullscreen"]);
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("gives a fullscreen-only message the shared toolbar too", () => {
    const { container } = render(
      <Message fullscreen={{ label: "View response fullscreen", onClick: () => {} }}>
        <MessageContent>Body</MessageContent>
      </Message>,
    );
    const toolbar = container.querySelector('[data-slot="message-action-toolbar"]')!;
    expect(
      within(toolbar as HTMLElement)
        .getByRole("button")
        .getAttribute("aria-label"),
    ).toBe("View response fullscreen");
  });

  it.each([false, true])(
    "gives a session message (open=%s) Copy, a link-only Open source and fullscreen in one bar",
    (open) => {
      const sessionPurpose = vi.fn(() => "delegated" as const);
      const { container } = render(
        <MarkdownLinkProvider
          actions={{ openSession: vi.fn(), openExternalUrl: vi.fn(), sessionPurpose }}
        >
          <SessionMessage
            source={{
              sessionId: "worker",
              title: "Widget worker",
              href: "cake://session/worker?message=m1",
            }}
            preview={"Report body. ".repeat(500)}
            defaultOpen={open}
            messageActions={<IconButton ariaLabel="Copy response">Copy</IconButton>}
          />
        </MarkdownLinkProvider>,
      );
      const card = screen.getByRole("region", { name: "Message from another session" });
      expect(card.querySelectorAll('[data-slot="message-action-toolbar"]')).toHaveLength(1);
      const toolbar = card.querySelector<HTMLElement>('[data-slot="message-action-toolbar"]')!;
      const controls = Array.from(toolbar.querySelectorAll("button, a"), (control) =>
        control.getAttribute("aria-label"),
      );
      expect(controls).toEqual([
        "Copy response",
        "Open source",
        "View message fullscreen: Widget worker",
      ]);
      const link = within(toolbar).getByRole("link", { name: "Open source" });
      expect(link.querySelectorAll("svg")).toHaveLength(1);
      expect(link.querySelector('[data-slot="session-purpose"]')).toBeNull();
      expect(container.querySelector('[data-slot="session-purpose"]')).toBeNull();
      // Nothing sits in the header beside the disclosure any more.
      const header = card.querySelector('[data-slot="session-message-card"]')!;
      expect(header.querySelector("a, .fullscreen-trigger")).toBeNull();
      expect(
        within(card).getByRole("button", { name: "Widget worker" }).getAttribute("aria-expanded"),
      ).toBe(String(open));
    },
  );

  it("uses the shared bar for human and skill messages, aligned to their edge", () => {
    const { container } = render(
      <>
        <ChatTextMessage
          part={{ id: "u1", kind: "text", role: "user", text: "Hello", status: "complete" }}
          messageActions={<IconButton ariaLabel="Copy message">Copy</IconButton>}
        />
        <SkillMessage
          part={{ id: "s1", kind: "skill", name: "effect-ts", content: "# Effect" } as never}
          actions={<IconButton ariaLabel="Edit latest prompt">Edit</IconButton>}
        />
      </>,
    );
    const toolbars = Array.from(
      container.querySelectorAll<HTMLElement>('[data-slot="message-action-toolbar"]'),
    );
    expect(toolbars).toHaveLength(2);
    expect(within(toolbars[0]!).getByRole("button", { name: "Copy message" })).toBeTruthy();
    expect(toolbars[0]!.classList.contains("justify-end")).toBe(true);
    expect(within(toolbars[1]!).getByRole("button", { name: "Edit latest prompt" })).toBeTruthy();
    expect(toolbars[1]!.classList.contains("justify-end")).toBe(false);
  });
});

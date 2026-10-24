/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranscriptScrollOwner } from "../../../src/renderer/lib/transcript-scroll-owner";

describe("transcript scroll owner measurement boundaries", () => {
  let scroller: HTMLDivElement;
  let list: HTMLDivElement;
  let owner: ReturnType<typeof createTranscriptScrollOwner>;
  let shift: number;
  let contentHeight: number;

  function addRow(key: string, top: number, height: number, knownHeight = height) {
    const wrapper = document.createElement("div");
    wrapper.dataset.knownSize = String(knownHeight);
    Object.defineProperty(wrapper, "offsetHeight", { get: () => height });
    const row = document.createElement("div");
    row.dataset.transcriptItemKey = key;
    row.getBoundingClientRect = () =>
      ({
        top: top + shift - scroller.scrollTop,
        bottom: top + shift - scroller.scrollTop + height,
        height,
      }) as DOMRect;
    wrapper.append(row);
    list.append(wrapper);
    return wrapper;
  }

  beforeEach(() => {
    shift = 0;
    contentHeight = 4_000;
    scroller = document.createElement("div");
    const content = document.createElement("div");
    list = document.createElement("div");
    list.setAttribute("aria-label", "Conversation");
    content.append(list);
    scroller.append(content);
    document.body.append(scroller);
    let scrollTop = 0;
    Object.defineProperties(scroller, {
      clientHeight: { value: 600 },
      scrollHeight: { get: () => contentHeight },
      scrollTop: {
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = Math.max(0, Math.min(value, contentHeight - 600));
        },
      },
    });
    scroller.getBoundingClientRect = () => ({ top: 0, bottom: 600 }) as DOMRect;
    scroller.scrollTop = 1_000;
    addRow("reading", 980, 200);
    addRow("next", 1_180, 200);
    owner = createTranscriptScrollOwner(scroller, content, {
      following: false,
      cancelVirtualNavigation: vi.fn(),
    });
    owner.reconcile();
  });

  afterEach(() => {
    owner.dispose();
    scroller.remove();
  });

  it("ignores transient range estimates, then compensates settled padding once", () => {
    const mounted = addRow("older", 700, 300, 100);
    shift = 700;
    owner.reconcile();
    expect(scroller.scrollTop).toBe(1_000);

    // Measurement replaces both the row estimate and the provisional padding.
    mounted.dataset.knownSize = "300";
    shift = 80;
    owner.reconcile();
    expect(scroller.scrollTop).toBe(1_080);
    owner.reconcile();
    expect(scroller.scrollTop).toBe(1_080);
  });

  it("does not capture a provisional anchor when a native scroll event arrives during measurement", () => {
    const mounted = addRow("older", 700, 300, 100);
    shift = 700;
    scroller.scrollTop -= 120;
    scroller.dispatchEvent(new Event("scroll"));
    expect(scroller.scrollTop).toBe(880);

    mounted.dataset.knownSize = "300";
    shift = 80;
    owner.reconcile();
    expect(scroller.scrollTop).toBe(960);
  });

  it("compensates an existing row resize before the virtualizer measures it again", () => {
    const existing = list.firstElementChild as HTMLElement;
    existing.dataset.knownSize = "100";
    shift = 100;
    owner.reconcile();
    expect(scroller.scrollTop).toBe(1_100);
  });

  it("preserves the anchor when measured older rows are prepended", () => {
    const older = addRow("older", 700, 300);
    list.prepend(older);
    shift = 300;
    owner.reconcile();
    expect(scroller.scrollTop).toBe(1_300);
  });

  it("continues following tail growth even while new rows await measurement", () => {
    owner.scrollToBottomForSentMessage();
    addRow("tail", 3_000, 300, 100);
    contentHeight += 300;
    owner.reconcile();
    expect(scroller.scrollTop).toBe(3_700);
  });
});

// The reader's rule: follow only while at the very bottom; any upward movement
// away from it is the reader's, whether or not the transcript saw any input.
describe("transcript scroll owner following", () => {
  let scroller: HTMLDivElement;
  let owner: ReturnType<typeof createTranscriptScrollOwner>;
  let contentHeight: number;

  beforeEach(() => {
    contentHeight = 4_000;
    scroller = document.createElement("div");
    const content = document.createElement("div");
    const row = document.createElement("div");
    row.dataset.transcriptItemKey = "row";
    row.getBoundingClientRect = () =>
      ({
        top: -scroller.scrollTop,
        bottom: contentHeight - scroller.scrollTop,
        height: contentHeight,
      }) as DOMRect;
    content.append(row);
    scroller.append(content);
    document.body.append(scroller);
    let scrollTop = 0;
    Object.defineProperties(scroller, {
      clientHeight: { value: 600 },
      scrollHeight: { get: () => contentHeight },
      scrollTop: {
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = Math.max(0, Math.min(value, contentHeight - 600));
        },
      },
    });
    scroller.getBoundingClientRect = () => ({ top: 0, bottom: 600 }) as DOMRect;
    owner = createTranscriptScrollOwner(scroller, content, {
      following: true,
      cancelVirtualNavigation: vi.fn(),
    });
    owner.reconcile();
  });

  afterEach(() => {
    owner.dispose();
    scroller.remove();
  });

  const grow = (pixels: number) => {
    contentHeight += pixels;
    owner.reconcile();
  };

  function disclosure(expanded = false) {
    const trigger = document.createElement("button");
    trigger.dataset.slot = "response-disclosure";
    trigger.setAttribute("aria-expanded", String(expanded));
    scroller.firstElementChild!.append(trigger);
    return trigger;
  }

  it("pauses following before the response click handler expands its body", () => {
    const trigger = disclosure();
    trigger.addEventListener("click", () => grow(1_800));
    trigger.click();
    expect(scroller.scrollTop).toBe(3_400);
    // The original can load later; pausing is not limited to the first resize.
    grow(600);
    expect(scroller.scrollTop).toBe(3_400);
  });

  it("does not change a scrolled-up reading position on open or later user movement", () => {
    scroller.scrollTop -= 400;
    scroller.dispatchEvent(new Event("scroll"));
    disclosure().click();
    grow(1_800);
    expect(scroller.scrollTop).toBe(3_000);
    scroller.scrollTop += 200;
    scroller.dispatchEvent(new Event("scroll"));
    grow(200);
    expect(scroller.scrollTop).toBe(3_200);
  });

  it("preserves following for collapse and unrelated disclosures", () => {
    disclosure(true).click();
    grow(200);
    expect(scroller.scrollTop).toBe(3_600);
    const unrelated = disclosure();
    unrelated.removeAttribute("data-slot");
    unrelated.click();
    grow(200);
    expect(scroller.scrollTop).toBe(3_800);
  });

  it("resumes following at the bottom and pauses again on reopen", () => {
    const trigger = disclosure();
    trigger.click();
    grow(1_800);
    scroller.scrollTop = contentHeight;
    scroller.dispatchEvent(new Event("scroll"));
    grow(200);
    expect(scroller.scrollTop).toBe(5_400);
    trigger.setAttribute("aria-expanded", "true");
    trigger.click();
    trigger.setAttribute("aria-expanded", "false");
    trigger.click();
    grow(1_000);
    expect(scroller.scrollTop).toBe(5_400);
    owner.scrollToBottomForSentMessage();
    expect(scroller.scrollTop).toBe(6_400);
  });

  it("follows growth while at the bottom", () => {
    expect(scroller.scrollTop).toBe(3_400);
    grow(200);
    expect(scroller.scrollTop).toBe(3_600);
  });

  it("keeps an upward movement whose scroll event is still queued behind a commit", () => {
    scroller.scrollTop -= 120;
    grow(200);
    expect(scroller.scrollTop).toBe(3_280);
    scroller.dispatchEvent(new Event("scroll"));
    grow(200);
    expect(scroller.scrollTop).toBe(3_280);
  });

  it("keeps an upward movement that arrives together with unreconciled growth", () => {
    scroller.scrollTop -= 120;
    contentHeight += 200;
    scroller.dispatchEvent(new Event("scroll"));
    expect(scroller.scrollTop).toBe(3_280);
    grow(200);
    expect(scroller.scrollTop).toBe(3_280);
  });

  it("treats a one-pixel upward movement as leaving the bottom", () => {
    scroller.scrollTop -= 1;
    scroller.dispatchEvent(new Event("scroll"));
    grow(200);
    expect(scroller.scrollTop).toBe(3_399);
  });

  it("keeps following through a browser clamp when content shrinks", () => {
    contentHeight -= 300;
    scroller.scrollTop = contentHeight; // the browser clamps to the new end
    scroller.dispatchEvent(new Event("scroll"));
    grow(200);
    expect(scroller.scrollTop).toBe(3_300);
  });

  it("resumes following only when the reader returns to the bottom", () => {
    scroller.scrollTop -= 400;
    scroller.dispatchEvent(new Event("scroll"));
    scroller.scrollTop += 200;
    scroller.dispatchEvent(new Event("scroll"));
    grow(200);
    expect(scroller.scrollTop).toBe(3_200);
    scroller.scrollTop = contentHeight;
    scroller.dispatchEvent(new Event("scroll"));
    grow(200);
    expect(scroller.scrollTop).toBe(contentHeight - 600);
  });

  it("stops following on upward wheel input before its scroll event", () => {
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    grow(200);
    expect(scroller.scrollTop).toBe(3_400);
  });

  it("returns to the bottom for a sent message", () => {
    scroller.scrollTop -= 800;
    scroller.dispatchEvent(new Event("scroll"));
    owner.scrollToBottomForSentMessage();
    expect(scroller.scrollTop).toBe(3_400);
    grow(200);
    expect(scroller.scrollTop).toBe(3_600);
  });
});

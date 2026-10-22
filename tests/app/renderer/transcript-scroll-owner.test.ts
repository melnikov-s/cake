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

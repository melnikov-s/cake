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

  it("finishes a restored row's exact offset after hidden index estimates settle", () => {
    owner.dispose();
    const row = list.firstElementChild!.firstElementChild as HTMLElement;
    row.dataset.transcriptAnchorId = "saved-message";
    list.style.visibility = "hidden";
    scroller.scrollTop = 1_097;
    const cancelVirtualNavigation = vi.fn();
    owner = createTranscriptScrollOwner(scroller, scroller.firstElementChild as HTMLElement, {
      following: false,
      restore: { messageId: "saved-message", offset: -9 },
      cancelVirtualNavigation,
    });
    owner.reconcile();
    expect(scroller.scrollTop).toBe(1_097);

    const provisional = addRow("older", 700, 200, 100);
    list.style.visibility = "visible";
    owner.reconcile();
    expect(scroller.scrollTop).toBe(1_097);
    expect(cancelVirtualNavigation).not.toHaveBeenCalled();

    provisional.dataset.knownSize = "200";
    owner.reconcile();
    expect(scroller.scrollTop).toBe(989);
    expect(row.getBoundingClientRect().top).toBe(-9);
    expect(cancelVirtualNavigation).toHaveBeenCalledOnce();

    // Restoration is one-shot; normal reading compensation owns later resizes.
    shift = 80;
    owner.reconcile();
    expect(scroller.scrollTop).toBe(1_069);
    expect(row.getBoundingClientRect().top).toBe(-9);
    expect(cancelVirtualNavigation).toHaveBeenCalledOnce();
    scroller.scrollTop += 100;
    scroller.dispatchEvent(new Event("scroll"));
    owner.reconcile();
    expect(scroller.scrollTop).toBe(1_169);
  });

  it("yields pending restoration to reader input before the row is revealed", () => {
    owner.dispose();
    const row = list.firstElementChild!.firstElementChild as HTMLElement;
    row.dataset.transcriptAnchorId = "saved-message";
    list.style.visibility = "hidden";
    scroller.scrollTop = 1_097;
    const cancelVirtualNavigation = vi.fn();
    owner = createTranscriptScrollOwner(scroller, scroller.firstElementChild as HTMLElement, {
      following: false,
      restore: { messageId: "saved-message", offset: -9 },
      cancelVirtualNavigation,
    });
    owner.reconcile();
    scroller.dispatchEvent(new Event("pointerdown"));
    list.style.visibility = "visible";
    owner.reconcile();
    expect(scroller.scrollTop).toBe(1_097);
    expect(cancelVirtualNavigation).toHaveBeenCalledOnce();
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

  it("compensates a previously measured row remounting with a smaller loading body", () => {
    const diagram = addRow("diagram", 500, 400);
    owner.reconcile();
    diagram.remove();
    owner.reconcile();

    // The virtualizer remembers the loaded diagram's height, but its remount
    // initially renders only a small spinner. This is a real content resize,
    // not an unknown row's provisional range estimate.
    addRow("diagram", 500, 100, 400);
    shift = -300;
    contentHeight -= 300;
    owner.reconcile();
    expect(scroller.scrollTop).toBe(700);
    owner.reconcile();
    expect(scroller.scrollTop).toBe(700);
  });

  function pagingOwner(loadEarlier: (beforePrepend: () => void) => boolean) {
    owner.dispose();
    owner = createTranscriptScrollOwner(scroller, scroller.firstElementChild as HTMLElement, {
      following: false,
      cancelVirtualNavigation: vi.fn(),
      loadEarlier,
    });
  }

  function scroll(top: number) {
    scroller.scrollTop = top;
    scroller.dispatchEvent(new Event("scroll"));
  }

  it("admits one page per reader approach, not duplicate events or streaming/layout", () => {
    const load = vi.fn(() => true);
    pagingOwner(load);
    owner.reconcile();
    expect(load).not.toHaveBeenCalled();
    scroll(150);
    expect(load).toHaveBeenCalledOnce();
    for (let i = 0; i < 20; i++) {
      scroller.dispatchEvent(new Event("scroll"));
      owner.reconcile();
    }
    scroll(120);
    expect(load).toHaveBeenCalledOnce();
    // A prepend retains the reader outside the threshold. Continued upward
    // reading, rather than a click or another layout commit, admits page two.
    scroll(800);
    scroll(150);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not page initial bottom, hidden, covered, positioning or disposed views", () => {
    const load = vi.fn(() => true);
    pagingOwner(load);
    scroll(3400);
    owner.reconcile();
    expect(load).not.toHaveBeenCalled();
    list.style.visibility = "hidden";
    scroll(150);
    expect(load).not.toHaveBeenCalled();
    list.style.visibility = "visible";
    scroller.style.visibility = "hidden";
    scroll(800);
    scroll(150);
    expect(load).not.toHaveBeenCalled();
    scroller.style.visibility = "visible";
    owner.setCovered(true);
    scroll(800);
    scroll(150);
    expect(load).not.toHaveBeenCalled();
    owner.dispose();
    scroll(800);
    scroll(150);
    expect(load).not.toHaveBeenCalled();
  });

  it("requires a new gesture at absolute top rather than draining while the threshold stays visible", () => {
    const load = vi.fn(() => true);
    pagingOwner(load);
    const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
    try {
      scroll(0);
      expect(load).toHaveBeenCalledOnce();
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
      expect(load).toHaveBeenCalledOnce();
      for (let i = 0; i < 20; i++) {
        clock.mockReturnValue(1000 + i * 10);
        scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
        owner.reconcile();
      }
      expect(load).toHaveBeenCalledOnce();
      clock.mockReturnValue(2000);
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("retains a prepended anchor even when its old virtual range is evicted", () => {
    const navigate = vi.fn();
    owner.dispose();
    let currentIndex = 0;
    owner = createTranscriptScrollOwner(scroller, scroller.firstElementChild as HTMLElement, {
      following: false,
      cancelVirtualNavigation: vi.fn(),
      itemIndex: () => currentIndex,
    });
    const reading = list.firstElementChild as HTMLElement;
    reading.dataset.index = "0";
    owner.reconcile();
    owner.preserveForPrepend(navigate);
    // React committed the new page, but Virtuoso still exposes the old range.
    currentIndex = 64;
    owner.reconcile();
    reading.remove();
    shift = 1200;
    contentHeight += 1200;
    owner.reconcile();
    expect(navigate).toHaveBeenCalledExactlyOnceWith("reading");
    owner.reconcile();
    expect(navigate).toHaveBeenCalledOnce();
    reading.dataset.index = "64";
    list.prepend(reading);
    // The virtualizer reaches an estimate first, then the owner restores the
    // exact old -20px row offset and keeps compensating late image growth.
    scroller.scrollTop = 2100;
    owner.reconcile();
    expect(scroller.scrollTop).toBe(2200);
    shift += 380;
    owner.reconcile();
    expect(scroller.scrollTop).toBe(2580);
  });

  it("preserves the anchor when measured older rows are prepended", () => {
    const older = addRow("older", 700, 300);
    list.prepend(older);
    shift = 300;
    owner.reconcile();
    expect(scroller.scrollTop).toBe(1_300);
  });

  it("refreshes the reading anchor after a manual scroll settles its virtual range", () => {
    const mounted = addRow("older", 700, 300, 100);
    scroller.scrollTop = 1_200;
    scroller.dispatchEvent(new Event("scroll"));
    mounted.dataset.knownSize = "300";
    owner.reconcile();
    // The old anchor has left overscan. A late image above the current reading
    // row must still be compensated, rather than capturing shifted geometry.
    list.firstElementChild!.remove();
    shift = 280;
    owner.reconcile();
    expect(scroller.scrollTop).toBe(1_480);
    owner.reconcile();
    expect(scroller.scrollTop).toBe(1_480);
  });

  it("holds the first displaced visible prose when media grows inside its row", () => {
    list.replaceChildren();
    const row = addRow("tall", 980, 2_200).firstElementChild!;
    let growth = 0;
    for (const [top, afterMedia] of [
      [1_040, false],
      [1_200, true],
      [1_400, true],
    ] as const) {
      const paragraph = document.createElement("p");
      paragraph.textContent = "Visible reading content";
      paragraph.getBoundingClientRect = () =>
        ({
          top: top + (afterMedia ? growth : 0) - scroller.scrollTop,
          bottom: top + (afterMedia ? growth : 0) + 20 - scroller.scrollTop,
          height: 20,
        }) as DOMRect;
      row.append(paragraph);
    }
    owner.reconcile();
    growth = 800;
    contentHeight += growth;
    owner.reconcile();
    expect(scroller.scrollTop).toBe(1_800);
    owner.reconcile();
    expect(scroller.scrollTop).toBe(1_800);
  });

  it("falls back to the stable row when React replaces its reading content", () => {
    const row = list.querySelector<HTMLElement>("[data-transcript-item-key]")!;
    const paragraph = document.createElement("p");
    paragraph.textContent = "Reading content";
    paragraph.getBoundingClientRect = () => ({ top: 100, bottom: 120, height: 20 }) as DOMRect;
    row.append(paragraph);
    owner.reconcile();
    paragraph.remove();
    shift = 80;
    owner.reconcile();
    expect(scroller.scrollTop).toBe(1_080);
  });

  it("keeps a sent-message jump following through virtual estimate corrections", () => {
    owner.setSelecting(true);
    owner.scrollToBottomForSentMessage({
      itemKey: "last",
      scrollToIndex: vi.fn(),
    });
    // The destination is still unrendered. Virtual navigation corrects the
    // estimated bottom before the next measurement/scroll event arrives.
    scroller.scrollTop = 2_000;
    contentHeight = 4_300;
    // Clearing the keyboard selection is part of sending, not a request to
    // abandon the still-unmeasured bottom destination.
    owner.setSelecting(false);
    owner.reconcile();
    expect(scroller.scrollTop).toBe(3_700);
    addRow("last", 4_000, 300);
    owner.reconcile();
    contentHeight += 400;
    owner.reconcile();
    expect(scroller.scrollTop).toBe(4_100);
  });

  it.each(["wheel", "pointerdown", "keydown"])(
    "lets %s reader input cancel a pending sent-message destination",
    (input) => {
      owner.scrollToBottomForSentMessage({ itemKey: "last", scrollToIndex: vi.fn() });
      scroller.dispatchEvent(
        input === "wheel"
          ? new WheelEvent("wheel", { deltaY: -100 })
          : input === "keydown"
            ? new KeyboardEvent("keydown", { key: "PageUp" })
            : new Event("pointerdown"),
      );
      scroller.scrollTop -= 100;
      scroller.dispatchEvent(new Event("scroll"));
      contentHeight += 400;
      addRow("last", 4_000, 300);
      owner.reconcile();
      expect(scroller.scrollTop).toBe(3_300);
    },
  );

  it.each(["wheel", "pointerdown", "keydown"])(
    "lets %s cancel send ownership even after virtual navigation settled",
    (input) => {
      addRow("last", 3_000, 300);
      owner.scrollToBottomForSentMessage({ itemKey: "last", scrollToIndex: vi.fn() });
      owner.reconcile();
      scroller.dispatchEvent(
        input === "wheel"
          ? new WheelEvent("wheel", { deltaY: -100 })
          : input === "keydown"
            ? new KeyboardEvent("keydown", { key: "PageUp" })
            : new Event("pointerdown"),
      );
      scroller.scrollTop -= 100;
      contentHeight += 400;
      owner.reconcile();
      expect(scroller.scrollTop).toBe(3_300);
    },
  );

  it("keeps an ordinary send at the actual bottom after a measured row, footer clamp, then virtual growth", () => {
    addRow("last", 3_000, 300);
    scroller.style.setProperty("--composer-dock-height", "600px");
    owner.scrollToBottomForSentMessage({ itemKey: "last", scrollToIndex: vi.fn() });
    owner.reconcile();
    // The browser clamps while the attention/composer header shrinks; the
    // virtualizer publishes its larger measured total before our next callback.
    contentHeight -= 600;
    scroller.scrollTop = scroller.scrollTop;
    scroller.style.setProperty("--composer-dock-height", "0px");
    contentHeight += 600;
    owner.reconcile();
    expect(scroller.scrollTop).toBe(3_400);
    contentHeight += 100;
    owner.reconcile();
    expect(scroller.scrollTop).toBe(3_500);
  });

  it.each(["same-geometry clamp", "delayed virtual correction"])(
    "keeps send ownership through %s after navigation settles",
    (movement) => {
      addRow("last", 3_000, 300);
      owner.scrollToBottomForSentMessage({ itemKey: "last", scrollToIndex: vi.fn() });
      owner.reconcile();
      if (movement === "same-geometry clamp") {
        contentHeight -= 1_200;
        scroller.scrollTop = scroller.scrollTop;
        contentHeight += 1_200;
      } else scroller.scrollTop -= 1_200;
      scroller.dispatchEvent(new Event("scroll"));
      owner.reconcile();
      expect(scroller.scrollTop).toBe(3_400);
      contentHeight += 1_000;
      owner.reconcile();
      expect(scroller.scrollTop).toBe(4_400);
    },
  );

  it("follows the actual submitted row when admission replaces the old destination and loading row later", () => {
    addRow("old-last", 3_000, 300);
    owner.scrollToBottomForSentMessage({ itemKey: "old-last", scrollToIndex: vi.fn() });
    owner.reconcile();
    addRow("loading", 3_300, 100);
    owner.reconcile();
    list.lastElementChild!.remove();
    addRow("submitted", 3_300, 800, 100);
    contentHeight += 700;
    scroller.scrollTop -= 500;
    owner.reconcile();
    expect(scroller.scrollTop).toBe(4_100);
    list.lastElementChild!.setAttribute("data-known-size", "800");
    contentHeight += 300;
    owner.reconcile();
    expect(scroller.scrollTop).toBe(4_400);
  });

  it("respects forwarded embedded reader input after the send row measures", () => {
    addRow("last", 3_000, 300);
    owner.scrollToBottomForSentMessage({ itemKey: "last", scrollToIndex: vi.fn() });
    owner.reconcile();
    const frame = document.createElement("iframe");
    scroller.append(frame);
    frame.dispatchEvent(new CustomEvent("transcript-reader-input", { bubbles: true, detail: -1 }));
    scroller.scrollTop -= 100;
    scroller.dispatchEvent(new Event("scroll"));
    contentHeight += 400;
    owner.reconcile();
    expect(scroller.scrollTop).toBe(3_300);
  });

  it.each([100, 1_400])(
    "reveals the START of an already-rendered %i-pixel result and holds it through expansion",
    (height) => {
      addRow("result", 1_700, height);
      owner.revealResult("result", vi.fn(), vi.fn());
      expect(scroller.scrollTop).toBe(1_684);
      contentHeight += 1_000;
      owner.reconcile();
      expect(scroller.scrollTop).toBe(1_684);
      shift = 120;
      owner.reconcile();
      expect(scroller.scrollTop).toBe(1_804);
    },
  );

  it("waits for a delayed virtual result's real measurement, not an unrelated latest row", () => {
    const navigate = vi.fn();
    owner.revealResult(undefined, navigate, vi.fn());
    contentHeight += 500;
    owner.reconcile();
    expect(scroller.scrollTop).toBe(1_000);
    owner.revealResult("result", navigate, vi.fn());
    expect(navigate).toHaveBeenCalledOnce();
    const wrapper = addRow("result", 2_000, 1_200, 200);
    owner.reconcile();
    expect(scroller.scrollTop).toBe(1_000);
    wrapper.dataset.knownSize = "1200";
    owner.reconcile();
    expect(scroller.scrollTop).toBe(1_984);
  });

  it("keeps a short end result's start readable as it grows beyond a viewport", () => {
    contentHeight = 2_000;
    addRow("result", 1_900, 100);
    owner.revealResult("result", vi.fn(), vi.fn());
    expect(scroller.scrollTop).toBe(1_400); // Native bottom clamp.
    contentHeight += 1_000;
    owner.reconcile();
    expect(scroller.scrollTop).toBe(1_884);
    contentHeight += 1_000;
    owner.reconcile();
    expect(scroller.scrollTop).toBe(1_884);
  });

  it.each(["wheel", "pointerdown", "keydown"])(
    "lets %s cancel a delayed result reveal",
    (input) => {
      const cancel = vi.fn();
      owner.revealResult("result", vi.fn(), cancel);
      scroller.dispatchEvent(
        input === "wheel"
          ? new WheelEvent("wheel", { deltaY: -100 })
          : input === "keydown"
            ? new KeyboardEvent("keydown", { key: "PageUp" })
            : new Event("pointerdown"),
      );
      expect(cancel).toHaveBeenCalledOnce();
      scroller.scrollTop = 900;
      scroller.dispatchEvent(new Event("scroll"));
      addRow("result", 2_000, 1_000);
      contentHeight += 1_000;
      owner.reconcile();
      expect(scroller.scrollTop).toBe(900);
    },
  );

  it("a newer ordinary send supersedes a result reveal, including later materialization and growth", () => {
    const cancel = vi.fn();
    owner.revealResult("result", vi.fn(), cancel);
    owner.scrollToBottomForSentMessage();
    expect(cancel).toHaveBeenCalledOnce();
    addRow("result", 2_000, 1_000);
    contentHeight += 1_000;
    owner.reconcile();
    expect(scroller.scrollTop).toBe(4_400);
  });

  it("a late earlier-history read cannot override a newer send even after its row measured", () => {
    let beforePrepend: (() => void) | undefined;
    pagingOwner((before) => {
      beforePrepend = before;
      return true;
    });
    scroll(150);
    addRow("last", 3_000, 300);
    owner.scrollToBottomForSentMessage({ itemKey: "last", scrollToIndex: vi.fn() });
    owner.reconcile();
    beforePrepend?.();
    shift = 500;
    contentHeight += 500;
    owner.reconcile();
    expect(scroller.scrollTop).toBe(3_900);
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
  let viewportHeight: number;

  beforeEach(() => {
    contentHeight = 4_000;
    viewportHeight = 600;
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
      clientHeight: { get: () => viewportHeight },
      scrollHeight: { get: () => contentHeight },
      scrollTop: {
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = Math.max(0, Math.min(value, contentHeight - viewportHeight));
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

  it("holds the reading position for both task-stretch disclosure directions", () => {
    const trigger = disclosure();
    trigger.dataset.slot = "task-section-disclosure";
    trigger.click();
    grow(200);
    expect(scroller.scrollTop).toBe(3_400);
    owner.scrollToBottomForSentMessage();
    trigger.setAttribute("aria-expanded", "true");
    trigger.click();
    grow(200);
    expect(scroller.scrollTop).toBe(3_600);
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

  it("keeps a covered artifact row still through sends, incoming growth and bottom clamps", () => {
    owner.setSelecting(true);
    owner.setCovered(true);
    // A covered transcript at the end can receive a queued scroll event or
    // browser clamp. It must not interpret that as the reader resuming follow.
    contentHeight -= 100;
    scroller.scrollTop = contentHeight;
    scroller.dispatchEvent(new Event("scroll"));
    grow(5_000);
    expect(scroller.scrollTop).toBe(3_300);
    const scrollToIndex = vi.fn();
    owner.scrollToBottomForSentMessage({ itemKey: "new-message", scrollToIndex });
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(3_300);
    // Explicit exit restores ordinary sent-message navigation.
    owner.setSelecting(false);
    owner.setCovered(false);
    owner.scrollToBottomForSentMessage();
    expect(scroller.scrollTop).toBe(contentHeight - 600);
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

  it("keeps following when selection chrome disappears before expanded sections are measured", () => {
    expect(scroller.scrollTop).toBe(3_400);
    viewportHeight += 33;
    // Native layout clamps against the old total, then the virtualizer adds rows.
    scroller.scrollTop = contentHeight;
    contentHeight += 252;
    owner.reconcile();
    expect(scroller.scrollTop).toBe(3_619);
    contentHeight += 100;
    owner.reconcile();
    expect(scroller.scrollTop).toBe(3_719);
  });

  it("does not follow an upward reader movement while the viewport stays the same", () => {
    scroller.scrollTop -= 33;
    contentHeight += 252;
    owner.reconcile();
    expect(scroller.scrollTop).toBe(3_367);
  });

  it("keeps following through a browser clamp when content shrinks", () => {
    contentHeight -= 300;
    scroller.scrollTop = contentHeight; // the browser clamps to the new end
    scroller.dispatchEvent(new Event("scroll"));
    grow(200);
    expect(scroller.scrollTop).toBe(3_300);
  });

  it("does not resume following when a reading position is clamped to the end on collapse", () => {
    disclosure().click();
    grow(1_800);
    scroller.scrollTop += 180;
    scroller.dispatchEvent(new Event("scroll"));
    contentHeight = 4_000;
    scroller.scrollTop = contentHeight;
    scroller.dispatchEvent(new Event("scroll"));
    grow(140);
    expect(scroller.scrollTop).toBe(3_400);
  });

  it("resolves Home immediately and keeps reader ownership across updates", () => {
    scroller.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp" }));
    scroller.scrollTop -= 300;
    grow(200);
    const home = new KeyboardEvent("keydown", { key: "Home", cancelable: true });
    scroller.dispatchEvent(home);
    expect(home.defaultPrevented).toBe(true);
    expect(scroller.scrollTop).toBe(0);
    grow(200);
    expect(scroller.scrollTop).toBe(0);
  });

  it("leaves Home to editable inputs and nested scrollers", () => {
    const input = document.createElement("textarea");
    const nested = document.createElement("div");
    nested.style.overflowY = "auto";
    nested.scrollTop = 100;
    scroller.firstElementChild!.append(input, nested);
    for (const target of [input, nested]) {
      const home = new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true });
      target.dispatchEvent(home);
      expect(home.defaultPrevented).toBe(false);
      expect(scroller.scrollTop).toBe(3_400);
    }
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

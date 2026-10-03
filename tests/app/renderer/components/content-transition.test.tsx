/** @vitest-environment jsdom */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContentTransition } from "../../../../src/renderer/components/ui/content-transition";

const animations: Array<{ element: HTMLElement; animation: Animation }> = [];
const animate = vi.fn(function (this: HTMLElement) {
  const animation = { cancel: vi.fn(), onfinish: null } as unknown as Animation;
  animations.push({ element: this, animation });
  return animation;
});
function finish(animation: Animation) {
  act(() => animation.onfinish?.call(animation, {} as AnimationPlaybackEvent));
}
function content(contentKey: string, requestedKey = contentKey, ready = true) {
  return (
    <ContentTransition enabled contentKey={contentKey} requestedKey={requestedKey} ready={ready}>
      <div id="message" className="overflow-auto">
        {contentKey} transcript
      </div>
    </ContentTransition>
  );
}
beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  animate.mockClear();
  animations.length = 0;
});

describe("ContentTransition", () => {
  it("fades out, stays blank during loading, then fades in the matching ready content", () => {
    const view = render(content("a"));
    expect(animate).not.toHaveBeenCalled();
    view.rerender(content("a", "b"));
    const live = view.container.querySelector<HTMLElement>(
      '[data-slot="content-transition-live"]',
    )!;
    const outgoing = view.container.querySelector<HTMLElement>(
      '[data-slot="content-transition-outgoing"]',
    )!;
    expect(live.classList.contains("opacity-0")).toBe(true);
    expect(live.inert).toBe(true);
    expect(outgoing.textContent).toBe("a transcript");
    expect(outgoing.querySelector("[id]")).toBeNull();
    expect(animate).toHaveBeenCalledExactlyOnceWith([{ opacity: 1 }, { opacity: 0 }], {
      duration: 40,
      easing: "ease-out",
    });
    finish(animations[0]!.animation);
    expect(outgoing.childElementCount).toBe(0);
    expect(live.classList.contains("opacity-0")).toBe(true);
    view.rerender(content("b", "b", false));
    expect(animate).toHaveBeenCalledTimes(1);
    view.rerender(content("b"));
    expect(animate).toHaveBeenNthCalledWith(2, [{ opacity: 0 }, { opacity: 1 }], {
      duration: 80,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
    });
    expect(live.classList.contains("opacity-0")).toBe(false);
    expect(live.inert).toBe(false);
    expect(live.textContent).toBe("b transcript");
  });

  it("mounts a ready destination immediately but waits for the exit before revealing it", () => {
    const view = render(content("a"));
    view.rerender(content("b"));
    expect(view.container.querySelector('[data-slot="content-transition-live"]')?.textContent).toBe(
      "b transcript",
    );
    expect(animate).toHaveBeenCalledTimes(1);
    finish(animations[0]!.animation);
    expect(animate).toHaveBeenCalledTimes(2);
    view.rerender(content("b"));
    expect(animate).toHaveBeenCalledTimes(2);
  });

  it("drops interrupted exits and never reveals a stale destination", () => {
    const view = render(content("a"));
    view.rerender(content("a", "b"));
    const exit = animations[0]!.animation;
    view.rerender(content("a", "c"));
    expect(exit.cancel).toHaveBeenCalledOnce();
    expect(exit.onfinish).toBeNull();
    view.rerender(content("b", "c"));
    expect(animate).toHaveBeenCalledTimes(1);
    view.rerender(content("c"));
    expect(animate).toHaveBeenCalledTimes(2);
    const entrance = animations[1]!.animation;
    view.unmount();
    expect(entrance.cancel).toHaveBeenCalledOnce();
  });

  it("restores outgoing scroll offsets without retaining interactive content", () => {
    const view = render(content("a"));
    view.container.querySelector<HTMLElement>("#message")!.scrollTop = 240;
    view.rerender(content("b"));
    const outgoing = view.container.querySelector('[data-slot="content-transition-outgoing"]')!;
    expect(outgoing.querySelector<HTMLElement>(".overflow-auto")!.scrollTop).toBe(240);
    expect(outgoing.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    expect((outgoing.firstElementChild as HTMLElement).inert).toBe(true);
  });

  it("switches immediately under reduced motion or when disabled", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const view = render(content("a"));
    view.rerender(content("b"));
    expect(animate).not.toHaveBeenCalled();
    expect(
      view.container
        .querySelector('[data-slot="content-transition-live"]')
        ?.classList.contains("opacity-0"),
    ).toBe(false);
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    view.rerender(<ContentTransition contentKey="c">c transcript</ContentTransition>);
    expect(animate).not.toHaveBeenCalled();
  });
});

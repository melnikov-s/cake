/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { withInlineWidgetScrollInput } from "../../../../src/services/widgets/inline-widget-scroll-input";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function runtime() {
  const listeners = new Map<string, EventListener>();
  vi.spyOn(window, "addEventListener").mockImplementation((type, listener) => {
    if (typeof listener === "function") listeners.set(type, listener as EventListener);
  });
  const post = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
  const html = withInlineWidgetScrollInput("<head></head>", "token");
  const script = html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>"));
  new Function(script)();
  const input = (type: string, properties: object = {}) =>
    // Invoke the captured native-input boundary; dispatchEvent cannot create trusted input.
    listeners.get(type)!({
      isTrusted: true,
      target: document.body,
      ...properties,
    } as unknown as Event);
  return { post, input };
}

describe("opaque widget reader gestures", () => {
  it("forwards escaping wheel, pointer, keyboard and touch input, never synthetic or prevented gestures", () => {
    const { post, input } = runtime();
    input("wheel", { deltaY: -100, isTrusted: false });
    input("wheel", { deltaY: -100, defaultPrevented: true });
    input("wheel", { deltaY: 0 });
    expect(post).not.toHaveBeenCalled();
    input("wheel", { deltaY: -100 });
    input("pointerdown");
    input("keydown", { key: "PageUp" });
    input("touchstart", { touches: [{ clientY: 100 }] });
    input("touchmove", { touches: [{ clientY: 50 }] });
    expect(post.mock.calls.map(([message]) => message.value)).toEqual([-1, 0, -1, 1]);
    expect(post.mock.calls[0]).toEqual([
      { source: "cake-inline-widget", token: "token", type: "scroll-input", value: -1 },
      "*",
    ]);
  });

  it("leaves nested scrolling, overscroll containment and editable keys inside the widget", () => {
    const { post, input } = runtime();
    const nested = document.createElement("div");
    nested.style.overflowY = "auto";
    Object.defineProperties(nested, {
      scrollHeight: { value: 1_000 },
      clientHeight: { value: 100 },
    });
    nested.scrollTop = 50;
    const field = document.createElement("textarea");
    nested.append(field);
    document.body.append(nested);
    input("wheel", { target: nested, deltaY: -100 });
    input("keydown", { target: field, key: "PageUp" });
    expect(post).not.toHaveBeenCalled();
    nested.scrollTop = 0;
    nested.style.overscrollBehaviorY = "contain";
    input("wheel", { target: nested, deltaY: -100 });
    expect(post).not.toHaveBeenCalled();
    nested.style.overscrollBehaviorY = "auto";
    input("wheel", { target: nested, deltaY: -100 });
    expect(post).toHaveBeenCalledOnce();
  });
});

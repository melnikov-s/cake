/**
 * jsdom performs no layout, so a virtualized list would measure a zero-height
 * viewport and render no rows. DOM-only tests give list scroll areas a fixed
 * viewport, tall enough to show every row of a typical fixture, and every row
 * a fixed height, so content queries see real rows.
 * Real geometry, scrolling and the follow rules are verified in Electron.
 */
const scrollAreaSelector =
  '.transcript, [data-slot="work-log-content"], [data-slot="work-log-scroll"], [data-slot="todo-scroll-pane"]';
const viewportHeight = 8000;
const viewportWidth = 800;
const rowHeight = 100;

const isScrollArea = (element: Element) => element.matches(scrollAreaSelector);
/** A list row container: absolutely positioned inside the list's sized items wrapper. */
const isRow = (element: Element) =>
  element instanceof HTMLElement &&
  element.style.position === "absolute" &&
  element.parentElement?.style.position === "relative" &&
  element.closest(scrollAreaSelector) !== null;

export function installVirtualListLayout() {
  const element = Element.prototype;
  const html = HTMLElement.prototype;
  const clientHeight = Object.getOwnPropertyDescriptor(element, "clientHeight")!;
  const clientWidth = Object.getOwnPropertyDescriptor(element, "clientWidth")!;
  const scrollHeight = Object.getOwnPropertyDescriptor(element, "scrollHeight")!;
  const scrollTop = Object.getOwnPropertyDescriptor(element, "scrollTop")!;
  const tops = new WeakMap<Element, number>();
  const contentHeight = (area: Element) =>
    Array.from(area.querySelectorAll<HTMLElement>(":scope > div > div")).reduce(
      (total, child) => total + (Number.parseFloat(child.style.height) || 0),
      0,
    );
  Object.defineProperties(html, {
    clientHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return isScrollArea(this) ? viewportHeight : clientHeight.get!.call(this);
      },
    },
    clientWidth: {
      configurable: true,
      get(this: HTMLElement) {
        return isScrollArea(this) ? viewportWidth : clientWidth.get!.call(this);
      },
    },
    scrollHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return isScrollArea(this)
          ? Math.max(viewportHeight, contentHeight(this))
          : scrollHeight.get!.call(this);
      },
    },
    scrollTop: {
      configurable: true,
      get(this: HTMLElement) {
        return isScrollArea(this) ? (tops.get(this) ?? 0) : scrollTop.get!.call(this);
      },
      set(this: HTMLElement, value: number) {
        if (!isScrollArea(this)) return scrollTop.set!.call(this, value);
        const next = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
        if (next === (tops.get(this) ?? 0)) return;
        tops.set(this, next);
        // No scroll event: the list reads positions directly, and its scroll
        // handling would leave settle timers behind in fake-timer tests.
      },
    },
  });
  html.scrollTo = function (this: HTMLElement, options?: ScrollToOptions | number, y?: number) {
    this.scrollTop = typeof options === "object" ? (options.top ?? this.scrollTop) : (y ?? 0);
  } as typeof html.scrollTo;
  html.scrollBy = function (this: HTMLElement, options?: ScrollToOptions | number, y?: number) {
    this.scrollTop += typeof options === "object" ? (options.top ?? 0) : (y ?? 0);
  } as typeof html.scrollBy;
  // On divs, so a test's own geometry stub on HTMLElement still applies to everything else.
  HTMLDivElement.prototype.getBoundingClientRect = function (this: HTMLDivElement) {
    if (isScrollArea(this)) return new DOMRect(0, 0, viewportWidth, viewportHeight);
    if (isRow(this)) return new DOMRect(0, 0, viewportWidth, rowHeight);
    return HTMLElement.prototype.getBoundingClientRect.call(this);
  };
}

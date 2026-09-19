// React's test-only `act` export is absent from the production build.
process.env.NODE_ENV = "test";

// jsdom does not perform layout. Geometry and scrolling are exercised in
// Electron; DOM-only component tests just need the browser observer API.
if (typeof window !== "undefined" && !("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class implements ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// DOM-only tests default to reduced motion; real animation and media changes
// are verified in Electron (focused primitive tests can override this boundary).
if (typeof window !== "undefined" && !("FontFace" in globalThis)) {
  globalThis.FontFace = class {
    family: string;
    status: FontFaceLoadStatus = "unloaded";
    loaded: Promise<FontFace> = Promise.resolve(this as unknown as FontFace);
    constructor(family: string) {
      this.family = family;
    }
    load() {
      this.status = "loaded";
      return Promise.resolve(this as unknown as FontFace);
    }
  } as unknown as typeof FontFace;
  Object.defineProperty(document, "fonts", {
    value: { add() {}, check: () => true, load: async () => [] },
    configurable: true,
  });
}

if (typeof window !== "undefined" && typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = (() =>
    new Proxy(
      { filter: "none", measureText: () => ({ width: 0 }) },
      { get: (target, key) => Reflect.get(target, key) ?? (() => undefined) },
    )) as typeof HTMLCanvasElement.prototype.getContext;
}

if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.assign(window, {
    matchMedia: (media: string): MediaQueryList => ({
      media,
      matches: media === "(prefers-reduced-motion: reduce)",
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => true,
    }),
  });
}

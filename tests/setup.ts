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

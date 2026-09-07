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

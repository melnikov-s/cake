/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { observeBrowserPageLifecycle } from "../../../src/renderer/lib/browser-page-lifecycle";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("follows keyboard-sized visual viewport and removes listeners on disposal", () => {
  const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
  vi.stubGlobal("visualViewport", viewport);
  const element = document.createElement("div");
  const callbacks = { persist: vi.fn(), reconnect: vi.fn(), dispose: vi.fn() };
  const stop = observeBrowserPageLifecycle(element, callbacks);
  expect(element.style.height).toBe("844px");
  viewport.height = 360;
  viewport.offsetTop = 24;
  viewport.dispatchEvent(new Event("resize"));
  expect(element.style.height).toBe("360px");
  expect(element.style.top).toBe("24px");
  stop();
  viewport.height = 844;
  viewport.dispatchEvent(new Event("scroll"));
  window.dispatchEvent(new Event("online"));
  expect(element.style.height).toBe("360px");
  expect(callbacks.reconnect).not.toHaveBeenCalled();
});

it("refreshes transport on foreground/online, preserves bfcache state, and only disposes a departing document", () => {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const callbacks = { persist: vi.fn(), reconnect: vi.fn(), dispose: vi.fn() };
  const stop = observeBrowserPageLifecycle(document.createElement("div"), callbacks);
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("online"));
  expect(callbacks.reconnect).not.toHaveBeenCalled();
  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("offline"));
  window.dispatchEvent(new Event("online"));
  expect(callbacks.reconnect).toHaveBeenCalledTimes(3);
  window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
  expect(callbacks.persist).toHaveBeenCalledTimes(1);
  expect(callbacks.dispose).not.toHaveBeenCalled();
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  expect(callbacks.reconnect).toHaveBeenCalledTimes(4);
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
  expect(callbacks.reconnect).toHaveBeenCalledTimes(4);
  window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
  expect(callbacks.persist).toHaveBeenCalledTimes(2);
  expect(callbacks.dispose).toHaveBeenCalledTimes(1);
  stop();
});

/** Browser-only viewport and transport lifecycle. Never reload or replay a command. */
export function observeBrowserPageLifecycle(
  element: HTMLElement,
  callbacks: { persist(): void; reconnect(): void; dispose(): void },
) {
  const viewport = window.visualViewport;
  const resize = () => {
    // dvh alone does not follow the iOS keyboard. Keep the whole shell (including
    // the connection banner) inside the visual viewport without disabling zoom.
    element.style.height = `${viewport?.height ?? window.innerHeight}px`;
    element.style.top = `${viewport?.offsetTop ?? 0}px`;
  };
  const resume = () => {
    if (document.visibilityState === "visible") callbacks.reconnect();
  };
  const pageShow = (event: PageTransitionEvent) => {
    resize();
    if (event.persisted) callbacks.reconnect();
  };
  const pageHide = (event: PageTransitionEvent) => {
    callbacks.persist();
    // A bfcache restore resumes this same document and its Stores.
    if (!event.persisted) callbacks.dispose();
  };
  resize();
  viewport?.addEventListener("resize", resize);
  viewport?.addEventListener("scroll", resize);
  window.addEventListener("resize", resize);
  window.addEventListener("online", resume);
  window.addEventListener("offline", callbacks.reconnect);
  window.addEventListener("pageshow", pageShow);
  window.addEventListener("pagehide", pageHide);
  document.addEventListener("visibilitychange", resume);
  return () => {
    viewport?.removeEventListener("resize", resize);
    viewport?.removeEventListener("scroll", resize);
    window.removeEventListener("resize", resize);
    window.removeEventListener("online", resume);
    window.removeEventListener("offline", callbacks.reconnect);
    window.removeEventListener("pageshow", pageShow);
    window.removeEventListener("pagehide", pageHide);
    document.removeEventListener("visibilitychange", resume);
  };
}

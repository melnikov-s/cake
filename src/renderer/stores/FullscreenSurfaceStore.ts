import { observable, Store } from "r-state-tree";
import { fullscreenEscapeOverlay, fullscreenFrameEscapeEvent } from "../lib/fullscreen-escape";

interface FullscreenSurfaceStoreProps {
  setOpen?(surfaceId: string, open: boolean): Promise<void>;
}

/** Owns fullscreen close requests and, when present, informs native surface controls. */
export class FullscreenSurfaceStore extends Store<FullscreenSurfaceStoreProps> {
  private readonly surfaces = observable(
    new Map<string, { element: HTMLElement; close: () => void }>(),
  );
  private listening = false;
  private claimedEscape = false;
  private previousOverflow = "";

  get hasOpenSurface() {
    return this.surfaces.size > 0;
  }

  open(surfaceId: string, element: HTMLElement, close: () => void) {
    if (!this.hasOpenSurface) {
      this.previousOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    const surface = { element, close };
    this.surfaces.set(surfaceId, surface);
    if (!this.listening) {
      this.listening = true;
      const options = { capture: true, signal: this.signal };
      window.addEventListener("keydown", this.onKeyDown, options);
      window.addEventListener(fullscreenFrameEscapeEvent, this.onFrameEscape, options);
    }
    void this.props.setOpen?.(surfaceId, true).catch(() => undefined);

    return () => {
      if (this.surfaces.get(surfaceId)?.close !== close) return;
      this.surfaces.delete(surfaceId);
      if (!this.hasOpenSurface) document.body.style.overflow = this.previousOverflow;
      void this.props.setOpen?.(surfaceId, false).catch(() => undefined);
    };
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (!event.repeat) this.claimedEscape = false;
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    )
      return;

    // A held key cannot dismiss the next layer or reach the restored opener.
    if (event.repeat && this.claimedEscape) {
      this.consumeEscape(event);
      return;
    }
    if (!event.repeat) this.dismissOnEscape(event);
  };

  private readonly onFrameEscape = (event: Event) => {
    // A cooperating frame may dismiss only its own active viewer.
    const surface = [...this.surfaces.values()].at(-1);
    if (
      !(event.target instanceof HTMLIFrameElement) ||
      document.activeElement !== event.target ||
      !surface?.element.contains(event.target)
    )
      return;
    this.dismissOnEscape(event);
  };

  private consumeEscape(event: Event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    this.claimedEscape = true;
  }

  private dismissOnEscape(event: Event) {
    const surface = [...this.surfaces.values()].at(-1);
    if (!surface || document.fullscreenElement || document.querySelector("dialog[open]")) return;

    const overlay = fullscreenEscapeOverlay(document);
    if (overlay) {
      this.consumeEscape(event);
      overlay.dismiss();
      return;
    }

    const target = event.target;
    if (target instanceof Element) {
      // Inline suggestions and feature-owned dialogs handle Escape themselves.
      const control = target.closest('[aria-expanded="true"][aria-controls]');
      const popup = document.getElementById(control?.getAttribute("aria-controls") ?? "");
      if (popup?.matches('[role="listbox"]')) return;
      const dialog = target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]');
      if (dialog && dialog !== surface.element && !surface.element.contains(dialog)) {
        if (![...this.surfaces.values()].some(({ element }) => element === dialog)) return;
      }
    }

    // Retain the guard for non-shared overlays covering the viewer itself (not
    // the browser window center, which can be outside a constrained viewport).
    const { left, top, width, height } = surface.element.getBoundingClientRect();
    const hit = document.elementFromPoint?.(left + width / 2, top + height / 2);
    if (hit && !surface.element.contains(hit)) return;

    // Claim Escape before it can reach an input (e.g. stop a running response)
    // or bubble through the viewer's React portal into the underlying chat.
    this.consumeEscape(event);
    surface.close();
  }

  /** Dismiss every Cake fullscreen layer, including nested previews, after capture handoff. */
  closeAll() {
    for (const { close } of [...this.surfaces.values()].reverse()) close();
  }

  requestClose(surfaceId: string) {
    this.surfaces.get(surfaceId)?.close();
  }
}

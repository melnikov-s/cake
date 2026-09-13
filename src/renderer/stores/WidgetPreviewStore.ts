import { Store, observable } from "r-state-tree";
import type { StoreEvent } from "../events/StoreEvent";
import { ClientContext } from "./context/ClientContext";

export interface WidgetPreviewState {
  operationId: string;
  previewRequestId: string;
  sessionId: string;
  widget: { token: string; url: string };
}

/** Owns the one transient, main-correlated rendered widget review surface in this window. */
export class WidgetPreviewStore extends Store {
  get artifacts() {
    return ClientContext.consume(this)!.artifacts;
  }

  readonly state = observable<{ preview?: WidgetPreviewState }>({});

  get preview() {
    return this.state.preview;
  }

  private set preview(value: WidgetPreviewState | undefined) {
    this.state.preview = value;
  }

  receive(event: StoreEvent) {
    if (event.type === "widget-preview-dismissed") {
      if (this.preview?.widget.token === event.token) this.preview = undefined;
      return;
    }
    if (event.type !== "widget-preview-requested") return;
    const previous = this.preview;
    this.preview = event;
    if (previous) void this.respond(previous, true, [], undefined).catch(() => undefined);
  }

  ready(
    expectedToken: string,
    rect: { x: number; y: number; width: number; height: number },
    diagnostics: ReadonlyArray<string>,
  ) {
    const preview = this.preview;
    if (!preview || preview.widget.token !== expectedToken || this.signal.aborted) return;
    void this.respond(preview, false, diagnostics, rect);
  }

  fail(expectedToken: string, diagnostic: string) {
    const preview = this.preview;
    if (!preview || preview.widget.token !== expectedToken) return;
    this.preview = undefined;
    void this.respond(preview, false, [diagnostic], undefined);
  }

  cancel() {
    const preview = this.preview;
    if (!preview) return;
    this.preview = undefined;
    void this.respond(preview, true, ["The user cancelled rendered widget review."], undefined);
  }

  private respond(
    preview: WidgetPreviewState,
    cancelled: boolean,
    diagnostics: ReadonlyArray<string>,
    rect: { x: number; y: number; width: number; height: number } | undefined,
  ) {
    return this.artifacts.respondToWidgetPreview({
      operationId: preview.operationId,
      previewRequestId: preview.previewRequestId,
      sessionId: preview.sessionId,
      token: preview.widget.token,
      cancelled,
      rect,
      diagnostics,
    });
  }
}

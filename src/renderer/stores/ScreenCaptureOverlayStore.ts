import { Store, observable } from "r-state-tree";
import {
  captureRect,
  type CaptureArrow,
  type CaptureDestination,
  type CapturePoint,
  type CaptureRect,
  type ScreenCaptureSnapshot,
} from "../../contracts/desktop/screen-capture-data";
import type { Client } from "../client/Client";
import type { CapturePalette } from "../screen-capture/render-capture";

/** One overlay's ephemeral editing state. Never persisted; switching modes preserves arrows.
 * Finish is single-flight. Escape can cancel while rasterization runs and prevents delivery.
 */
export class ScreenCaptureOverlayStore extends Store<{
  client: Pick<Client["electron"], "screenCaptureState" | "finishScreenCapture">;
  renderImage(
    image: string,
    arrows: readonly CaptureArrow[],
    rect: CaptureRect | undefined,
    maxDimension: number,
    palette: CapturePalette,
  ): Promise<string>;
}> {
  snapshot: ScreenCaptureSnapshot | undefined;
  mode: "crop" | "annotate" = "crop";
  destination: CaptureDestination | undefined;
  readonly arrows: CaptureArrow[] = observable([]);
  dragStart: CapturePoint | undefined;
  dragEnd: CapturePoint | undefined;
  editingIndex: number | undefined;
  label = "";
  busy = false;
  cancelled = false;
  error: string | undefined;
  palette: CapturePalette = { ink: "", background: "", foreground: "" };

  async initialize() {
    try {
      const snapshot = await this.props.client.screenCaptureState({ signal: this.signal });
      if (!this.signal.aborted) {
        this.snapshot = snapshot;
        this.destination = snapshot.routing.defaultDestination;
      }
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
    }
  }

  selectDestination(destination: CaptureDestination) {
    if (this.busy || this.cancelled) return;
    this.destination = destination;
  }

  setMode(mode: "crop" | "annotate") {
    this.commitLabel();
    this.dragStart = undefined;
    this.dragEnd = undefined;
    this.mode = mode;
  }

  get selection() {
    return this.mode === "crop" && this.dragStart && this.dragEnd
      ? captureRect(this.dragStart, this.dragEnd)
      : undefined;
  }
  get visibleArrows(): readonly CaptureArrow[] {
    return this.mode === "annotate" && this.dragStart && this.dragEnd
      ? [...this.arrows, { start: this.dragEnd, end: this.dragStart, label: "" }]
      : this.arrows.slice();
  }
  get labelPoint() {
    return this.editingIndex === undefined ? undefined : this.arrows[this.editingIndex]?.start;
  }

  begin(point: CapturePoint) {
    if (!this.snapshot || this.busy || this.cancelled) return;
    this.commitLabel();
    this.dragStart = point;
    this.dragEnd = point;
  }
  move(point: CapturePoint) {
    if (this.dragStart) this.dragEnd = point;
  }
  end(point: CapturePoint) {
    if (!this.dragStart || this.busy || this.cancelled) return;
    const start = this.dragStart;
    this.dragStart = undefined;
    this.dragEnd = undefined;
    const rect = captureRect(start, point);
    if (Math.hypot(rect.width, rect.height) < 5) return;
    if (this.mode === "crop") {
      if (rect.width >= 2 && rect.height >= 2) void this.capture(rect);
    } else {
      this.arrows.push({ start: point, end: start, label: "" });
      this.editingIndex = this.arrows.length - 1;
      this.label = "";
    }
  }
  abandonDrag() {
    this.dragStart = undefined;
    this.dragEnd = undefined;
  }

  /** Dismiss the unfinished gesture before dismissing the capture itself. */
  escape() {
    if (this.editingIndex !== undefined) {
      this.arrows.splice(this.editingIndex, 1);
      this.editingIndex = undefined;
      this.label = "";
    } else if (this.dragStart) {
      this.abandonDrag();
    } else {
      void this.cancel();
    }
  }

  commitLabel() {
    const index = this.editingIndex;
    if (index !== undefined && this.arrows[index])
      this.arrows.splice(index, 1, { ...this.arrows[index], label: this.label.trim() });
    this.editingIndex = undefined;
    this.label = "";
  }
  undo() {
    this.commitLabel();
    this.arrows.pop();
  }

  async capture(rect?: CaptureRect) {
    if (!this.snapshot || !this.destination || this.busy || this.cancelled) return;
    const destination = { ...this.destination };
    this.commitLabel();
    this.busy = true;
    this.error = undefined;
    try {
      const image = await this.props.renderImage(
        this.snapshot.image,
        this.arrows.slice(),
        rect,
        this.snapshot.maxDimension,
        this.palette,
      );
      if (this.signal.aborted || this.cancelled) return;
      await this.props.client.finishScreenCapture({ image, destination }, { signal: this.signal });
    } catch (error) {
      if (!this.signal.aborted && !this.cancelled) this.reportError(error);
    } finally {
      this.busy = false;
    }
  }
  async cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    try {
      await this.props.client.finishScreenCapture(undefined, { signal: this.signal });
    } catch (error) {
      if (!this.signal.aborted) {
        this.cancelled = false;
        this.reportError(error);
      }
    }
  }
  private reportError(error: unknown) {
    this.error = error instanceof Error ? error.message : String(error);
  }
}

import { Store, child, createStore, observable } from "r-state-tree";
import {
  captureAnnotationText,
  captureDrawingAnchor,
  captureRect,
  type CaptureDrawing,
  type CaptureMode,
  type CapturePoint,
  type CaptureRect,
  type ScreenCaptureSnapshot,
} from "../../contracts/desktop/screen-capture-data";
import type { Client } from "../client/Client";
import {
  DEFAULT_CAPTURE_ANNOTATION_COLOR,
  type CaptureAnnotationColor,
} from "../../utils/capture-annotation-colors";
import { DictationStore } from "./DictationStore";
import { SpeechInputSettingsStore } from "./SpeechInputSettingsStore";

/** Ephemeral overlay editing state; image and numbered text share one export projection. */
export class ScreenCaptureOverlayStore extends Store<{
  client: Pick<Client["electron"], "screenCaptureState" | "finishScreenCapture">;
  speech: Pick<DictationStore["props"], "client" | "microphone" | "postProcess">;
  copy(image: string, text: string): Promise<void>;
  renderImage(
    image: string,
    drawings: readonly CaptureDrawing[],
    rect: CaptureRect | undefined,
    maxDimension: number,
    color: CaptureAnnotationColor,
  ): Promise<string>;
}> {
  snapshot: ScreenCaptureSnapshot | undefined;
  mode: CaptureMode = "crop";
  readonly drawings: CaptureDrawing[] = observable([]);
  readonly stroke: CapturePoint[] = observable([]);
  dragStart: CapturePoint | undefined;
  dragEnd: CapturePoint | undefined;
  editingIndex: number | undefined;
  editingNew = false;
  label = "";
  busy = false;
  copied = false;
  cancelled = false;
  error: string | undefined;
  annotationColor: CaptureAnnotationColor = DEFAULT_CAPTURE_ANNOTATION_COLOR;

  selectColor(color: CaptureAnnotationColor) {
    if (this.busy || this.cancelled) return;
    this.annotationColor = color;
    this.copied = false;
  }

  @child get speechPreferences(): SpeechInputSettingsStore {
    return createStore(SpeechInputSettingsStore);
  }
  @child get dictationStore(): DictationStore {
    return createStore(DictationStore, {
      ...this.props.speech,
      preferences: this.speechPreferences,
    });
  }

  async initialize() {
    try {
      const snapshot = await this.props.client.screenCaptureState({ signal: this.signal });
      if (!this.signal.aborted) {
        this.snapshot = snapshot;
        this.annotationColor = snapshot.routing.annotationColor;
        const voice = snapshot.routing.dictation;
        const recognition = voice.recognition;
        this.speechPreferences.preferences = {
          ...this.speechPreferences.values,
          speechStartThreshold: recognition.thresholds.start,
          speechContinueThreshold: recognition.thresholds.continuation,
          minimumSpeechMs: recognition.minimumSpeechMs,
          prerollMs: recognition.prerollMs,
          maximumUtteranceSeconds: recognition.maximumUtteranceSeconds,
        };
        this.dictationStore.enabled = voice.enabled;
        this.dictationStore.phase = voice.enabled ? "paused" : "off";
        this.dictationStore.deviceId = voice.deviceId;
        this.dictationStore.textProcessingMode = voice.textProcessingMode;
      }
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
    }
  }

  setMode(mode: CaptureMode) {
    this.commitLabel();
    this.abandonDrag();
    this.mode = mode;
  }
  get selection() {
    return this.mode === "crop" && this.dragStart && this.dragEnd
      ? captureRect(this.dragStart, this.dragEnd)
      : undefined;
  }
  private get pendingDrawing(): CaptureDrawing | undefined {
    if (!this.dragStart || !this.dragEnd || this.mode === "crop") return undefined;
    return this.mode === "freehand"
      ? { kind: "freehand", points: this.stroke.slice(), label: "" }
      : { kind: "arrow", start: this.dragEnd, end: this.dragStart, label: "" };
  }
  get visibleDrawings(): readonly CaptureDrawing[] {
    const pending = this.pendingDrawing;
    return pending ? [...this.drawings, pending] : this.drawings.slice();
  }
  get labelPoint() {
    const drawing = this.editingIndex === undefined ? undefined : this.drawings[this.editingIndex];
    return drawing && captureDrawingAnchor(drawing);
  }
  begin(point: CapturePoint) {
    if (!this.snapshot || this.busy || this.cancelled || this.editingIndex !== undefined) return;
    this.copied = false;
    this.dragStart = point;
    this.dragEnd = point;
    this.stroke.splice(0, this.stroke.length, point);
  }
  move(point: CapturePoint) {
    if (!this.dragStart) return;
    this.dragEnd = point;
    if (this.mode === "freehand") this.stroke.push(point);
  }
  end(point: CapturePoint) {
    if (!this.dragStart || this.busy || this.cancelled) return;
    this.move(point);
    const rect = captureRect(this.dragStart, point);
    const drawing = this.pendingDrawing;
    const length =
      this.mode === "freehand"
        ? this.stroke.reduce(
            (sum, current, index) =>
              index === 0
                ? sum
                : sum +
                  Math.hypot(
                    current.x - this.stroke[index - 1]!.x,
                    current.y - this.stroke[index - 1]!.y,
                  ),
            0,
          )
        : Math.hypot(rect.width, rect.height);
    this.abandonDrag();
    if (length < 5) return;
    if (this.mode === "crop") {
      if (rect.width >= 2 && rect.height >= 2) void this.capture(rect);
    } else if (drawing) {
      this.drawings.push(drawing);
      this.editingIndex = this.drawings.length - 1;
      this.editingNew = true;
      this.label = "";
    }
  }
  abandonDrag() {
    this.dragStart = undefined;
    this.dragEnd = undefined;
    this.stroke.splice(0);
  }
  editLabel(index: number) {
    if (this.busy || this.cancelled || !this.drawings[index]) return;
    this.commitLabel();
    this.editingIndex = index;
    this.editingNew = false;
    this.label = this.drawings[index]!.label;
  }
  cancelLabel() {
    if (this.editingIndex !== undefined && this.editingNew)
      this.drawings.splice(this.editingIndex, 1);
    this.editingIndex = undefined;
    this.label = "";
  }
  deleteLabel() {
    if (this.editingIndex !== undefined) this.drawings.splice(this.editingIndex, 1);
    this.editingIndex = undefined;
    this.label = "";
    this.copied = false;
  }
  escape() {
    if (this.editingIndex !== undefined) this.cancelLabel();
    else if (this.dragStart) this.abandonDrag();
    else void this.cancel();
  }
  commitLabel() {
    const index = this.editingIndex;
    if (index !== undefined && this.drawings[index]) {
      this.drawings.splice(index, 1, { ...this.drawings[index]!, label: this.label.trim() });
      this.copied = false;
    }
    this.editingIndex = undefined;
    this.label = "";
  }
  undo() {
    this.commitLabel();
    this.drawings.pop();
    this.copied = false;
  }
  async capture(rect?: CaptureRect, copy = false) {
    if (!this.snapshot || this.busy || this.cancelled) return;
    this.commitLabel();
    const drawings = this.drawings.slice();
    const annotationText = captureAnnotationText(drawings, rect);
    this.busy = true;
    this.error = undefined;
    try {
      const image = await this.props.renderImage(
        this.snapshot.image,
        drawings,
        rect,
        this.snapshot.maxDimension,
        this.annotationColor,
      );
      if (this.signal.aborted || this.cancelled) return;
      if (copy) {
        await this.props.copy(image, annotationText);
        this.copied = true;
      } else {
        await this.props.client.finishScreenCapture(
          { image, annotationText },
          this.annotationColor,
          { signal: this.signal },
        );
      }
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
      await this.props.client.finishScreenCapture(undefined, this.annotationColor, {
        signal: this.signal,
      });
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

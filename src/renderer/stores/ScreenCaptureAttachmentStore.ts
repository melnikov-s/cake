import { Store, snapshot, untracked } from "r-state-tree";
import {
  DEFAULT_CAPTURE_MAX_DIMENSION,
  DEFAULT_CAPTURE_SHORTCUT,
} from "../../domain/screen-capture/screen-capture-data";
import type { Client } from "../client/Client";
import type { WindowConversationSelection } from "./AppShellStore";
import type { ComposerDraftStore } from "./ComposerDraftStore";
import { ToastContext } from "./context/ToastContext";

/** Owns native capture preferences and destination routing, not chat or transcript state.
 * Preferences/last destination persist in the window snapshot. Captures are single-flight;
 * destination is fixed at activation and revalidated before appending to its existing draft.
 */
export class ScreenCaptureAttachmentStore extends Store<{
  client: Client["electron"];
  currentTarget(): WindowConversationSelection | undefined;
  findDraft(target: WindowConversationSelection): ComposerDraftStore | undefined;
}> {
  @snapshot shortcut = DEFAULT_CAPTURE_SHORTCUT;
  @snapshot maxDimension = DEFAULT_CAPTURE_MAX_DIMENSION;
  @snapshot private lastTarget: WindowConversationSelection | undefined;
  busy = false;
  private recordingShortcut = false;
  error: string | undefined;
  private configurationQueue: Promise<void> = Promise.resolve();

  constructor(props: ScreenCaptureAttachmentStore["props"]) {
    super(props);
    this.reaction(
      () => this.props.currentTarget(),
      (target, previous) => {
        const remembered = target ?? previous;
        if (remembered)
          untracked(() => {
            this.lastTarget = { ...remembered };
          });
      },
    );
  }

  private get toast() {
    return ToastContext.consume(this)!;
  }

  private reportError(message: string) {
    this.toast.show({ tone: "error", title: "Screen capture", message });
  }

  configure() {
    const settings = {
      shortcut: this.recordingShortcut ? "" : this.shortcut,
      maxDimension: this.maxDimension,
    };
    this.configurationQueue = this.configurationQueue.then(async () => {
      if (this.signal.aborted) return;
      try {
        await this.props.client.configureScreenCapture(settings, { signal: this.signal });
        if (!this.signal.aborted) this.error = undefined;
      } catch (error) {
        if (!this.signal.aborted) {
          this.error = error instanceof Error ? error.message : String(error);
          this.reportError(this.error);
        }
      }
    });
    return this.configurationQueue;
  }

  setRecordingShortcut(recording: boolean) {
    if (this.recordingShortcut === recording) return;
    this.recordingShortcut = recording;
    void this.configure();
  }

  setShortcut(value: string) {
    this.shortcut = value;
    void this.configure();
  }
  setMaxDimension(value: number) {
    if (!Number.isInteger(value) || value < 256 || value > 8192) return;
    this.maxDimension = value;
    void this.configure();
  }

  async capture() {
    if (this.busy || this.recordingShortcut) return;
    const target = this.props.currentTarget() ?? this.lastTarget;
    const draft = target && this.props.findDraft(target);
    if (!target || !draft) {
      this.reportError("Open an editable chat before capturing an attachment.");
      return;
    }
    if (draft.attachments.length >= 20) {
      this.reportError("A message can include at most 20 attachments.");
      return;
    }
    this.busy = true;
    try {
      const data = await this.props.client.startScreenCapture({ signal: this.signal });
      if (this.signal.aborted || !data) return;
      if (this.props.findDraft(target) !== draft)
        throw new Error("The destination chat is no longer editable.");
      if (draft.attachments.length >= 20)
        throw new Error("The destination draft already has 20 attachments.");
      draft.appendAttachments([
        {
          kind: "image",
          name: `Screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
          mimeType: "image/png",
          data,
        },
      ]);
      draft.requestFocus();
    } catch (error) {
      if (!this.signal.aborted)
        this.reportError(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy = false;
    }
  }
}

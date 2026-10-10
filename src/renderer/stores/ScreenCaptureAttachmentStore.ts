import { Store, snapshot, untracked } from "r-state-tree";
import {
  DEFAULT_CAPTURE_MAX_DIMENSION,
  DEFAULT_CAPTURE_SHORTCUT,
  type CaptureDestination,
  type CaptureRouting,
} from "../../domain/screen-capture/screen-capture-data";
import type { Client } from "../client/Client";
import type { WindowConversationSelection } from "./AppShellStore";
import type { ComposerDraftStore } from "./ComposerDraftStore";
import { ToastContext } from "./context/ToastContext";

/** Owns native capture preferences and destination routing, not chat or transcript state.
 * Preferences/last destination persist in the window snapshot. Captures are single-flight;
 * overlay choices are frozen at activation and revalidated before appending. New destinations
 * create an empty session only after capture succeeds, never on cancellation.
 */
export class ScreenCaptureAttachmentStore extends Store<{
  client: Client["electron"];
  currentTarget(): WindowConversationSelection | undefined;
  destinations(): Omit<CaptureRouting, "defaultDestination">;
  prepareDestination(destination: CaptureDestination): Promise<WindowConversationSelection>;
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
    const choices = this.props.destinations();
    const remembered = this.props.currentTarget() ?? this.lastTarget;
    const available =
      remembered &&
      (remembered.kind === "cake-chat"
        ? choices.cakeChats.some((session) => session.sessionId === remembered.sessionId)
        : choices.projects.some((project) =>
            project.sessions.some((session) => session.sessionId === remembered.sessionId),
          ));
    const project = choices.projects[0];
    const recentSession = project?.sessions[0];
    const defaultDestination: CaptureDestination | undefined = available
      ? remembered
      : recentSession
        ? { kind: "project-session", sessionId: recentSession.sessionId }
        : project
          ? { kind: "new-session", projectPath: project.path }
          : choices.cakeChats[0]
            ? { kind: "cake-chat", sessionId: choices.cakeChats[0].sessionId }
            : undefined;
    if (!defaultDestination) {
      this.reportError("Add a Project before capturing an attachment.");
      return;
    }
    this.busy = true;
    try {
      const result = await this.props.client.startScreenCapture(
        { ...choices, defaultDestination },
        { signal: this.signal },
      );
      if (this.signal.aborted || !result) return;
      const target = await this.props.prepareDestination(result.destination);
      if (this.signal.aborted) return;
      const draft = this.props.findDraft(target);
      if (!draft) throw new Error("The destination chat is no longer editable.");
      if (draft.attachments.length >= 20)
        throw new Error("The destination draft already has 20 attachments.");
      draft.appendAttachments([
        {
          kind: "image",
          name: `Screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
          mimeType: "image/png",
          data: result.data,
        },
      ]);
      this.lastTarget = { ...target };
      draft.requestFocus();
    } catch (error) {
      if (!this.signal.aborted)
        this.reportError(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy = false;
    }
  }
}

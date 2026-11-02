import {
  DEFAULT_CAPTURE_ANNOTATION_COLOR,
  type CaptureAnnotationColor,
} from "../../utils/capture-annotation-colors";
import { speechRecognitionSettings } from "../../utils/speech-input-settings";
import type { DictationStore } from "./DictationStore";
import { Store, snapshot, untracked } from "r-state-tree";
import {
  DEFAULT_CAPTURE_MAX_DIMENSION,
  DEFAULT_CAPTURE_SHORTCUT,
  type CapturePreferences,
  type CaptureResult,
} from "../../contracts/desktop/screen-capture-data";
import type { Client } from "../client/Client";
import type { AppShellStore, WindowConversationSelection } from "./AppShellStore";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import type { CakeChatCatalog } from "../models/CakeChatCatalog";
import type { CakeChatCollectionStore } from "./CakeChatCollectionStore";
import type { NavigationStore } from "./NavigationStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import { ToastContext } from "./context/ToastContext";

type CaptureConversationTarget = Exclude<
  WindowConversationSelection,
  { kind: "automation-session" }
>;

/** Owns native capture preferences and destination routing, not chat or transcript state.
 * Preferences/last destination persist in the window snapshot. Captures are single-flight;
 * the owning renderer selects destinations using its live sidebar after native editing.
 */
export class ScreenCaptureAttachmentStore extends Store<{
  client: Client["electron"];
  shell: AppShellStore;
  catalog: SessionCatalogStore;
  registry: SessionRegistryStore;
  settings(): AppearanceSettingsStore;
  dictation(): DictationStore;
  cakeChat(): CakeChatCollectionStore;
  cakeChatCatalog: CakeChatCatalog;
  navigation(): NavigationStore;
}> {
  @snapshot annotationColor: CaptureAnnotationColor = DEFAULT_CAPTURE_ANNOTATION_COLOR;
  @snapshot shortcut = DEFAULT_CAPTURE_SHORTCUT;
  @snapshot maxDimension = DEFAULT_CAPTURE_MAX_DIMENSION;
  @snapshot private lastTarget: CaptureConversationTarget | undefined;
  busy = false;
  /** The drop-down Cake Chat attaches captures only to the Cake Chat it shows. */
  cakeChatOnly = false;
  private recordingShortcut = false;
  error: string | undefined;
  private configurationQueue: Promise<void> = Promise.resolve();

  constructor(props: ScreenCaptureAttachmentStore["props"]) {
    super(props);
    this.reaction(
      () => this.props.shell.activeConversation,
      (target, previous) => {
        const remembered = target ?? previous;
        if (remembered && remembered.kind !== "automation-session")
          untracked(() => {
            this.lastTarget = { ...remembered };
          });
      },
    );
  }

  pendingCapture: CaptureResult | undefined;

  get currentDestination() {
    const active = this.props.shell.activeConversation;
    return active?.kind === "automation-session" ? this.lastTarget : (active ?? this.lastTarget);
  }

  private get preferences(): CapturePreferences {
    const settings = this.props.settings();
    const customTheme = settings.activeCustomTheme;
    return {
      annotationColor: this.annotationColor,
      appearance: {
        theme: customTheme?.type ?? settings.theme,
        importedTheme: customTheme,
      },
      dictation: {
        enabled: this.props.dictation().enabled,
        deviceId: this.props.dictation().deviceId,
        textProcessingMode: this.props.dictation().textProcessingMode,
        recognition: speechRecognitionSettings(this.props.dictation().props.preferences.values),
      },
    };
  }

  private async prepareDestination(
    destination: WindowConversationSelection,
  ): Promise<CaptureConversationTarget> {
    if (destination.kind === "automation-session")
      throw new Error("Choose a Project Session or Cake Chat for this capture.");
    if (destination.kind === "project-session") {
      if (this.props.catalog.find(destination.sessionId)?.resolved)
        throw new Error("The destination chat is no longer editable.");
      const loaded = this.props.registry.findSession(destination.sessionId);
      if (
        !loaded ||
        (!loaded.model.sessionFile &&
          !this.props.registry.pendingSessions.isTemporary(destination.sessionId))
      ) {
        if (!(await this.props.navigation().openSession(destination.sessionId)))
          throw new Error("Cake could not open the destination session.");
      } else {
        this.props.navigation().showLoadedProjectSession(destination.sessionId);
      }
    } else {
      if (this.props.cakeChatCatalog.find(destination.sessionId)?.resolved)
        throw new Error("The destination chat is no longer editable.");
      await this.props.navigation().openCakeChat(destination.sessionId);
    }
    return destination;
  }

  private findDraft(target: CaptureConversationTarget) {
    if (target.kind === "project-session") {
      if (this.props.catalog.find(target.sessionId)?.resolved) return undefined;
      return this.props.registry.findSession(target.sessionId)?.conversationSessionStore
        .composerStore.draftStore;
    }
    if (this.props.cakeChatCatalog.find(target.sessionId)?.resolved) return undefined;
    return this.props.cakeChat().registry.find(target.sessionId)?.conversationSessionStore
      .composerStore.draftStore;
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
    if (this.busy || this.pendingCapture || this.recordingShortcut) return;
    this.busy = true;
    try {
      const completion = await this.props.client.startScreenCapture(this.preferences, {
        signal: this.signal,
      });
      if (this.signal.aborted) return;
      this.annotationColor = completion.annotationColor;
      this.pendingCapture = completion.capture;
    } catch (error) {
      if (!this.signal.aborted)
        this.reportError(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy = false;
    }
    // The drop-down window intentionally attaches only to its current Cake Chat.
    if (this.cakeChatOnly && this.pendingCapture && this.currentDestination)
      await this.attachTo(this.currentDestination);
  }

  cancelDestination() {
    if (!this.busy) this.pendingCapture = undefined;
  }

  async attachTo(destination: WindowConversationSelection) {
    const result = this.pendingCapture;
    if (this.busy || !result) return;
    this.busy = true;
    try {
      const target = await this.prepareDestination(destination);
      if (this.signal.aborted) return;
      const draft = this.findDraft(target);
      if (!draft) throw new Error("The destination chat is no longer editable.");
      if (draft.attachments.length >= 20)
        throw new Error("The destination draft already has 20 attachments.");
      const name = `Screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
      draft.appendAttachments([
        {
          kind: "image",
          name,
          mimeType: "image/png",
          data: result.data,
        },
      ]);
      if (result.annotationText)
        draft.setText(
          [draft.text, `${name}\n${result.annotationText}`].filter(Boolean).join("\n\n"),
        );
      this.lastTarget = { ...target };
      this.pendingCapture = undefined;
      draft.requestFocus();
    } catch (error) {
      if (!this.signal.aborted)
        this.reportError(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy = false;
    }
  }
}

import { snapshot, Store } from "r-state-tree";
import type {
  SpeechOutputSettings,
  SpeechOutputVoice,
} from "../../domain/speech/speech-output-data";
import type { SpeechOutputCommands } from "../client/Client";
import { voiceDiagnosticReport } from "../speech/diagnostics";

/** Native main owns credentials/voice persistence. This window owns the projection,
 * transient interaction and snapshotted speech-control visibility preference (last local edit wins). */
export class SpeechSettingsStore extends Store<{
  client: SpeechOutputCommands;
  copyText(text: string): Promise<void>;
}> {
  @snapshot enabled = true;
  settings: SpeechOutputSettings | undefined;
  speedDraft: number | undefined;
  get voices(): readonly SpeechOutputVoice[] {
    return this.settings?.voices ?? [];
  }
  get speed(): number {
    return this.speedDraft ?? this.settings?.speed ?? 1;
  }
  apiKeyDraft = "";
  busy = false;
  refreshing = false;
  error: string | undefined;
  diagnosticsCopyStatus: "idle" | "copying" | "copied" | "failed" = "idle";
  async copyDiagnostics(): Promise<void> {
    if (this.diagnosticsCopyStatus === "copying" || this.signal.aborted) return;
    this.diagnosticsCopyStatus = "copying";
    try {
      await this.props.copyText(voiceDiagnosticReport());
      if (!this.signal.aborted) this.diagnosticsCopyStatus = "copied";
    } catch {
      if (!this.signal.aborted) this.diagnosticsCopyStatus = "failed";
    }
  }
  private refreshRevision = 0;
  private refresh: AbortController | undefined;
  downloading = false;
  private download: AbortController | undefined;
  get localSelected(): boolean {
    return this.settings?.provider === "pocket-tts";
  }
  get localModel() {
    return this.settings?.localModel;
  }
  get installing(): boolean {
    return this.downloading || this.localModel?.installing === true;
  }
  get canCancelDownload(): boolean {
    return this.download !== undefined;
  }
  constructor(props: SpeechSettingsStore["props"]) {
    super(props);
    this.effect(() => () => {
      this.apiKeyDraft = "";
      this.refresh?.abort();
      this.download?.abort();
    });
  }
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
  applySettings(settings: SpeechOutputSettings): void {
    if (this.settings?.provider !== settings.provider || settings.speed === this.speedDraft)
      this.speedDraft = undefined;
    this.settings = settings;
  }
  private async mutate(operation: () => Promise<void>): Promise<void> {
    if (this.busy || this.signal.aborted) return;
    this.busy = true;
    this.error = undefined;
    try {
      await operation();
    } catch (error) {
      if (!this.signal.aborted)
        this.error = error instanceof Error ? error.message : "Speech settings could not be saved";
    } finally {
      this.apiKeyDraft = "";
      this.busy = false;
    }
  }
  async selectProvider(provider: string): Promise<void> {
    if (provider !== "elevenlabs" && provider !== "pocket-tts") return;
    if (this.installing) return;
    await this.mutate(() => this.props.client.setProvider(provider, { signal: this.signal }));
  }
  async downloadLocalModel(): Promise<void> {
    if (this.installing || this.signal.aborted) return;
    const controller = new AbortController();
    this.download = controller;
    this.downloading = true;
    this.error = undefined;
    try {
      await this.props.client.installLocal({
        signal: AbortSignal.any([this.signal, controller.signal]),
      });
    } catch (error) {
      if (!this.signal.aborted && !controller.signal.aborted)
        this.error = error instanceof Error ? error.message : "Could not download Pocket TTS";
    } finally {
      this.download = undefined;
      this.downloading = false;
    }
  }
  cancelDownload(): void {
    this.download?.abort();
  }
  async removeLocalModel(): Promise<void> {
    if (this.installing) return;
    await this.mutate(() => this.props.client.removeLocal({ signal: this.signal }));
  }
  async saveApiKey(): Promise<void> {
    const key = this.apiKeyDraft.trim();
    if (!key) return;
    await this.mutate(() => this.props.client.setApiKey(key, { signal: this.signal }));
  }
  async removeApiKey(): Promise<void> {
    await this.mutate(() => this.props.client.setApiKey(null, { signal: this.signal }));
  }
  async selectVoice(voiceId: string): Promise<void> {
    if (!voiceId) return;
    await this.mutate(() => this.props.client.setVoice(voiceId, { signal: this.signal }));
  }
  async saveSpeed(): Promise<void> {
    if (this.speedDraft === undefined || this.busy) return;
    const speed = this.speedDraft;
    await this.mutate(() => this.props.client.setSpeed(speed, { signal: this.signal }));
    if (this.error) this.speedDraft = undefined;
  }
  async refreshVoices(): Promise<void> {
    const revision = ++this.refreshRevision;
    this.refresh?.abort();
    const controller = new AbortController();
    this.refresh = controller;
    this.refreshing = true;
    this.error = undefined;
    try {
      await this.props.client.listVoices({
        signal: AbortSignal.any([this.signal, controller.signal]),
      });
    } catch (error) {
      if (!this.signal.aborted && !controller.signal.aborted && revision === this.refreshRevision)
        this.error = error instanceof Error ? error.message : "Could not load voices";
    } finally {
      if (revision === this.refreshRevision) this.refreshing = false;
    }
  }
}

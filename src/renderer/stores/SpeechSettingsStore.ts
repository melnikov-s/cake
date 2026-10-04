import { Store } from "r-state-tree";
import type {
  SpeechOutputSettings,
  SpeechOutputVoice,
} from "../../domain/speech/speech-output-data";
import type { SpeechOutputCommands } from "../client/Client";

/** Native main owns persistence. This window owns only the projection and transient interaction. */
export class SpeechSettingsStore extends Store<{ client: SpeechOutputCommands }> {
  settings: SpeechOutputSettings | undefined;
  voices: readonly SpeechOutputVoice[] = [];
  apiKeyDraft = "";
  busy = false;
  refreshing = false;
  error: string | undefined;
  private refreshRevision = 0;
  private refresh: AbortController | undefined;
  constructor(props: SpeechSettingsStore["props"]) {
    super(props);
    this.effect(() => () => {
      this.apiKeyDraft = "";
      this.refresh?.abort();
    });
  }
  applySettings(settings: SpeechOutputSettings): void {
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
  async refreshVoices(): Promise<void> {
    const revision = ++this.refreshRevision;
    this.refresh?.abort();
    const controller = new AbortController();
    this.refresh = controller;
    this.refreshing = true;
    this.error = undefined;
    try {
      const voices = await this.props.client.listVoices({
        signal: AbortSignal.any([this.signal, controller.signal]),
      });
      if (!this.signal.aborted && revision === this.refreshRevision) this.voices = voices;
    } catch (error) {
      if (!this.signal.aborted && !controller.signal.aborted && revision === this.refreshRevision)
        this.error = error instanceof Error ? error.message : "Could not load voices";
    } finally {
      if (revision === this.refreshRevision) this.refreshing = false;
    }
  }
}

import { Store, observable } from "r-state-tree";
import type { ApplicationState, ModelPreset } from "../../ipc/session-contract";
import type { DesktopClient } from "../desktop-client";
import { describeError } from "../error-details";

export interface ModelPresetSettingsStoreProps {
  client: Pick<DesktopClient, "setModelPresets">;
}

/** Owns the model-preset collection, default selection, and serial save queue. */
export class ModelPresetSettingsStore extends Store<ModelPresetSettingsStoreProps> {
  readonly presets: ModelPreset[] = observable([]);
  defaultPresetId: string | undefined;
  saving = false;
  sectionRequestRevision = 0;
  error: string | undefined;
  errorDetails: string | undefined;
  private saveRevision = 0;
  private saveQueue: Promise<unknown> = Promise.resolve();
  private persistedPresets: ModelPreset[] = [];
  private persistedDefaultPresetId: string | undefined;

  applyApplicationState(state: ApplicationState) {
    if (this.saving) return;
    this.persistedPresets = (state.modelPresets ?? []).map((preset) => ({ ...preset }));
    this.persistedDefaultPresetId = state.defaultModelPresetId;
    this.restorePersisted();
  }

  get defaultConfiguration() {
    const preset = this.presets.find((candidate) => candidate.id === this.defaultPresetId);
    return preset
      ? {
          provider: preset.provider,
          modelId: preset.modelId,
          thinkingLevel: preset.thinkingLevel,
          fastMode: preset.fastMode,
        }
      : undefined;
  }

  requestSection() {
    this.sectionRequestRevision += 1;
  }

  createPreset(preset: Omit<ModelPreset, "id">) {
    return this.save([...this.presets, { ...preset, id: crypto.randomUUID() }]);
  }

  updatePreset(preset: ModelPreset) {
    return this.save(this.presets.map((current) => (current.id === preset.id ? preset : current)));
  }

  duplicatePreset(id: string) {
    const source = this.presets.find((preset) => preset.id === id);
    if (!source) return Promise.resolve();
    return this.createPreset({ ...source, name: `${source.name} copy` });
  }

  deletePreset(id: string) {
    return this.save(
      this.presets.filter((preset) => preset.id !== id),
      this.defaultPresetId === id ? undefined : this.defaultPresetId,
    );
  }

  setDefaultPreset(id: string | undefined) {
    return this.save(this.presets, id);
  }

  private save(presets: readonly ModelPreset[], defaultPresetId = this.defaultPresetId) {
    const revision = ++this.saveRevision;
    const optimistic = presets.map((preset) => ({ ...preset }));
    this.presets.splice(0, this.presets.length, ...optimistic);
    this.defaultPresetId = defaultPresetId;
    this.saving = true;
    this.error = undefined;
    this.errorDetails = undefined;
    const save = this.saveQueue
      .catch(() => undefined)
      .then(() => this.props.client.setModelPresets(optimistic, defaultPresetId))
      .then((state) => {
        if (this.signal.aborted) return;
        this.persistedPresets = (state.modelPresets ?? []).map((preset) => ({ ...preset }));
        this.persistedDefaultPresetId = state.defaultModelPresetId;
        if (revision === this.saveRevision) this.restorePersisted();
      })
      .catch((error) => {
        if (this.signal.aborted || revision !== this.saveRevision) return;
        this.restorePersisted();
        const described = describeError(error);
        this.error = described.message;
        this.errorDetails = described.details;
      })
      .finally(() => {
        if (!this.signal.aborted && revision === this.saveRevision) this.saving = false;
      });
    this.saveQueue = save;
    return save;
  }

  private restorePersisted() {
    this.presets.splice(
      0,
      this.presets.length,
      ...this.persistedPresets.map((preset) => ({ ...preset })),
    );
    this.defaultPresetId = this.persistedDefaultPresetId;
  }
}

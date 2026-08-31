import { Store, observable, snapshot } from "r-state-tree";
import type { ChatConfiguration, ModelOption, ModelPreset } from "../../ipc/session-contract";
import { RendererClientContext } from "../client/RendererClientContext";
import { describeError } from "../error-details";

interface ModelPresetProjection {
  readonly presets: readonly ModelPreset[];
  readonly defaultPresetId?: string;
}

export type ModelPresetResolutionStatus =
  | "available"
  | "unknown"
  | "unauthenticated"
  | "unavailable"
  | "unsupported-thinking-level"
  | "unsupported-fast-mode";

/**
 * Owns the one renderer model-preset collection, default new-session
 * configuration, and serialized optimistic semantic command queue.
 */
export class ModelPresetSettingsStore extends Store {
  readonly presets: ModelPreset[] = observable([]);
  readonly catalogModels: ModelOption[] = observable([]);
  defaultPresetId: string | undefined;
  @snapshot lastUsedConfiguration: ChatConfiguration | undefined;
  loading = true;
  saving = false;
  sectionRequestRevision = 0;
  error: string | undefined;
  errorDetails: string | undefined;
  private commandRevision = 0;
  private commandQueue: Promise<unknown> = Promise.resolve();
  private hydration: Promise<void> | undefined;
  private persistedPresets: ModelPreset[] = [];
  private persistedDefaultPresetId: string | undefined;
  private readonly authoritativeIds = new Map<string, string>();

  get client() {
    return RendererClientContext.consume(this)!;
  }

  hydrate() {
    this.hydration ??= this.performHydration();
    return this.hydration;
  }

  get modelsByProvider() {
    const groups = new Map<string, { name: string; models: ModelOption[] }>();
    for (const model of this.catalogModels) {
      const group = groups.get(model.provider) ?? { name: model.providerName, models: [] };
      group.models.push(model);
      groups.set(model.provider, group);
    }
    return [...groups.entries()].map(([id, group]) => ({ id, ...group }));
  }

  resolutionStatus(preset: ModelPreset): ModelPresetResolutionStatus {
    const model = this.catalogModels.find(
      (candidate) => candidate.provider === preset.provider && candidate.id === preset.modelId,
    );
    if (!model) return "unknown";
    if (!model.authenticated) return "unauthenticated";
    if (model.available === false) return "unavailable";
    if (!model.availableThinkingLevels.includes(preset.thinkingLevel))
      return "unsupported-thinking-level";
    if (preset.fastMode && !model.fastMode) return "unsupported-fast-mode";
    return "available";
  }

  get defaultConfiguration() {
    const preset = this.presets.find((candidate) => candidate.id === this.defaultPresetId);
    if (preset)
      return {
        provider: preset.provider,
        modelId: preset.modelId,
        thinkingLevel: preset.thinkingLevel,
        fastMode: preset.fastMode,
      } satisfies ChatConfiguration;
    return this.lastUsedConfiguration ? { ...this.lastUsedConfiguration } : undefined;
  }

  /** Records the configuration a chat is actually running with for the no-default fallback. */
  recordUsage(configuration: ChatConfiguration) {
    const current = this.lastUsedConfiguration;
    if (
      current &&
      current.provider === configuration.provider &&
      current.modelId === configuration.modelId &&
      current.thinkingLevel === configuration.thinkingLevel &&
      current.fastMode === configuration.fastMode
    )
      return;
    this.lastUsedConfiguration = { ...configuration };
  }

  requestSection() {
    this.sectionRequestRevision += 1;
  }

  createPreset(preset: Omit<ModelPreset, "id">) {
    const optimisticId = crypto.randomUUID();
    const revision = this.beginOptimistic(
      [...this.presets, { ...preset, id: optimisticId }],
      this.defaultPresetId,
    );
    return this.enqueue(revision, async () => {
      const knownIds = new Set(this.persistedPresets.map((candidate) => candidate.id));
      const state = await this.client.modelPresets.create(preset, {
        signal: this.signal,
      });
      const created = state.presets.find((candidate) => !knownIds.has(candidate.id));
      if (created) this.authoritativeIds.set(optimisticId, created.id);
      return state;
    });
  }

  updatePreset(preset: ModelPreset) {
    const revision = this.beginOptimistic(
      this.presets.map((current) => (current.id === preset.id ? { ...preset } : current)),
      this.defaultPresetId,
    );
    return this.enqueue(revision, () =>
      this.client.modelPresets.update(
        {
          ...preset,
          id: this.resolveAuthoritativeId(preset.id),
        },
        { signal: this.signal },
      ),
    );
  }

  duplicatePreset(id: string) {
    const source = this.presets.find((preset) => preset.id === id);
    if (!source) return Promise.resolve();
    return this.createPreset({ ...source, name: `${source.name} copy` });
  }

  deletePreset(id: string) {
    const revision = this.beginOptimistic(
      this.presets.filter((preset) => preset.id !== id),
      this.defaultPresetId === id ? undefined : this.defaultPresetId,
    );
    return this.enqueue(revision, () =>
      this.client.modelPresets.remove(this.resolveAuthoritativeId(id), {
        signal: this.signal,
      }),
    );
  }

  setDefaultPreset(id: string | undefined) {
    const revision = this.beginOptimistic(this.presets, id);
    return this.enqueue(revision, () =>
      this.client.modelPresets.setDefault(
        id === undefined ? undefined : this.resolveAuthoritativeId(id),
        { signal: this.signal },
      ),
    );
  }

  private async performHydration() {
    const [presets, models] = await Promise.allSettled([
      this.client.modelPresets.list({ signal: this.signal }),
      this.client.models.list({ signal: this.signal }),
    ]);
    if (this.signal.aborted) return;
    if (presets.status === "fulfilled") {
      this.acceptAuthoritative(presets.value);
      this.restorePersisted();
    } else this.setError(presets.reason);
    if (models.status === "fulfilled")
      this.catalogModels.splice(0, this.catalogModels.length, ...models.value);
    else if (presets.status === "fulfilled") this.setError(models.reason);
    this.loading = false;
  }

  private beginOptimistic(presets: readonly ModelPreset[], defaultPresetId: string | undefined) {
    const revision = ++this.commandRevision;
    this.presets.splice(0, this.presets.length, ...presets.map((preset) => ({ ...preset })));
    this.defaultPresetId = defaultPresetId;
    this.saving = true;
    this.error = undefined;
    this.errorDetails = undefined;
    return revision;
  }

  private enqueue(revision: number, command: () => Promise<ModelPresetProjection>) {
    const pending = this.commandQueue
      .catch(() => undefined)
      .then(command)
      .then((state) => {
        if (this.signal.aborted) return;
        this.acceptAuthoritative(state);
        if (revision === this.commandRevision) this.restorePersisted();
      })
      .catch((error) => {
        if (this.signal.aborted || revision !== this.commandRevision) return;
        this.restorePersisted();
        this.setError(error);
      })
      .finally(() => {
        if (!this.signal.aborted && revision === this.commandRevision) this.saving = false;
      });
    this.commandQueue = pending;
    return pending;
  }

  private acceptAuthoritative(state: ModelPresetProjection) {
    this.persistedPresets = state.presets.map((preset) => ({ ...preset }));
    this.persistedDefaultPresetId = state.defaultPresetId;
  }

  private resolveAuthoritativeId(id: string) {
    return this.authoritativeIds.get(id) ?? id;
  }

  private restorePersisted() {
    this.presets.splice(
      0,
      this.presets.length,
      ...this.persistedPresets.map((preset) => ({ ...preset })),
    );
    this.defaultPresetId = this.persistedDefaultPresetId;
  }

  private setError(error: unknown) {
    const described = describeError(error);
    this.error = described.message;
    this.errorDetails = described.details;
  }
}

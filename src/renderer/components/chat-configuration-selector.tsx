import { useEffect, useMemo, useRef, useState } from "react";
import { observer } from "r-state-tree/react";
import type { ModelOption, ThinkingLevel } from "../../ipc/session-contract";
import { FastModeToggle } from "./fast-mode-toggle";
import { ChevronDownIcon } from "./ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import type { ChatConfigurationStore } from "../stores/ChatConfigurationStore";

type ConfigurationView = "current" | "models" | "configure";
type PanelMotion = "forward" | "back" | undefined;

function reasoningLabel(level: ThinkingLevel) {
  return level === "off" ? "Off" : `${level.charAt(0).toUpperCase()}${level.slice(1)}`;
}

function modelValue(model: ModelOption) {
  return `${model.provider}/${model.id}`;
}

export const ChatConfigurationSelector = observer(function ChatConfigurationSelector({
  configuration,
}: {
  configuration: ChatConfigurationStore;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ConfigurationView>("current");
  const [motion, setMotion] = useState<PanelMotion>();
  const [query, setQuery] = useState("");
  const [draftModel, setDraftModel] = useState<ModelOption>();
  const [draftThinkingLevel, setDraftThinkingLevel] = useState<ThinkingLevel>();
  const [draftFastMode, setDraftFastMode] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const configureBackRef = useRef<HTMLButtonElement>(null);
  const session = configuration.session;
  const selectedModel = session?.model;
  const disabled = Boolean(session?.streaming || configuration.activeOperations.length > 0);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const presets = configuration.presets.filter((preset) =>
    `${preset.name} ${preset.provider} ${preset.modelId} ${preset.thinkingLevel}`
      .toLocaleLowerCase()
      .includes(normalizedQuery),
  );
  const groups = useMemo(
    () =>
      configuration.connectedModelsByProvider
        .map((group) => ({
          ...group,
          models: group.models.filter((model) =>
            `${model.name} ${model.id} ${group.name}`.toLocaleLowerCase().includes(normalizedQuery),
          ),
        }))
        .filter((group) => group.models.length > 0),
    [configuration.connectedModelsByProvider, normalizedQuery],
  );
  const activeName = configuration.activePreset?.name ?? selectedModel?.name ?? "Choose model";
  const displayThinking = selectedModel
    ? session?.thinkingLevel
    : configuration.activePreset?.thinkingLevel;
  const displayFast = selectedModel
    ? configuration.fastMode
    : Boolean(configuration.activePreset?.fastMode);
  const summary =
    session && (selectedModel || configuration.activePreset)
      ? `${reasoningLabel(displayThinking ?? "off")} reasoning${displayFast ? " · Fast" : ""}`
      : "Model configuration";

  useEffect(() => {
    if (open) configuration.ensureCatalog();
    if (!open) return;
    if (view === "models") searchRef.current?.focus();
    else if (view === "configure") configureBackRef.current?.focus();
  }, [open, view, configuration]);

  const reset = () => {
    setView(selectedModel ? "current" : "models");
    setMotion(undefined);
    setQuery("");
    setDraftModel(undefined);
    setDraftThinkingLevel(undefined);
    setDraftFastMode(false);
  };

  const close = () => {
    setOpen(false);
    reset();
  };

  const showModels = () => {
    setMotion(view === "configure" ? "back" : "forward");
    setView("models");
    setQuery("");
  };

  const configureModel = (model: ModelOption) => {
    const isCurrent =
      selectedModel?.provider === model.provider &&
      selectedModel.id === model.id &&
      Boolean(session);
    const supportedCurrentLevel =
      isCurrent && session && model.availableThinkingLevels.includes(session.thinkingLevel)
        ? session.thinkingLevel
        : undefined;
    setDraftModel(model);
    setDraftThinkingLevel(
      supportedCurrentLevel ??
        (model.availableThinkingLevels.length === 1 ? model.availableThinkingLevels[0] : undefined),
    );
    setDraftFastMode(Boolean(isCurrent && model.fastMode && configuration.fastMode));
    setMotion("forward");
    setView("configure");
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
        else setView(selectedModel ? "current" : "models");
      }}
    >
      <PopoverTrigger
        variant="ghost"
        size="sm"
        className="chat-configuration-trigger"
        aria-label="Model configuration"
      >
        <span>
          <strong>{activeName}</strong>
          <small>{summary}</small>
        </span>
        <ChevronDownIcon size={13} />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="chat-configuration-menu"
        aria-label="Model configuration"
      >
        <div
          className={`chat-configuration-panel${motion ? ` configuration-panel-${motion}` : ""}`}
          key={view}
        >
          {view === "current" && session && selectedModel && (
            <>
              <header className="chat-configuration-header">
                <span>
                  <strong>{selectedModel.name}</strong>
                  <small>{selectedModel.id}</small>
                </span>
                <button type="button" onClick={showModels} disabled={disabled}>
                  Change model
                  <span aria-hidden="true">›</span>
                </button>
              </header>
              <section className="chat-configuration-reasoning" aria-label="Reasoning effort">
                <span>
                  <strong>Reasoning</strong>
                  <small>Choose how much time this model spends thinking.</small>
                </span>
                <div role="group" aria-label="Reasoning level">
                  {session.availableThinkingLevels.map((level) => (
                    <button
                      type="button"
                      aria-pressed={session.thinkingLevel === level}
                      disabled={disabled}
                      key={level}
                      onClick={() => {
                        close();
                        void configuration.selectThinkingLevel(level);
                      }}
                    >
                      {reasoningLabel(level)}
                    </button>
                  ))}
                </div>
              </section>
              {session.fastModeAvailable && (
                <section className="chat-configuration-fast" aria-label="Fast mode setting">
                  <span>
                    <strong>Fast mode</strong>
                    <small>Use priority processing for this model.</small>
                  </span>
                  <FastModeToggle
                    enabled={configuration.fastMode}
                    disabled={disabled}
                    onToggle={(enabled) => void configuration.selectFastMode(enabled)}
                  />
                </section>
              )}
            </>
          )}

          {view === "models" && (
            <>
              <header className="chat-configuration-list-header">
                {selectedModel && (
                  <button
                    type="button"
                    aria-label="Back to current model"
                    onClick={() => {
                      setMotion("back");
                      setView("current");
                    }}
                  >
                    <span aria-hidden="true">‹</span>
                  </button>
                )}
                <strong>Choose model</strong>
              </header>
              <input
                ref={searchRef}
                className="chat-configuration-search"
                aria-label="Search presets and models"
                placeholder="Search presets and models…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <div className="chat-configuration-options">
                {presets.length > 0 && (
                  <section aria-label="Model presets">
                    <h3>Presets</h3>
                    {presets.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                          close();
                          void configuration.selectPreset(preset);
                        }}
                      >
                        <span>
                          <strong>{preset.name}</strong>
                          <small>
                            {preset.provider}/{preset.modelId}
                          </small>
                        </span>
                        <span className="configuration-badges">
                          <i>{reasoningLabel(preset.thinkingLevel)}</i>
                          {preset.fastMode && <i>Fast</i>}
                        </span>
                      </button>
                    ))}
                  </section>
                )}
                {groups.map((group) => (
                  <section aria-label={group.name} key={group.id}>
                    <h3>{group.name}</h3>
                    {group.models.map((model) => (
                      <button
                        key={modelValue(model)}
                        type="button"
                        disabled={disabled}
                        onClick={() => configureModel(model)}
                      >
                        <span>
                          <strong>{model.name}</strong>
                          <small>{model.id}</small>
                        </span>
                        <span aria-hidden="true">›</span>
                      </button>
                    ))}
                  </section>
                ))}
                {presets.length === 0 && groups.length === 0 && <p>No matching models</p>}
              </div>
              <button
                className="chat-configuration-settings"
                type="button"
                onClick={() => {
                  close();
                  configuration.openPresetSettings();
                }}
              >
                Manage model presets in Settings
              </button>
            </>
          )}

          {view === "configure" && draftModel && (
            <>
              <header className="chat-configuration-list-header">
                <button
                  ref={configureBackRef}
                  type="button"
                  aria-label="Back to models"
                  onClick={showModels}
                >
                  <span aria-hidden="true">‹</span>
                </button>
                <span>
                  <strong>{draftModel.name}</strong>
                  <small>{draftModel.id}</small>
                </span>
              </header>
              <section className="chat-configuration-reasoning" aria-label="Reasoning effort">
                <span>
                  <strong>Reasoning</strong>
                  <small>Available levels are provided by this model.</small>
                </span>
                <div role="group" aria-label="Reasoning level">
                  {draftModel.availableThinkingLevels.map((level) => (
                    <button
                      type="button"
                      aria-pressed={draftThinkingLevel === level}
                      key={level}
                      onClick={() => setDraftThinkingLevel(level)}
                    >
                      {reasoningLabel(level)}
                    </button>
                  ))}
                </div>
              </section>
              {draftModel.fastMode && (
                <section className="chat-configuration-fast" aria-label="Fast mode setting">
                  <span>
                    <strong>Fast mode</strong>
                    <small>Use priority processing for this model.</small>
                  </span>
                  <FastModeToggle enabled={draftFastMode} onToggle={setDraftFastMode} />
                </section>
              )}
              {!draftThinkingLevel && (
                <p className="chat-configuration-hint">Choose a reasoning level to continue.</p>
              )}
              <footer className="chat-configuration-actions">
                <button type="button" onClick={close}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={!draftThinkingLevel || disabled}
                  onClick={() => {
                    if (!draftThinkingLevel) return;
                    const next = {
                      provider: draftModel.provider,
                      modelId: draftModel.id,
                      thinkingLevel: draftThinkingLevel,
                      fastMode: draftModel.fastMode ? draftFastMode : false,
                    };
                    close();
                    void configuration.selectConfiguration(next);
                  }}
                >
                  Apply
                </button>
              </footer>
            </>
          )}
          {configuration.error && (
            <p className="chat-configuration-error" role="alert">
              {configuration.error}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
});

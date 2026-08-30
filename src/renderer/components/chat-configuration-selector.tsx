import { useEffect, useMemo, useRef, useState } from "react";
import { observer } from "r-state-tree/react";
import type { ModelOption, ThinkingLevel } from "../../ipc/session-contract";
import { FastModeToggle } from "./fast-mode-toggle";
import { ChevronDownIcon } from "./ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { IconButton } from "./ui/icon-button";
import { NavItem } from "./ui/nav-item";
import { Badge } from "./ui/badge";
import { SegmentedControlGroup, SegmentedControlButton } from "./ui/segmented-control";
import type { ChatConfigurationStore } from "../stores/ChatConfigurationStore";

type ConfigurationView = "current" | "models" | "configure";

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
    if (!open) return;
    if (view === "models") searchRef.current?.focus();
    else if (view === "configure") configureBackRef.current?.focus();
  }, [open, view]);

  const reset = () => {
    setView(selectedModel ? "current" : "models");
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
    setView("configure");
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
        else {
          configuration.ensureCatalog();
          setView(selectedModel ? "current" : "models");
        }
      }}
    >
      <PopoverTrigger
        variant="ghost"
        size="sm"
        className="flex max-w-full min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-left text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label="Model configuration"
      >
        <span className="flex min-w-0 flex-col">
          <strong className="truncate text-xs font-semibold text-foreground">{activeName}</strong>
          <small className="truncate text-[10px] text-muted-foreground">{summary}</small>
        </span>
        <span className="shrink-0 text-muted-foreground">
          <ChevronDownIcon size={13} />
        </span>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-80 overflow-hidden rounded-xl border border-border bg-card p-0 shadow-xl"
        aria-label="Model configuration"
      >
        <div className="p-3" key={view}>
          {view === "current" && session && selectedModel && (
            <>
              <header className="mb-3 flex items-start justify-between gap-2">
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-sm font-semibold text-foreground">
                    {selectedModel.name}
                  </strong>
                  <small className="block truncate font-mono text-[10px] text-muted-foreground">
                    {selectedModel.id}
                  </small>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={showModels}
                  disabled={disabled}
                  className="h-auto p-0 text-xs text-accent hover:underline hover:bg-transparent"
                >
                  Change model
                  <span aria-hidden="true">›</span>
                </Button>
              </header>
              <section className="mt-3 grid gap-1.5" aria-label="Reasoning effort">
                <span>
                  <strong className="block text-xs font-medium text-foreground">Reasoning</strong>
                  <small className="block text-[11px] text-muted-foreground">
                    Choose how much time this model spends thinking.
                  </small>
                </span>
                <SegmentedControlGroup size="sm" className="w-full flex">
                  {session.availableThinkingLevels.map((level) => (
                    <SegmentedControlButton
                      type="button"
                      size="sm"
                      className="flex-1"
                      active={session.thinkingLevel === level}
                      disabled={disabled}
                      key={level}
                      onClick={() => {
                        close();
                        void configuration.selectThinkingLevel(level);
                      }}
                    >
                      {reasoningLabel(level)}
                    </SegmentedControlButton>
                  ))}
                </SegmentedControlGroup>
              </section>
              {session.fastModeAvailable && (
                <section
                  className="mt-3 flex items-center justify-between gap-2"
                  aria-label="Fast mode setting"
                >
                  <span>
                    <strong className="block text-xs font-medium text-foreground">Fast mode</strong>
                    <small className="block text-[11px] text-muted-foreground">
                      Use priority processing for this model.
                    </small>
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
              <header className="mb-2.5 flex items-center gap-2">
                {selectedModel && (
                  <IconButton
                    tooltip="Back to current model"
                    className="size-6"
                    onClick={() => {
                      setView("current");
                    }}
                  >
                    <span aria-hidden="true">‹</span>
                  </IconButton>
                )}
                <strong className="text-xs font-semibold text-foreground">Choose model</strong>
              </header>
              <Input
                ref={searchRef}
                className="mb-2 h-8 text-xs"
                aria-label="Search presets and models"
                placeholder="Search presets and models…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <div className="max-h-60 space-y-3 overflow-y-auto pr-1 text-xs">
                {presets.length > 0 && (
                  <section aria-label="Model presets" className="space-y-1">
                    <h3 className="font-mono text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                      Presets
                    </h3>
                    {presets.map((preset) => (
                      <NavItem
                        key={preset.id}
                        disabled={disabled}
                        label={preset.name}
                        description={`${preset.provider}/${preset.modelId}`}
                        onClick={() => {
                          close();
                          void configuration.selectPreset(preset);
                        }}
                        trailing={
                          <div className="flex shrink-0 items-center gap-1 font-mono text-[10px]">
                            <Badge variant="outline" className="text-[10px]">
                              {reasoningLabel(preset.thinkingLevel)}
                            </Badge>
                            {preset.fastMode && (
                              <Badge variant="accent" className="text-[10px]">
                                Fast
                              </Badge>
                            )}
                          </div>
                        }
                      />
                    ))}
                  </section>
                )}
                {groups.map((group) => (
                  <section aria-label={group.name} key={group.id} className="space-y-1">
                    <h3 className="font-mono text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                      {group.name}
                    </h3>
                    {group.models.map((model) => (
                      <NavItem
                        key={modelValue(model)}
                        disabled={disabled}
                        label={model.name}
                        description={model.id}
                        onClick={() => configureModel(model)}
                        trailing={<span aria-hidden="true">›</span>}
                      />
                    ))}
                  </section>
                ))}
                {presets.length === 0 && groups.length === 0 && (
                  <p className="p-3 text-center text-xs text-muted-foreground">
                    No matching models
                  </p>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="mt-2 h-auto w-full text-center text-[11px] text-accent hover:underline hover:bg-transparent"
                type="button"
                onClick={() => {
                  close();
                  configuration.openPresetSettings();
                }}
              >
                Manage model presets in Settings
              </Button>
            </>
          )}

          {view === "configure" && draftModel && (
            <>
              <header className="mb-2.5 flex items-center gap-2">
                <IconButton
                  ref={configureBackRef}
                  tooltip="Back to models"
                  className="size-6"
                  onClick={showModels}
                >
                  <span aria-hidden="true">‹</span>
                </IconButton>
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-xs font-semibold text-foreground">
                    {draftModel.name}
                  </strong>
                  <small className="block truncate font-mono text-[10px] text-muted-foreground">
                    {draftModel.id}
                  </small>
                </span>
              </header>
              <section className="mt-3 grid gap-1.5" aria-label="Reasoning level">
                <span>
                  <strong className="block text-xs font-medium text-foreground">Reasoning</strong>
                  <small className="block text-[11px] text-muted-foreground">
                    Available levels are provided by this model.
                  </small>
                </span>
                <SegmentedControlGroup size="sm" className="w-full flex">
                  {draftModel.availableThinkingLevels.map((level) => (
                    <SegmentedControlButton
                      type="button"
                      size="sm"
                      className="flex-1"
                      active={draftThinkingLevel === level}
                      key={level}
                      onClick={() => setDraftThinkingLevel(level)}
                    >
                      {reasoningLabel(level)}
                    </SegmentedControlButton>
                  ))}
                </SegmentedControlGroup>
              </section>
              {draftModel.fastMode && (
                <section
                  className="mt-3 flex items-center justify-between gap-2"
                  aria-label="Fast mode setting"
                >
                  <span>
                    <strong className="block text-xs font-medium text-foreground">Fast mode</strong>
                    <small className="block text-[11px] text-muted-foreground">
                      Use priority processing for this model.
                    </small>
                  </span>
                  <FastModeToggle enabled={draftFastMode} onToggle={setDraftFastMode} />
                </section>
              )}
              {!draftThinkingLevel && (
                <p className="mt-2 text-xs text-amber-500">Choose a reasoning level to continue.</p>
              )}
              <footer className="mt-3 flex justify-end gap-2 border-t border-border pt-2.5">
                <Button variant="ghost" size="sm" onClick={close}>
                  Cancel
                </Button>
                <Button
                  size="sm"
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
                </Button>
              </footer>
            </>
          )}
          {configuration.error && (
            <p className="mt-2 text-xs text-destructive" role="alert">
              {configuration.error}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
});

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { ModelOption, ModelPreset, ThinkingLevel } from "../../ipc/session-contract";
import { FastModeToggle } from "./fast-mode-toggle";
import { ChevronDownIcon } from "./ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { IconButton } from "./ui/icon-button";
import { NavItem } from "./ui/nav-item";
import { Badge } from "./ui/badge";
import { SegmentedControlGroup, SegmentedControlButton } from "./ui/segmented-control";

export interface ModelGroup {
  id: string;
  name: string;
  models: readonly ModelOption[];
}

interface ModelConfigurationValue {
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
  fastMode?: boolean;
}

export interface ModelPickerProps {
  groups: readonly ModelGroup[];
  value?: ModelConfigurationValue;
  presets?: readonly ModelPreset[];
  activePreset?: ModelPreset;
  onSelect(value: {
    provider: string;
    modelId: string;
    thinkingLevel: ThinkingLevel;
    fastMode: boolean;
  }): void;
  onSelectPreset?(preset: ModelPreset): void;
  onClear?(): void;
  allowClear?: boolean;
  showFastMode?: boolean;
  openPresetSettings?(): void;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  error?: string;
  triggerTrailing?: ReactNode;
}

type ConfigurationView = "current" | "models" | "configure";

function reasoningLabel(level?: ThinkingLevel) {
  if (!level || level === "off") return "Off";
  return `${level.charAt(0).toUpperCase()}${level.slice(1)}`;
}

function modelKey(provider: string, modelId: string) {
  return `${provider}/${modelId}`;
}

export function ModelPicker({
  groups,
  value,
  presets = [],
  activePreset,
  onSelect,
  onSelectPreset,
  onClear,
  allowClear = false,
  showFastMode = true,
  openPresetSettings,
  disabled = false,
  placeholder = "Choose model",
  ariaLabel = "Model configuration",
  className,
  error,
  triggerTrailing,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ConfigurationView>("current");
  const [query, setQuery] = useState("");
  const [draftModel, setDraftModel] = useState<ModelOption>();
  const [draftThinkingLevel, setDraftThinkingLevel] = useState<ThinkingLevel>();
  const [draftFastMode, setDraftFastMode] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const configureBackRef = useRef<HTMLButtonElement>(null);

  const allModels = useMemo(() => groups.flatMap((group) => group.models), [groups]);
  const selectedModel = useMemo(
    () =>
      value?.provider && value?.modelId
        ? allModels.find((model) => model.provider === value.provider && model.id === value.modelId)
        : undefined,
    [allModels, value?.provider, value?.modelId],
  );

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredPresets = useMemo(
    () =>
      presets.filter((preset) =>
        `${preset.name} ${preset.provider} ${preset.modelId} ${preset.thinkingLevel}`
          .toLocaleLowerCase()
          .includes(normalizedQuery),
      ),
    [presets, normalizedQuery],
  );

  const filteredGroups = useMemo(
    () =>
      groups
        .map((group) => ({
          ...group,
          models: group.models.filter((model) =>
            `${model.name} ${model.id} ${group.name}`.toLocaleLowerCase().includes(normalizedQuery),
          ),
        }))
        .filter((group) => group.models.length > 0),
    [groups, normalizedQuery],
  );

  const activeName =
    activePreset?.name ?? selectedModel?.name ?? (value?.modelId ? value.modelId : placeholder);
  const displayThinking = value?.thinkingLevel ?? activePreset?.thinkingLevel;
  const displayFast = value?.fastMode ?? Boolean(activePreset?.fastMode);
  const hasValue = Boolean(value?.provider && value?.modelId);
  const summary = hasValue
    ? `${reasoningLabel(displayThinking)} reasoning${showFastMode && displayFast ? " · Fast" : ""}`
    : placeholder;

  useEffect(() => {
    if (!open) return;
    if (view === "models") {
      if (document.activeElement !== searchRef.current) {
        searchRef.current?.focus();
      }
    } else if (view === "configure") {
      if (document.activeElement !== configureBackRef.current) {
        configureBackRef.current?.focus();
      }
    }
  }, [open, view]);

  const reset = () => {
    setView(hasValue ? "current" : "models");
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
    const isCurrent = value?.provider === model.provider && value?.modelId === model.id;
    const supportedCurrentLevel =
      isCurrent &&
      value?.thinkingLevel &&
      model.availableThinkingLevels?.includes(value.thinkingLevel)
        ? value.thinkingLevel
        : undefined;
    setDraftModel(model);
    setDraftThinkingLevel(
      supportedCurrentLevel ??
        ((model.availableThinkingLevels?.length ?? 0) === 1
          ? model.availableThinkingLevels![0]
          : "off"),
    );
    setDraftFastMode(Boolean(isCurrent && model.fastMode && value?.fastMode));
    setView("configure");
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
        else {
          setView(hasValue ? "current" : "models");
        }
      }}
    >
      <PopoverTrigger
        variant="ghost"
        size="sm"
        disabled={disabled}
        className={cn(
          "flex max-w-[320px] min-w-0 items-center justify-between gap-2 rounded-lg px-2.5 py-1 text-left text-muted-foreground hover:bg-muted hover:text-foreground",
          className,
        )}
        aria-label={ariaLabel}
      >
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <strong className="truncate text-xs font-semibold text-foreground">{activeName}</strong>
          <small className="truncate font-mono text-[10px] text-muted-foreground">{summary}</small>
        </span>
        <div className="flex shrink-0 items-center gap-1 text-muted-foreground">
          {triggerTrailing}
          <ChevronDownIcon size={13} />
        </div>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-[360px] max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-border bg-card p-0 shadow-2xl"
        aria-label={ariaLabel}
      >
        <div className="p-3" key={view}>
          {view === "current" && hasValue && (
            <>
              <header className="mb-3 flex items-start justify-between gap-2">
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-sm font-semibold text-foreground">
                    {selectedModel?.name ?? value?.modelId}
                  </strong>
                  <small className="block truncate font-mono text-[10px] text-muted-foreground">
                    {value ? modelKey(value.provider, value.modelId) : ""}
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
              {selectedModel && (selectedModel.availableThinkingLevels?.length ?? 0) > 0 && (
                <section className="mt-3 grid gap-1.5" aria-label="Reasoning effort">
                  <span>
                    <strong className="block text-xs font-medium text-foreground">Reasoning</strong>
                    <small className="block text-[11px] text-muted-foreground">
                      Choose how much time this model spends thinking.
                    </small>
                  </span>
                  <SegmentedControlGroup size="sm" className="w-full flex">
                    {selectedModel.availableThinkingLevels?.map((level) => (
                      <SegmentedControlButton
                        type="button"
                        size="sm"
                        className="flex-1"
                        active={(value?.thinkingLevel ?? "off") === level}
                        disabled={disabled}
                        key={level}
                        onClick={() => {
                          close();
                          onSelect({
                            provider: value!.provider,
                            modelId: value!.modelId,
                            thinkingLevel: level,
                            fastMode: Boolean(value?.fastMode),
                          });
                        }}
                      >
                        {reasoningLabel(level)}
                      </SegmentedControlButton>
                    ))}
                  </SegmentedControlGroup>
                </section>
              )}
              {showFastMode && selectedModel?.fastMode && (
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
                    enabled={Boolean(value?.fastMode)}
                    disabled={disabled}
                    onToggle={(enabled) => {
                      onSelect({
                        provider: value!.provider,
                        modelId: value!.modelId,
                        thinkingLevel: value?.thinkingLevel ?? "off",
                        fastMode: enabled,
                      });
                    }}
                  />
                </section>
              )}
              {allowClear && onClear && (
                <footer className="mt-3 flex justify-end border-t border-border pt-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      close();
                      onClear();
                    }}
                  >
                    Clear selection
                  </Button>
                </footer>
              )}
            </>
          )}

          {view === "models" && (
            <>
              <header className="mb-2.5 flex items-center justify-between">
                <strong className="text-xs font-semibold text-foreground">Choose model</strong>
              </header>
              <Input
                ref={searchRef}
                autoFocus
                className="mb-2 h-8 text-xs"
                aria-label="Search presets and models"
                placeholder="Search presets and models…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <div className="max-h-60 space-y-3 overflow-y-auto pr-1 text-xs">
                {filteredPresets.length > 0 && (
                  <section aria-label="Model presets" className="space-y-1">
                    <h3 className="font-mono text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                      Presets
                    </h3>
                    {filteredPresets.map((preset) => (
                      <NavItem
                        key={preset.id}
                        disabled={disabled}
                        label={preset.name}
                        description={`${preset.provider}/${preset.modelId}`}
                        onClick={() => {
                          close();
                          if (onSelectPreset) onSelectPreset(preset);
                          else
                            onSelect({
                              provider: preset.provider,
                              modelId: preset.modelId,
                              thinkingLevel: preset.thinkingLevel,
                              fastMode: preset.fastMode,
                            });
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
                {filteredGroups.map((group) => (
                  <section aria-label={group.name} key={group.id} className="space-y-1">
                    <h3 className="font-mono text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                      {group.name}
                    </h3>
                    {group.models.map((model) => (
                      <NavItem
                        key={modelKey(model.provider, model.id)}
                        disabled={disabled}
                        label={model.name}
                        description={model.id}
                        onClick={() => configureModel(model)}
                        trailing={<span aria-hidden="true">›</span>}
                      />
                    ))}
                  </section>
                ))}
                {filteredPresets.length === 0 && filteredGroups.length === 0 && (
                  <p className="p-3 text-center text-xs text-muted-foreground">
                    No matching models
                  </p>
                )}
              </div>
              {openPresetSettings && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2 h-auto w-full text-center text-[11px] text-accent hover:underline hover:bg-transparent"
                  type="button"
                  onClick={() => {
                    close();
                    openPresetSettings();
                  }}
                >
                  Manage model presets in Settings
                </Button>
              )}
              {allowClear && onClear && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2 h-auto w-full text-center text-[11px] text-muted-foreground hover:underline hover:bg-transparent"
                  type="button"
                  onClick={() => {
                    close();
                    onClear();
                  }}
                >
                  Clear model
                </Button>
              )}
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
              {(draftModel.availableThinkingLevels?.length ?? 0) > 0 && (
                <section className="mt-3 grid gap-1.5" aria-label="Reasoning level">
                  <span>
                    <strong className="block text-xs font-medium text-foreground">Reasoning</strong>
                    <small className="block text-[11px] text-muted-foreground">
                      Available levels are provided by this model.
                    </small>
                  </span>
                  <SegmentedControlGroup size="sm" className="w-full flex">
                    {draftModel.availableThinkingLevels?.map((level) => (
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
              )}
              {showFastMode && draftModel.fastMode && (
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
              {!draftThinkingLevel && (draftModel.availableThinkingLevels?.length ?? 0) > 0 && (
                <p className="mt-2 text-xs text-amber-500">Choose a reasoning level to continue.</p>
              )}
              <footer className="mt-3 flex justify-end gap-2 border-t border-border pt-2.5">
                <Button variant="ghost" size="sm" onClick={close}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={
                    ((draftModel.availableThinkingLevels?.length ?? 0) > 0 &&
                      !draftThinkingLevel) ||
                    disabled
                  }
                  onClick={() => {
                    const level = draftThinkingLevel ?? "off";
                    close();
                    onSelect({
                      provider: draftModel.provider,
                      modelId: draftModel.id,
                      thinkingLevel: level,
                      fastMode: draftModel.fastMode ? draftFastMode : false,
                    });
                  }}
                >
                  Apply
                </Button>
              </footer>
            </>
          )}
          {error && (
            <p className="mt-2 text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

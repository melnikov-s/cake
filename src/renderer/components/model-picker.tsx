import {
  antigravityModel,
  antigravityModelName,
  isAntigravityModel,
} from "../../contracts/model-presets/antigravity-model";
import type { PresetContext } from "../../contracts/model-presets/preset-context";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { observer } from "r-state-tree/react";
import { cn } from "@/lib/utils";
import type {
  ModelOption,
  ModelPreset,
  ThinkingLevel,
  UtilityModel,
} from "../../contracts/conversations/session-contract";
import type { ModelOption as RuntimeModelOption } from "../models/ModelOption";
import type { ModelCatalogStore } from "../stores/ModelCatalogStore";
import { FastModeToggle } from "./fast-mode-toggle";
import { ChevronDownIcon, SearchIcon } from "./ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { IconButton } from "./ui/icon-button";
import { IconSizeProvider } from "./ui/icon-size";
import { NavItem } from "./ui/nav-item";
import { Badge } from "./ui/badge";
import { Callout } from "./ui/callout";
import { SegmentedControlGroup, SegmentedControlButton } from "./ui/segmented-control";

type PickerCatalogModel = Pick<
  ModelOption,
  "id" | "provider" | "name" | "availableThinkingLevels" | "fastMode"
>;
type PickerModel = PickerCatalogModel | RuntimeModelOption;

interface ModelGroup {
  id: string;
  name: string;
  models: readonly PickerModel[];
}

interface ModelIdentity {
  provider: string;
  modelId: string;
}

interface ModelConfigurationValue extends ModelIdentity {
  preset?: PresetContext;
  thinkingLevel?: ThinkingLevel;
  fastMode?: boolean;
}

export interface ModelPickerProps {
  /** External anchor for inline references; uses the same picker without a toolbar trigger. */
  anchorRef?: RefObject<HTMLElement | null>;
  open?: boolean;
  preview?: boolean;
  restoreFocus?(): void;
  onOpenChange?(open: boolean): void;
  /** Reactive catalog source, read only while the picker is open. */
  groups(): readonly ModelGroup[];
  /** Current identity's display name, independent of the full availability catalog. */
  currentModelName?: string;
  /** Present only on surfaces that can apply an Antigravity model. */
  antigravityCatalog?: ModelCatalogStore;
  onOpen?(): void;
  value?: ModelConfigurationValue;
  presets?: readonly ModelPreset[];
  activePreset?: ModelPreset;
  /** Listed as "Utility" after the presets; selecting it applies this configuration via onSelect. */
  utilityModel?: UtilityModel;
  onSelect(value: {
    preset?: PresetContext;
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
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  error?: string;
  triggerTrailing?: ReactNode;
}

type ConfigurationView = "current" | "models" | "configure";

/** One row of the preset group: a saved preset or the trailing utility model choice. */
interface PresetEntry {
  key: string;
  name: string;
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  fastMode: boolean;
  active: boolean;
  preset?: ModelPreset;
}

/** The model chip frame, shared by the picker trigger and the read-only ModelSummary. */
export const modelChipClassName =
  "inline-flex max-w-[320px] min-w-0 items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-3 py-1 text-xs font-medium text-foreground";

export function reasoningLabel(level?: ThinkingLevel) {
  if (!level || level === "off") return "Off";
  return `${level.charAt(0).toUpperCase()}${level.slice(1)}`;
}

function modelKey(provider: string, modelId: string) {
  return `${provider}/${modelId}`;
}

function pickerModelId(model: PickerModel) {
  return "modelId" in model ? model.modelId : model.id;
}

function findPickerModel(groups: readonly ModelGroup[], identity?: ModelIdentity) {
  if (!identity?.provider || !identity.modelId) return undefined;
  return groups
    .find((group) => group.id === identity.provider)
    ?.models.find((model) => pickerModelId(model) === identity.modelId);
}

const emptyGroups: readonly ModelGroup[] = [];
const antigravityOption = ({
  modelId,
  name,
}: {
  modelId: string;
  name: string;
}): PickerCatalogModel => ({
  provider: antigravityModel.provider,
  id: modelId,
  name,
  availableThinkingLevels: [],
});
const defaultAntigravityOption = antigravityOption(antigravityModel);
const modelDescription = (
  provider: string,
  modelId: string,
  fallback = modelKey(provider, modelId),
) =>
  provider === antigravityModel.provider && modelId === antigravityModel.modelId
    ? "Model chosen by Antigravity"
    : fallback;

export const ModelPicker = observer(function ModelPicker({
  groups,
  anchorRef,
  open: controlledOpen,
  preview = false,
  restoreFocus,
  onOpenChange,
  currentModelName,
  antigravityCatalog,
  onOpen,
  value,
  presets = [],
  activePreset,
  utilityModel,
  onSelect,
  onSelectPreset,
  onClear,
  allowClear = false,
  showFastMode = true,
  openPresetSettings,
  placeholder = "Choose model",
  ariaLabel = "Model configuration",
  className,
  error,
  triggerTrailing,
}: ModelPickerProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean) => {
    setInternalOpen(next);
    onOpenChange?.(next);
  };
  const [requestedView, setView] = useState<ConfigurationView>(value ? "current" : "models");
  const [query, setQuery] = useState("");
  const [draftIdentity, setDraftIdentity] = useState<ModelIdentity>();
  const [draftThinkingLevel, setDraftThinkingLevel] = useState<ThinkingLevel>();
  const [draftFastMode, setDraftFastMode] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const configureBackRef = useRef<HTMLButtonElement>(null);

  const catalogGroups = open ? groups() : emptyGroups;
  const antigravityModels = open ? antigravityCatalog?.antigravity?.models : undefined;
  const visibleGroups = useMemo(() => {
    if (!open || !antigravityCatalog) return catalogGroups;
    return [
      {
        id: antigravityModel.provider,
        name: "Antigravity",
        models: [defaultAntigravityOption, ...(antigravityModels?.map(antigravityOption) ?? [])],
      },
      ...catalogGroups.filter((group) => group.id !== antigravityModel.provider),
    ];
  }, [open, antigravityCatalog, antigravityModels, catalogGroups]);
  useEffect(() => {
    if (open && !preview) void antigravityCatalog?.ensureAntigravity();
  }, [open, preview, antigravityCatalog]);
  const configuration: ModelConfigurationValue | undefined =
    value ??
    (activePreset
      ? {
          provider: activePreset.provider,
          modelId: activePreset.modelId,
          thinkingLevel: activePreset.thinkingLevel,
          fastMode: activePreset.fastMode,
        }
      : undefined);
  const selectedModel = findPickerModel(visibleGroups, configuration);
  // Resolve against the live list instead of holding a model that could be removed.
  const draftModel =
    requestedView === "configure" ? findPickerModel(visibleGroups, draftIdentity) : undefined;
  const view = requestedView === "configure" && !draftModel ? "models" : requestedView;
  const draftLevels = draftModel?.availableThinkingLevels;
  const draftLevel =
    draftThinkingLevel &&
    (draftThinkingLevel === "off" || draftLevels?.includes(draftThinkingLevel))
      ? draftThinkingLevel
      : undefined;
  const draftNeedsThinkingLevel = Boolean(draftLevels?.length && !draftLevel);

  // Utility matches by settings because applying it leaves the chat without a preset identity.
  const utilityActive = Boolean(
    utilityModel &&
    !activePreset &&
    !configuration?.preset &&
    configuration?.provider === utilityModel.provider &&
    configuration.modelId === utilityModel.modelId &&
    (configuration.thinkingLevel ?? "off") === utilityModel.thinkingLevel &&
    !configuration.fastMode,
  );

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredPresets = useMemo((): PresetEntry[] => {
    if (!open || view !== "models") return [];
    const entries: PresetEntry[] = presets.map((preset) => ({
      key: preset.id,
      name: preset.name,
      provider: preset.provider,
      modelId: preset.modelId,
      thinkingLevel: preset.thinkingLevel,
      fastMode: preset.fastMode,
      active: activePreset?.id === preset.id,
      preset,
    }));
    if (utilityModel)
      entries.push({
        key: "utility",
        name: "Utility",
        provider: utilityModel.provider,
        modelId: utilityModel.modelId,
        thinkingLevel: utilityModel.thinkingLevel,
        fastMode: false,
        active: utilityActive,
      });
    return entries.filter((entry) =>
      `${entry.name} ${entry.provider} ${entry.modelId} ${entry.thinkingLevel}`
        .toLocaleLowerCase()
        .includes(normalizedQuery),
    );
  }, [open, view, presets, activePreset?.id, utilityModel, utilityActive, normalizedQuery]);

  // Runtime labels and IDs can change without changing the group reference.
  // Read them in the observer on each search render, not behind a React memo.
  const filteredGroups =
    !open || view !== "models"
      ? emptyGroups
      : !normalizedQuery
        ? visibleGroups
        : visibleGroups
            .map((group) => ({
              ...group,
              models: group.models.filter((model) =>
                `${model.name} ${pickerModelId(model)} ${group.name}`
                  .toLocaleLowerCase()
                  .includes(normalizedQuery),
              ),
            }))
            .filter((group) => group.models.length > 0);

  const activeName =
    activePreset?.name ??
    (configuration && isAntigravityModel(configuration)
      ? (antigravityCatalog?.antigravity?.models.find(
          ({ modelId }) => modelId === configuration.modelId,
        )?.name ?? antigravityModelName(configuration.modelId))
      : undefined) ??
    currentModelName ??
    selectedModel?.name ??
    (configuration?.modelId ? configuration.modelId : placeholder);
  const displayThinking = configuration?.thinkingLevel;
  const displayFast = Boolean(configuration?.fastMode);
  const hasValue = Boolean(configuration?.provider && configuration.modelId);
  const thinkingText =
    hasValue && displayThinking && displayThinking !== "off"
      ? reasoningLabel(displayThinking)
      : undefined;

  useEffect(() => {
    if (!open || preview) return;
    // The portal is initially hidden while PopoverContent positions it. Focus
    // after that layout commits, including keyboard opens directly into search.
    const frame = requestAnimationFrame(() => {
      const target =
        view === "models"
          ? searchRef.current
          : view === "configure"
            ? configureBackRef.current
            : null;
      if (target && document.activeElement !== target) target.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, preview, view]);

  const reset = () => {
    setView(hasValue ? "current" : "models");
    setQuery("");
    setDraftIdentity(undefined);
    setDraftThinkingLevel(undefined);
    setDraftFastMode(false);
  };

  const close = () => {
    setOpen(false);
    reset();
    restoreFocus?.();
  };

  const showModels = () => {
    setView("models");
    setQuery("");
  };

  const configureModel = (model: PickerModel) => {
    const { provider } = model;
    const modelId = pickerModelId(model);
    const isCurrent = configuration?.provider === provider && configuration.modelId === modelId;
    const levels = model.availableThinkingLevels;
    const supportedCurrentLevel =
      isCurrent && configuration?.thinkingLevel && levels?.includes(configuration.thinkingLevel)
        ? configuration.thinkingLevel
        : undefined;
    setDraftIdentity({ provider, modelId });
    setDraftThinkingLevel(supportedCurrentLevel ?? (levels?.length === 1 ? levels[0] : "off"));
    setDraftFastMode(Boolean(isCurrent && model.fastMode && configuration?.fastMode));
    setView("configure");
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
        else {
          onOpen?.();
          setView(hasValue ? "current" : "models");
        }
      }}
    >
      {!anchorRef && (
        <PopoverTrigger
          variant="ghost"
          size="sm"
          className={cn(
            modelChipClassName,
            "hover:bg-muted/70 hover:text-foreground transition-colors",
            className,
          )}
          data-cake-hint-key="m"
          aria-label={ariaLabel}
        >
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate font-semibold text-foreground">{activeName}</span>
            {thinkingText && (
              <span className="shrink-0 text-muted-foreground max-[520px]:hidden">
                · {thinkingText}
              </span>
            )}
            {showFastMode && displayFast && (
              <span className="shrink-0 text-muted-foreground max-[580px]:hidden">· Fast</span>
            )}
          </span>
          <div className="flex shrink-0 items-center gap-1 text-muted-foreground">
            {triggerTrailing}
            <IconSizeProvider size="inline">
              <ChevronDownIcon />
            </IconSizeProvider>
          </div>
        </PopoverTrigger>
      )}
      <PopoverContent
        anchorRef={anchorRef}
        preview={preview}
        restoreFocus={restoreFocus}
        side="top"
        align="start"
        className="w-[360px] max-w-[calc(100vw-24px)] overflow-hidden rounded-2xl border border-border bg-card p-0 shadow-2xl"
        aria-label={ariaLabel}
        data-slot="model-picker"
        onKeyDown={(event) => {
          if (
            event.key !== "Tab" ||
            event.ctrlKey ||
            event.metaKey ||
            event.altKey ||
            event.nativeEvent.isComposing ||
            event.defaultPrevented
          )
            return;
          const controls = event.currentTarget.querySelectorAll<HTMLElement>(
            'input:not(:disabled), button:not(:disabled):not([tabindex="-1"])',
          );
          const first = controls[0];
          const last = controls[controls.length - 1];
          const next = event.shiftKey
            ? event.target === first
              ? last
              : undefined
            : event.target === last
              ? first
              : undefined;
          if (next) {
            event.preventDefault();
            next.focus();
          }
        }}
      >
        <div className="p-3.5 space-y-3" key={view}>
          {view === "current" && hasValue && (
            <>
              <header className="mb-3 flex items-start justify-between gap-2">
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-sm font-semibold text-foreground">
                    {selectedModel?.name ?? currentModelName ?? configuration?.modelId}
                  </strong>
                  <small className="block truncate font-mono text-xs text-muted-foreground">
                    {configuration
                      ? modelDescription(configuration.provider, configuration.modelId)
                      : ""}
                  </small>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={showModels}
                  className="h-auto p-0 text-xs text-accent hover:underline hover:bg-transparent flex items-center gap-0.5"
                >
                  <span>Change model</span>
                  <span aria-hidden="true">›</span>
                </Button>
              </header>
              {selectedModel && (selectedModel.availableThinkingLevels?.length ?? 0) > 0 && (
                <section className="mt-3 grid gap-1.5" aria-label="Reasoning effort">
                  <span>
                    <strong className="block text-xs font-medium text-foreground">Reasoning</strong>
                    <small className="block text-xs text-muted-foreground">
                      Choose how much time this model spends thinking.
                    </small>
                  </span>
                  <SegmentedControlGroup
                    size="sm"
                    className="w-full flex"
                    aria-label="Reasoning level"
                  >
                    {selectedModel.availableThinkingLevels?.map((level) => (
                      <SegmentedControlButton
                        type="button"
                        size="sm"
                        className="flex-1"
                        active={(configuration?.thinkingLevel ?? "off") === level}
                        key={level}
                        onClick={() => {
                          close();
                          onSelect({
                            provider: configuration!.provider,
                            modelId: configuration!.modelId,
                            ...(configuration?.preset ? { preset: configuration.preset } : null),
                            thinkingLevel: level,
                            fastMode: Boolean(configuration?.fastMode),
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
                    <small className="block text-xs text-muted-foreground">
                      Use priority processing for this model.
                    </small>
                  </span>
                  <FastModeToggle
                    enabled={Boolean(configuration?.fastMode)}
                    onToggle={(enabled) => {
                      onSelect({
                        provider: configuration!.provider,
                        modelId: configuration!.modelId,
                        thinkingLevel: configuration?.thinkingLevel ?? "off",
                        fastMode: enabled,
                        ...(configuration?.preset ? { preset: configuration.preset } : null),
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
              <header className="flex items-center justify-between px-0.5">
                <strong className="text-xs font-semibold text-foreground">Choose model</strong>
                {preview && (
                  <span className="text-xs text-muted-foreground">Press Tab to search</span>
                )}
              </header>
              <div className="relative">
                <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground">
                  <SearchIcon size={13} />
                </span>
                <Input
                  ref={searchRef}
                  autoFocus
                  className="h-8 pl-8 pr-3 text-xs bg-muted/40 border-border focus:border-accent/60"
                  aria-label="Search presets and models"
                  placeholder="Search presets and models…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <div className="max-h-60 space-y-3 overflow-y-auto pr-1 text-xs">
                {filteredPresets.length > 0 && (
                  <section aria-label="Model presets" className="space-y-1">
                    <h3 className="px-2 py-1 text-xs font-medium text-muted-foreground">Presets</h3>
                    {filteredPresets.map((entry) => (
                      <NavItem
                        key={entry.key}
                        active={entry.active}
                        disabled={!antigravityCatalog && isAntigravityModel(entry)}
                        label={
                          <span className="flex items-center gap-1.5 font-semibold">
                            {entry.active && (
                              <span
                                className="size-1.5 rounded-full bg-accent"
                                aria-hidden="true"
                              />
                            )}
                            {entry.name}
                          </span>
                        }
                        description={
                          isAntigravityModel(entry)
                            ? antigravityCatalog
                              ? antigravityModelName(entry.modelId)
                              : "Desktop conversations only"
                            : modelKey(entry.provider, entry.modelId)
                        }
                        onClick={() => {
                          close();
                          const preset = entry.preset;
                          if (preset && onSelectPreset) onSelectPreset(preset);
                          else
                            onSelect({
                              provider: entry.provider,
                              modelId: entry.modelId,
                              thinkingLevel: entry.thinkingLevel,
                              fastMode: entry.fastMode,
                              ...(preset
                                ? {
                                    preset: {
                                      id: preset.id,
                                      ...(preset.promptFile === undefined
                                        ? null
                                        : { promptFile: preset.promptFile }),
                                    },
                                  }
                                : null),
                            });
                        }}
                        trailing={
                          !isAntigravityModel(entry) && (
                            <div className="flex shrink-0 items-center gap-1 font-mono text-xs">
                              <Badge variant="outline" className="text-xs font-medium">
                                {reasoningLabel(entry.thinkingLevel)}
                              </Badge>
                              {entry.fastMode && (
                                <Badge variant="accent" className="text-xs font-semibold">
                                  Fast
                                </Badge>
                              )}
                            </div>
                          )
                        }
                      />
                    ))}
                  </section>
                )}
                {filteredGroups.map((group) => (
                  <section
                    aria-label={group.name}
                    key={group.id}
                    className="space-y-1 pt-1.5 border-t border-border first:border-t-0 first:pt-0"
                  >
                    <h3 className="px-2 py-1 text-xs font-medium text-muted-foreground">
                      {group.name}
                    </h3>
                    {group.models.map((model) => {
                      const modelId = pickerModelId(model);
                      return (
                        <NavItem
                          key={modelId}
                          label={model.name}
                          description={modelDescription(group.id, modelId, modelId)}
                          onClick={() => configureModel(model)}
                          trailing={
                            <span aria-hidden="true" className="text-muted-foreground">
                              ›
                            </span>
                          }
                        />
                      );
                    })}
                  </section>
                ))}
                {filteredPresets.length === 0 && filteredGroups.length === 0 && (
                  <p className="p-3 text-center text-xs text-muted-foreground">
                    No matching models
                  </p>
                )}
              </div>
              {antigravityCatalog?.antigravityNotice && (
                <p className="px-2 py-1 text-xs text-muted-foreground" role="status">
                  {antigravityCatalog.antigravityNotice}
                </p>
              )}
              {openPresetSettings && (
                <div className="pt-2 border-t border-border">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto w-full justify-between text-xs text-accent hover:underline hover:bg-transparent px-1 py-1"
                    type="button"
                    onClick={() => {
                      close();
                      openPresetSettings();
                    }}
                  >
                    <span>Manage model presets in Settings</span>
                    <span aria-hidden="true">→</span>
                  </Button>
                </div>
              )}
              {allowClear && onClear && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-1 h-auto w-full text-center text-xs text-muted-foreground hover:underline hover:bg-transparent"
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

          {view === "configure" && draftModel && draftIdentity && (
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
                  <small className="block truncate font-mono text-xs text-muted-foreground">
                    {modelDescription(
                      draftIdentity.provider,
                      draftIdentity.modelId,
                      draftIdentity.modelId,
                    )}
                  </small>
                </span>
              </header>
              {!!draftLevels?.length && (
                <section className="mt-3 grid gap-1.5" aria-label="Reasoning level">
                  <span>
                    <strong className="block text-xs font-medium text-foreground">Reasoning</strong>
                    <small className="block text-xs text-muted-foreground">
                      Available levels are provided by this model.
                    </small>
                  </span>
                  <SegmentedControlGroup size="sm" className="w-full flex">
                    {draftLevels.map((level) => (
                      <SegmentedControlButton
                        type="button"
                        size="sm"
                        className="flex-1"
                        active={draftLevel === level}
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
                    <small className="block text-xs text-muted-foreground">
                      Use priority processing for this model.
                    </small>
                  </span>
                  <FastModeToggle enabled={draftFastMode} onToggle={setDraftFastMode} />
                </section>
              )}
              {draftNeedsThinkingLevel && (
                <Callout variant="warning" className="mt-2 p-2">
                  Choose a reasoning level to continue.
                </Callout>
              )}
              <footer className="mt-3 flex justify-end gap-2 border-t border-border pt-2.5">
                <Button variant="ghost" size="sm" onClick={close}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={draftNeedsThinkingLevel}
                  onClick={() => {
                    close();
                    onSelect({
                      ...draftIdentity,
                      thinkingLevel: draftLevel ?? "off",
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
});

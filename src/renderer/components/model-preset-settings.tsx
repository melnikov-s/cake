import { useEffect, useState, type FormEvent } from "react";
import { observer } from "r-state-tree/react";
import type { ModelPreset } from "../../contracts/conversations/session-contract";
import { modelPresetDragType } from "../lib/model-preset-drag";
import { cn } from "../lib/utils";
import { ModelPicker, reasoningLabel } from "./model-picker";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { IconButton } from "./ui/icon-button";
import { GripIcon } from "./ui/icons";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { ErrorNotice } from "./error-notice";
import type {
  ModelPresetResolutionStatus,
  ModelPresetSettingsStore,
} from "../stores/ModelPresetSettingsStore";

const emptyDraft = (): Omit<ModelPreset, "id"> => ({
  name: "",
  provider: "",
  modelId: "",
  thinkingLevel: "off",
  fastMode: false,
});

const unresolvedLabel = (status: ModelPresetResolutionStatus) => {
  if (status === "unknown") return "Model unavailable";
  if (status === "unauthenticated") return "Authentication required";
  if (status === "unavailable") return "Model unavailable";
  if (status === "unsupported-thinking-level") return "Thinking level unavailable";
  if (status === "unsupported-fast-mode") return "Fast mode unavailable";
  return undefined;
};

export const ModelPresetSettings = observer(function ModelPresetSettings({
  settings,
}: {
  settings: ModelPresetSettingsStore;
}) {
  const groups = settings.catalog.modelsByProvider;
  const [editingId, setEditingId] = useState<string | "new" | undefined>();
  const [draft, setDraft] = useState(emptyDraft);
  const [draggedId, setDraggedId] = useState<string>();
  const [dropTargetId, setDropTargetId] = useState<string>();

  useEffect(() => {
    if (!settings.sectionRequestRevision) return;
    requestAnimationFrame(() =>
      document.getElementById("model-presets-title")?.scrollIntoView({ behavior: "smooth" }),
    );
  }, [settings.sectionRequestRevision]);

  const begin = (preset?: ModelPreset) => {
    setEditingId(preset?.id ?? "new");
    setDraft(preset ? { ...preset } : emptyDraft());
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.name.trim() || !draft.provider || !draft.modelId) return;
    const value = { ...draft, name: draft.name.trim() };
    if (editingId === "new") void settings.createPreset(value);
    else if (editingId) void settings.updatePreset({ ...value, id: editingId });
    setEditingId(undefined);
  };
  const modelValue = draft.provider && draft.modelId ? `${draft.provider}/${draft.modelId}` : "";

  return (
    <section className="grid gap-1.5" aria-labelledby="model-presets-title">
      <header className="flex items-center justify-between gap-3 px-0.5">
        <h2 id="model-presets-title" className="text-xs font-semibold text-foreground">
          Model Presets
        </h2>
        <div className="flex items-center gap-1.5">
          {settings.defaultPresetId && (
            <Button
              variant="ghost"
              size="sm"
              className="rounded-sm"
              onClick={() => void settings.setDefaultPreset(undefined)}
            >
              Clear default
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            type="button"
            className="rounded-sm"
            onClick={() => begin()}
          >
            New preset
          </Button>
        </div>
      </header>
      {settings.catalog.error && (
        <ErrorNotice title="Could not load models" {...settings.catalog.error} />
      )}
      <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
        {settings.presets.length === 0 && !editingId && (
          <p className="px-3.5 py-2.5 text-xs text-muted-foreground">
            No presets yet. Create one for your preferred setup.
          </p>
        )}
        {settings.presets.map((preset) => {
          const status = settings.resolutionStatus(preset);
          const unavailable = unresolvedLabel(status);
          const isDefault = settings.defaultPresetId === preset.id;
          return (
            <article
              key={preset.id}
              data-preset-id={preset.id}
              className={cn(
                "flex items-center justify-between gap-4 px-3.5 py-2.5 transition-[opacity,background-color]",
                draggedId === preset.id && "opacity-45",
                dropTargetId === preset.id && "bg-accent/10",
              )}
              onDragEnter={(event) => {
                if (
                  event.dataTransfer.types.includes(modelPresetDragType) &&
                  draggedId !== preset.id
                )
                  setDropTargetId(preset.id);
              }}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(modelPresetDragType)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => {
                event.preventDefault();
                const sourceId = event.dataTransfer.getData(modelPresetDragType);
                if (sourceId) void settings.reorderPreset(sourceId, preset.id);
                setDraggedId(undefined);
                setDropTargetId(undefined);
              }}
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <IconButton
                  draggable
                  className="size-7 shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing"
                  tooltip={`Reorder ${preset.name}`}
                  ariaLabel={`Drag to reorder ${preset.name}`}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData(modelPresetDragType, preset.id);
                    setDraggedId(preset.id);
                  }}
                  onDragEnd={() => {
                    setDraggedId(undefined);
                    setDropTargetId(undefined);
                  }}
                >
                  <GripIcon />
                </IconButton>
                <div className="min-w-0">
                  <strong className="block truncate text-xs font-medium text-foreground">
                    {preset.name}
                  </strong>
                  <small className="block truncate font-mono text-xs text-muted-foreground">
                    {preset.provider}/{preset.modelId} · {reasoningLabel(preset.thinkingLevel)}
                    {preset.fastMode ? " · Fast" : ""}
                  </small>
                  {unavailable && (
                    <Badge variant="destructive" size="xs" className="mt-1">
                      {unavailable}
                    </Badge>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5 text-xs">
                <Button
                  variant={isDefault ? "outline" : "ghost"}
                  size="sm"
                  className="rounded-sm"
                  aria-pressed={isDefault}
                  title="Use for new conversations"
                  onClick={() => void settings.setDefaultPreset(preset.id)}
                >
                  {isDefault ? "Default" : "Set default"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-sm"
                  onClick={() => begin(preset)}
                >
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-sm"
                  onClick={() => void settings.duplicatePreset(preset.id)}
                >
                  Duplicate
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-sm"
                  onClick={() => void settings.deletePreset(preset.id)}
                >
                  Delete
                </Button>
              </div>
            </article>
          );
        })}
      </div>
      {editingId && (
        <form
          className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50"
          onSubmit={submit}
        >
          <label className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-sm">
            <span className="text-xs font-medium text-foreground">Name</span>
            <Input
              autoFocus
              className="h-8 w-64 rounded-sm text-xs"
              value={draft.name}
              maxLength={80}
              placeholder="e.g. Deep review"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <div className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-sm">
            <span className="text-xs font-medium text-foreground">Model & thinking</span>
            <ModelPicker
              ariaLabel="Preset model"
              placeholder="Choose model & thinking"
              groups={() => groups}
              currentModelName={
                groups
                  .find((group) => group.id === draft.provider)
                  ?.models.find((model) => model.id === draft.modelId)?.name
              }
              showFastMode
              value={
                draft.provider && draft.modelId
                  ? {
                      provider: draft.provider,
                      modelId: draft.modelId,
                      thinkingLevel: draft.thinkingLevel,
                      fastMode: draft.fastMode,
                    }
                  : undefined
              }
              onSelect={({ provider, modelId, thinkingLevel, fastMode }) => {
                setDraft({
                  ...draft,
                  provider,
                  modelId,
                  thinkingLevel,
                  fastMode,
                });
              }}
            />
          </div>
          <div className="grid gap-1.5 px-3.5 py-2.5">
            <label htmlFor="model-preset-prompt" className="text-xs font-medium">
              Prompt (optional; shared/project instructions take precedence)
            </label>
            <Textarea
              id="model-preset-prompt"
              value={draft.prompt ?? ""}
              onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
              rows={4}
            />
          </div>
          <div className="flex justify-end gap-2 px-3.5 py-2.5">
            <Button
              variant="ghost"
              size="sm"
              className="rounded-sm"
              onClick={() => setEditingId(undefined)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              type="submit"
              className="rounded-sm"
              disabled={!draft.name.trim() || !modelValue || settings.saving}
            >
              Save preset
            </Button>
          </div>
        </form>
      )}
    </section>
  );
});

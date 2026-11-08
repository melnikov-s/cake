import { useRef, useState } from "react";
import { observer } from "r-state-tree/react";
import type { ProjectIdentityStore } from "../stores/ProjectIdentityStore";
import { SplitButton } from "./ui/split-button";
import { RadioGroup } from "./ui/radio-group";
import { ModelPicker } from "./model-picker";
import { Button } from "./ui/button";

export const ProjectIconGenerator = observer(function ProjectIconGenerator({
  store,
  disabled,
}: {
  store: ProjectIdentityStore;
  disabled?: boolean;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [choosingModel, setChoosingModel] = useState(false);
  return (
    <div className="grid gap-2">
      <div>
        <SplitButton
          actionRef={anchor}
          menuOpen={menuOpen}
          onMenuOpenChange={setMenuOpen}
          label={store.generating ? "Generating…" : "Generate"}
          menuLabel="Icon generation model"
          disabled={disabled || store.busy || !store.valid}
          onClick={() => void store.generate()}
        >
          <p className="mb-3 text-xs text-muted-foreground">Current: {store.modelLabel}</p>
          <RadioGroup
            label="Generate with"
            value={store.model.source}
            onValueChange={(source) => {
              if (source === "utility" || source === "default") {
                store.setModel({ source });
                setMenuOpen(false);
              }
            }}
            options={[
              { value: "utility", label: "Utility model" },
              { value: "default", label: "Default model" },
            ]}
          />
          <Button
            className="mt-3"
            size="sm"
            variant="outline"
            aria-label="Choose icon generation model"
            onClick={() => {
              setMenuOpen(false);
              setChoosingModel(true);
              void store.catalog.ensureLoaded();
            }}
          >
            Choose model…
          </Button>
        </SplitButton>
      </div>
      <ModelPicker
        anchorRef={anchor}
        open={choosingModel}
        onOpenChange={setChoosingModel}
        ariaLabel="Choose icon generation model"
        groups={() =>
          store.catalog.modelsByProvider
            .map((group) => ({
              ...group,
              models: group.models.filter(
                (model) => model.authenticated && model.available !== false,
              ),
            }))
            .filter((group) => group.models.length > 0)
        }
        presets={store.preferences.presets}
        value={store.model.source === "model" ? store.model.model : undefined}
        currentModelName={store.model.source === "model" ? store.model.model.modelId : undefined}
        onSelect={(model) => store.setModel({ source: "model", model })}
        onSelectPreset={(preset) => store.setModel({ source: "preset", presetId: preset.id })}
        error={store.catalog.error?.message}
      />
      {store.previewUrl && (
        <div className="flex items-center gap-3 rounded-md border border-border/75 bg-muted/25 p-2.5">
          <img src={store.previewUrl} alt="Generated icon preview" className="size-14 rounded-md" />
          <div className="grid gap-1.5">
            <p className="text-xs text-muted-foreground">Preview · current icon unchanged</p>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => void store.acceptPreview()}
                disabled={disabled || store.busy}
              >
                {store.accepting ? "Converting…" : "Use icon"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => store.discardPreview()}
                disabled={disabled || store.busy}
              >
                Discard
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

import { observer } from "r-state-tree/react";
import { defaultHotkeyBinding } from "@/lib/hotkeys";
import type { HotkeySettingsStore } from "@/stores/HotkeySettingsStore";
import { Button } from "./ui/button";
import { HotkeyRecorder } from "./ui/hotkey-recorder";

export const SettingsHotkeysSection = observer(function SettingsHotkeysSection({
  hotkeys,
}: {
  hotkeys: HotkeySettingsStore;
}) {
  const groups = ["Editor & tools", "Panes", "Navigation", "Conversation"] as const;
  return (
    <section className="grid gap-4" aria-labelledby="hotkeys-title">
      <header className="flex items-center justify-between gap-3 px-0.5">
        <div>
          <h2 id="hotkeys-title" className="text-xs font-semibold text-foreground">
            Keyboard shortcuts
          </h2>
          <p className="text-xs text-muted-foreground">
            Select a shortcut and press a new key combination, or Backspace to clear.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="rounded-sm"
          onClick={() => hotkeys.resetAll()}
        >
          Reset all
        </Button>
      </header>
      <div className="grid gap-4">
        {groups.map((group) => (
          <div key={group} className="grid gap-1.5">
            <h3 className="px-0.5 text-xs font-semibold text-foreground">{group}</h3>
            <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
              {hotkeys.definitions
                .filter((definition) => definition.group === group)
                .map((definition) => (
                  <div
                    id={`setting-hotkey-${definition.id}`}
                    key={definition.id}
                    className="scroll-mt-8 flex items-center justify-between gap-4 px-3.5 py-2.5"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <strong className="text-xs font-medium text-foreground">
                        {definition.label}
                      </strong>
                      <small className="text-xs text-muted-foreground">
                        {definition.description}
                      </small>
                    </span>
                    <HotkeyRecorder
                      label={definition.label}
                      value={hotkeys.bindingFor(definition.id)}
                      defaultValue={defaultHotkeyBinding(definition.id)}
                      onChange={(binding) => hotkeys.assign(definition.id, binding)}
                      onClear={() => hotkeys.clear(definition.id)}
                      onReset={() => hotkeys.reset(definition.id)}
                    />
                  </div>
                ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
});

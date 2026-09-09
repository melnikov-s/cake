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
    <div className="grid gap-8">
      <section className="border-t border-border py-5" aria-labelledby="hotkeys-title">
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 id="hotkeys-title" className="text-[15px] font-semibold text-foreground">
              Keyboard shortcuts
            </h2>
            <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">
              Select a shortcut, then press a new key combination. Backspace clears it. Assigning an
              existing combination moves it to the selected action.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => hotkeys.resetAll()}>
            Reset all
          </Button>
        </header>
        <div className="grid gap-7">
          {groups.map((group) => (
            <div key={group}>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {group}
              </h3>
              <div className="divide-y divide-border/65 rounded-xl border border-border bg-card/35 px-4">
                {hotkeys.definitions
                  .filter((definition) => definition.group === group)
                  .map((definition) => (
                    <div
                      id={`setting-hotkey-${definition.id}`}
                      key={definition.id}
                      className="scroll-mt-8 flex min-h-16 items-center justify-between gap-6 py-3"
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <strong className="text-xs font-medium text-foreground">
                          {definition.label}
                        </strong>
                        <small className="text-[11px] text-muted-foreground">
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
    </div>
  );
});

import { observer } from "r-state-tree/react";
import type { SettingsStore } from "../stores/SettingsStore";
import { Select } from "./ui/select";
import { SettingsPromptField } from "./settings/settings-prompt-field";
import { SettingsModelChoiceField } from "./settings-model-choice-field";

export const SettingsCakeChatSection = observer(function SettingsCakeChatSection({
  settings,
}: {
  settings: SettingsStore;
}) {
  const store = settings.cakeChat;
  return (
    <section className="border-t border-border py-5" aria-labelledby="cake-chat-settings-title">
      <h2 id="cake-chat-settings-title" className="text-[15px] font-semibold text-foreground">
        Cake Chat
      </h2>
      <p className="mt-1 mb-5 text-xs text-muted-foreground">
        One permanent assistant across your projects. Task sessions do the heavy work; its history
        is summarized in the background.
      </p>
      <div className="grid gap-5">
        <label className="flex items-center justify-between gap-6 text-sm">
          <span className="flex flex-col gap-1">
            <strong className="text-xs font-medium">History-view budget</strong>
            <small className="text-[11px] text-muted-foreground">
              Smaller views cost less but need more zooming. Default: 40 KB, roughly 10k tokens for
              English summaries; counts vary by model. Originals are retained.
            </small>
          </span>
          <Select
            aria-label="Cake Chat history-view budget"
            value={String(store.preferences.memoryViewBytes)}
            onChange={(event) => void store.setBudget(Number(event.target.value))}
          >
            {[5_000, 10_000, 20_000, 40_000, 80_000, 128_000].map((bytes) => (
              <option key={bytes} value={bytes}>
                {bytes / 1_000} KB{bytes === 40_000 ? " (default)" : ""}
              </option>
            ))}
          </Select>
        </label>
        <SettingsModelChoiceField
          settings={settings}
          setting="summarizationModel"
          label="Summarization model"
          description="Summarizes Cake Chat history in the background; summaries add cost. The utility model is the default. Inherit uses the chat's current model."
        />
        <SettingsModelChoiceField
          settings={settings}
          setting="subagentDefaultModel"
          label="Subagent default model"
          description="Used when Cake Chat starts a subagent without choosing a model. Inherit uses the chat's current model, thinking level, and Fast mode. Project Session subagents and new sessions use the default preset."
        />
        <SettingsPromptField
          id="setting-cake-chat-instructions"
          label="Cake Chat instructions"
          description="Always included, never summarized. For example: always create a worktree for coding sessions. Saved when you leave the field."
          value={store.preferences.instructions}
          defaultValue=""
          onApply={(value) => void store.setInstructions(value)}
        />
      </div>
    </section>
  );
});

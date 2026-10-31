import { observer } from "r-state-tree/react";
import type { SettingsStore } from "../stores/SettingsStore";
import { Select } from "./ui/select";
import { SettingsPromptField } from "./settings/settings-prompt-field";
import {
  CAKE_CHAT_CONTEXT_LIMIT_CHOICES,
  CAKE_CHAT_MEMORY_VIEW_CHOICES,
} from "../../contracts/cake-chats/cake-chat-preferences";

export const SettingsCompanionSection = observer(function SettingsCompanionSection({
  settings,
}: {
  settings: SettingsStore;
}) {
  const store = settings.companion;
  return (
    <section className="grid gap-1.5" aria-label="Companion settings">
      <h2 className="px-0.5 text-xs font-semibold text-foreground">Companion</h2>
      <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
        <label className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-xs">
          Active context limit
          <Select
            aria-label="Companion active context limit"
            value={String(store.preferences.contextLimitTokens ?? 32_000)}
            onChange={(event) => void store.setContextLimit(Number(event.target.value))}
          >
            {CAKE_CHAT_CONTEXT_LIMIT_CHOICES.map((tokens) => (
              <option key={tokens} value={tokens}>
                {tokens.toLocaleString()} tokens
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-xs">
          History-view budget
          <Select
            aria-label="Companion history-view budget"
            value={String(store.preferences.memoryViewBytes)}
            onChange={(event) => void store.setBudget(Number(event.target.value))}
          >
            {CAKE_CHAT_MEMORY_VIEW_CHOICES.map((bytes) => (
              <option key={bytes} value={bytes}>
                {bytes / 1_000} KB
              </option>
            ))}
          </Select>
        </label>
        <SettingsPromptField
          id="setting-companion-instructions"
          label="Companion instructions"
          description=""
          value={store.preferences.instructions}
          defaultValue=""
          onApply={(value) => void store.setInstructions(value)}
        />
      </div>
    </section>
  );
});

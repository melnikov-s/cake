import { observer } from "r-state-tree/react";
import type { SettingsStore } from "../stores/SettingsStore";
import { Select } from "./ui/select";
import { SettingsPromptField } from "./settings/settings-prompt-field";
import { SettingsModelChoiceField } from "./settings-model-choice-field";
import {
  CAKE_CHAT_CONTEXT_LIMIT_CHOICES,
  CAKE_CHAT_MEMORY_VIEW_CHOICES,
  DEFAULT_CAKE_CHAT_CONTEXT_LIMIT_TOKENS,
  defaultCakeChatPreferences,
} from "../../contracts/cake-chats/cake-chat-preferences";

const defaultMemoryViewBytes = defaultCakeChatPreferences().memoryViewBytes;

export const SettingsCakeChatSection = observer(function SettingsCakeChatSection({
  settings,
}: {
  settings: SettingsStore;
}) {
  const store = settings.cakeChat;
  return (
    <section className="grid gap-1.5" aria-labelledby="cake-chat-settings-title">
      <h2 id="cake-chat-settings-title" className="px-0.5 text-xs font-semibold text-foreground">
        Cake Chat
      </h2>
      <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
        <label className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-sm">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <strong className="text-xs font-medium text-foreground">Active context limit</strong>
            <small className="text-xs text-muted-foreground">
              Summarize at this token limit or the model window, whichever is smaller. Otherwise
              retain context while cache is likely warm; uncertain or expired cache rebuilds memory
              on the next input.
            </small>
          </span>
          <Select
            aria-label="Cake Chat active context limit"
            className="h-8 w-44 rounded-sm text-xs"
            value={String(
              store.preferences.contextLimitTokens ?? DEFAULT_CAKE_CHAT_CONTEXT_LIMIT_TOKENS,
            )}
            onChange={(event) => void store.setContextLimit(Number(event.target.value))}
          >
            {CAKE_CHAT_CONTEXT_LIMIT_CHOICES.map((tokens) => (
              <option key={tokens} value={tokens}>
                {tokens.toLocaleString()} tokens
                {tokens === DEFAULT_CAKE_CHAT_CONTEXT_LIMIT_TOKENS ? " (default)" : ""}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-sm">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <strong className="text-xs font-medium text-foreground">History-view budget</strong>
            <small className="text-xs text-muted-foreground">
              OptMem history grows to this size, then consolidates toward half (40/20 KB by
              default). Model-window admission may lower it. Originals are retained.
            </small>
          </span>
          <Select
            aria-label="Cake Chat history-view budget"
            className="h-8 w-44 rounded-sm text-xs"
            value={String(store.preferences.memoryViewBytes)}
            onChange={(event) => void store.setBudget(Number(event.target.value))}
          >
            {CAKE_CHAT_MEMORY_VIEW_CHOICES.map((bytes) => (
              <option key={bytes} value={bytes}>
                {bytes / 1_000} KB{bytes === defaultMemoryViewBytes ? " (default)" : ""}
              </option>
            ))}
          </Select>
        </label>
        <SettingsModelChoiceField
          settings={settings}
          setting="summarizationModel"
          label="Summarization model"
          description="Summarizes history when cache expires, is uncertain, or the active context limit is reached."
        />
        <SettingsModelChoiceField
          settings={settings}
          setting="subagentDefaultModel"
          label="Subagent default model"
          description="Used when Cake Chat starts a subagent without choosing a model."
        />
        <SettingsPromptField
          id="setting-cake-chat-instructions"
          label="Cake Chat instructions"
          description="Shared by global Cake Chat and every permanent Project Chat, not coding Project Sessions. For one project only, use that project’s settings → Project Chat instructions. Always included, never summarized. Saved when you leave the field."
          value={store.preferences.instructions}
          defaultValue=""
          onApply={(value) => void store.setInstructions(value)}
        />
      </div>
    </section>
  );
});

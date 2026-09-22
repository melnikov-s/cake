import { observer } from "r-state-tree/react";
import type { SessionPlugin } from "../../domain/application/application-data";
import type { JsonObject, JsonValue } from "../../ipc/json-contract";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import type { SessionPluginStore } from "../stores/SessionPluginStore";
import { GeneratedSessionPlugin } from "./generated-session-plugin";
import { ActionBar } from "./ui/action-bar";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";

/** Host controls remain outside generated code and available even after a load failure. */
export const SessionPluginContribution = observer(function SessionPluginContribution({
  plugin,
  plugins,
  sharedState,
  inlineWidgets,
  call,
}: {
  readonly plugin: SessionPlugin;
  readonly plugins: SessionPluginStore;
  readonly sharedState: Readonly<Record<string, JsonValue>>;
  readonly inlineWidgets: InlineWidgetStore;
  readonly call: (command: string, input: JsonObject) => Promise<JsonValue>;
}) {
  const key = plugins.statusKey(plugin.sessionId, plugin.id);
  const error = plugins.errors.get(key);
  return (
    <section
      aria-label={plugin.title}
      className="min-w-0 rounded-md border border-border bg-card text-card-foreground"
    >
      <div className="flex items-center justify-between gap-2 px-3 py-1">
        <span className="truncate text-xs text-muted-foreground">
          {plugin.title}
          {plugin.hidden
            ? " · Hidden"
            : "preset" in plugin
              ? " · Sends messages to this chat"
              : " · Session controls"}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={plugins.pendingVisibility.has(key)}
          aria-label={`${plugin.hidden ? "Show" : "Hide"} ${plugin.title}`}
          aria-expanded={!plugin.hidden}
          onClick={() => void plugins.setHidden(plugin.sessionId, plugin.id, !plugin.hidden)}
        >
          {plugin.hidden ? "Show" : "Hide"}
        </Button>
      </div>
      {error && (
        <Callout variant="error" title="Plugin action failed">
          {error}
        </Callout>
      )}
      {!plugin.hidden &&
        ("preset" in plugin ? (
          <ActionBar
            {...plugin.state}
            busy={plugins.pendingActions.has(key)}
            onAction={(id) => void plugins.sendAction(plugin.sessionId, plugin.id, id, call)}
          />
        ) : (
          <GeneratedSessionPlugin
            plugin={plugin}
            sharedState={sharedState}
            inlineWidgets={inlineWidgets}
            call={call}
          />
        ))}
    </section>
  );
});

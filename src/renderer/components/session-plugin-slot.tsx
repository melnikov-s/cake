import { observer } from "r-state-tree/react";
import type { JsonObject, JsonValue } from "../../ipc/json-contract";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import type { SessionPluginStore } from "../stores/SessionPluginStore";
import { SessionPluginContribution } from "./session-plugin-contribution";

export const SessionPluginSlot = observer(function SessionPluginSlot({
  sessionId,
  slot,
  plugins,
  inlineWidgets,
  call,
}: {
  readonly sessionId: string;
  readonly slot: "composer.above";
  readonly plugins: SessionPluginStore;
  readonly inlineWidgets: InlineWidgetStore;
  readonly call: (pluginId: string, command: string, input: JsonObject) => Promise<JsonValue>;
}) {
  const contributions = plugins.forSession(sessionId).filter((plugin) => plugin.slot === slot);
  if (contributions.length === 0) return null;
  const sharedState = plugins.shared(sessionId);
  return (
    <section
      className="grid gap-1 px-1 pb-2"
      aria-label="Session plugin controls"
      data-session-plugin-slot={slot}
    >
      {contributions.map((plugin) => (
        <SessionPluginContribution
          key={plugin.id}
          plugin={plugin}
          plugins={plugins}
          sharedState={sharedState}
          inlineWidgets={inlineWidgets}
          call={(command, input) => call(plugin.id, command, input)}
        />
      ))}
    </section>
  );
});

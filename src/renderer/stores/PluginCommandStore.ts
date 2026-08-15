import { Store, observable } from "r-state-tree";
import type { SessionSnapshot } from "../../ipc/session-contract";
import { dispatchPluginCommand, pluginCommandSnapshot, resolvePluginCommand, subscribePluginCommands } from "../plugin-runtime";

type SlashCommand = SessionSnapshot["commands"][number];

/** Owns the renderer-plugin command registry and invocation lifecycle. */
export class PluginCommandStore extends Store<Record<string, never>> {
  commands: SlashCommand[] = observable([]);
  constructor(props: PluginCommandStore["props"]) {
    super(props);
    const refresh = () => this.commands.splice(0, this.commands.length, ...pluginCommandSnapshot());
    refresh(); this.effect(() => subscribePluginCommands(refresh));
  }
  matches(input: string) { return Boolean(resolvePluginCommand(input)); }
  run(input: string) { return dispatchPluginCommand(input); }
}

/** Version-matched public surface available to trusted user plugins. */
import type { ComponentType } from "react";
import type { JsonValue } from "../ipc/json-contract";
import { registerPluginDefinition } from "./plugin-runtime";

export { observer, useOptionalStore, useStore } from "r-state-tree/react";
export { Button, type ButtonProps } from "./components/ui/button";
export { cn } from "./lib/utils";
export { RootStore } from "./stores/RootStore";

export interface CakeCommandContext {
  signal: AbortSignal;
  reveal(contributionId: string, input?: JsonValue): void;
}

export interface CakePluginCommand {
  description: string;
  argumentHint?: string;
  run(args: string, context: CakeCommandContext): void | Promise<void>;
}

export interface CakePluginDefinition {
  id: string;
  contributions: Record<string, ComponentType>;
  commands?: Record<string, CakePluginCommand>;
}

export function definePlugin<const Plugin extends CakePluginDefinition>(plugin: Plugin): Plugin {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(plugin.id)) {
    throw new Error(`Cake plugin IDs must be stable, namespaced lowercase identifiers; received ${JSON.stringify(plugin.id)}`);
  }
  registerPluginDefinition(plugin);
  return plugin;
}

export { useCommand, useContributionReveal } from "./plugin-runtime";
export { usePluginGlobalState, usePluginSessionState, type SerializablePluginValue } from "./plugin-persistence";

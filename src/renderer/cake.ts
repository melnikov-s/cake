/** Version-matched public surface available to trusted user plugins. */
import type { ComponentType } from "react";
import type { JsonValue } from "../ipc/json-contract";
import { cakeSlotNames, type CakeSlotName } from "../plugin/slot-contract";
import { registerPluginDefinition } from "./plugin-runtime";

export { observer, useOptionalStore, useStore } from "r-state-tree/react";
export { Button, type ButtonProps } from "./components/ui/button";
export { LoadingState, type LoadingStateVariant } from "./components/ui/loading-state";
export {
  Popover,
  PopoverContent,
  PopoverTrigger,
  type PopoverContentProps,
  type PopoverProps,
} from "./components/ui/popover";
export { cn } from "./lib/utils";
export { RootStore } from "./stores/RootStore";
export { App as DefaultScene } from "./app";

export { cakeSlotNames, type CakeSlotName };

export interface CakeSlotContribution {
  id: string;
  component: ComponentType;
  order?: number;
}

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
  slots?: Partial<Record<CakeSlotName, CakeSlotContribution[]>>;
  commands?: Record<string, CakePluginCommand>;
}

export function definePlugin<const Plugin extends CakePluginDefinition>(plugin: Plugin): Plugin {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(plugin.id)) {
    throw new Error(
      `Cake plugin IDs must be stable, namespaced lowercase identifiers; received ${JSON.stringify(plugin.id)}`,
    );
  }
  registerPluginDefinition(plugin);
  return plugin;
}

export { Slot, useCommand, useContributionReveal } from "./plugin-runtime";
export { usePluginBackend } from "./plugin-backend";
export {
  usePluginGlobalState,
  usePluginSessionState,
  type SerializablePluginValue,
} from "./plugin-persistence";
export { usePluginSession, type CakePluginSession } from "./plugin-session";
export {
  usePluginAgent,
  usePluginCompletion,
  usePluginSessionActivity,
  type PluginAgentHandle,
  type PluginCompletionHandle,
} from "./plugin-agent";
export type {
  AgentModelPreference,
  AgentSessionTarget,
  PluginAgentOpenOptions,
  PluginCompletionRequest,
  PluginCompletionResult,
  PluginSessionActivity,
  ResolvedAgentModel,
  SessionContextSelection,
  SessionRef,
  WorkspaceRef,
} from "../ipc/plugin-agent-contract";

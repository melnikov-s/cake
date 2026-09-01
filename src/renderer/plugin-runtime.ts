import { Option, Schema } from "effect";
import {
  Component,
  Fragment,
  createContext,
  createElement,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { cakeSlotNames, type CakeSlotName } from "../plugin/slot-contract";
import type { CakeCommandContext, CakePluginCommand, CakePluginDefinition } from "./cake";
import type { JsonValue } from "../ipc/json-contract";

interface RegisteredCommand extends CakePluginCommand {
  pluginId: string;
  name: string;
  token: symbol;
}
const commands = new Map<string, RegisteredCommand>();
const listeners = new Set<() => void>();
const running = new Set<AbortController>();
const definitions = new Map<string, CakePluginDefinition>();
const mountedSlots = new Map<CakeSlotName, number>();
let revision = 0;
const identity = (pluginId: string, name: string) => `${pluginId}.${name}`;
const PluginIdentityContext = createContext<string | undefined>(undefined);
const emit = () => {
  revision += 1;
  for (const listener of listeners) listener();
};

function add(pluginId: string, name: string, command: CakePluginCommand, token: symbol) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name))
    throw new Error(`Invalid command name ${JSON.stringify(name)} in ${pluginId}`);
  commands.set(identity(pluginId, name), { ...command, pluginId, name, token });
  emit();
}

export function registerPluginDefinition(plugin: CakePluginDefinition) {
  const previous = definitions.get(plugin.id);
  if (previous)
    for (const name of Object.keys(previous.commands ?? {}))
      commands.delete(identity(plugin.id, name));
  definitions.set(plugin.id, plugin);
  const token = Symbol(plugin.id);
  for (const [name, command] of Object.entries(plugin.commands ?? {}))
    add(plugin.id, name, command, token);
  emit();
}

interface SlotBoundaryProps {
  pluginId: string;
  contributionId: string;
  children?: ReactNode;
}
interface SlotBoundaryState {
  error?: Error;
}

class SlotBoundary extends Component<SlotBoundaryProps, SlotBoundaryState> {
  state: SlotBoundaryState = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      `Cake plugin slot ${this.props.pluginId}/${this.props.contributionId} failed`,
      error,
      info,
    );
  }
  render() {
    if (this.state.error)
      return createElement(
        "span",
        { className: "plugin-slot-error", role: "status", title: this.state.error.message },
        `${this.props.pluginId} failed`,
      );
    return createElement(
      PluginIdentityContext.Provider,
      { value: this.props.pluginId },
      this.props.children,
    );
  }
}

export function useCurrentPluginId() {
  const pluginId =
    useContext(PluginIdentityContext) ??
    (typeof __CAKE_ACTIVE_SCENE_PLUGIN_ID__ === "string"
      ? __CAKE_ACTIVE_SCENE_PLUGIN_ID__
      : undefined);
  if (!pluginId) throw new Error("Plugin capability hooks require a mounted plugin contribution");
  return pluginId;
}

function slotSnapshot(name: CakeSlotName) {
  return [...definitions.values()]
    .flatMap((plugin) =>
      (plugin.slots?.[name] ?? []).map((contribution) => ({
        ...contribution,
        pluginId: plugin.id,
        key: `${plugin.id}:${contribution.id}`,
      })),
    )
    .sort(
      (left, right) =>
        (left.order ?? 0) - (right.order ?? 0) ||
        left.pluginId.localeCompare(right.pluginId) ||
        left.id.localeCompare(right.id),
    );
}

export function Slot({ name }: { name: CakeSlotName }) {
  useSyncExternalStore(
    subscribePluginRuntime,
    () => revision,
    () => revision,
  );
  useEffect(() => {
    mountedSlots.set(name, (mountedSlots.get(name) ?? 0) + 1);
    emit();
    return () => {
      const next = (mountedSlots.get(name) ?? 1) - 1;
      if (next === 0) mountedSlots.delete(name);
      else mountedSlots.set(name, next);
      emit();
    };
  }, [name]);
  return createElement(
    Fragment,
    null,
    ...slotSnapshot(name).map((item) =>
      createElement(
        SlotBoundary,
        { key: item.key, pluginId: item.pluginId, contributionId: item.id },
        createElement(item.component),
      ),
    ),
  );
}

export function useCommand(pluginId: string, name: string, command: CakePluginCommand) {
  useEffect(() => {
    const token = Symbol(`${pluginId}.${name}`);
    add(pluginId, name, command, token);
    return () => {
      const key = identity(pluginId, name);
      if (commands.get(key)?.token === token) {
        commands.delete(key);
        emit();
      }
    };
  }, [pluginId, name, command]);
}

export function useContributionReveal(
  contributionId: string,
  reveal: (input: JsonValue | undefined) => void,
) {
  useEffect(() => {
    const detailSchema = Schema.Struct({
      contributionId: Schema.String,
      input: Schema.optionalKey(Schema.Json),
    });
    const listener = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = Schema.decodeUnknownOption(detailSchema)(event.detail);
      if (Option.isSome(detail) && detail.value.contributionId === contributionId)
        reveal(detail.value.input);
    };
    window.addEventListener("cake:reveal-contribution", listener);
    return () => window.removeEventListener("cake:reveal-contribution", listener);
  }, [contributionId, reveal]);
}

export function subscribePluginCommands(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function subscribePluginRuntime(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useHasSlotContributions(names: readonly CakeSlotName[]) {
  useSyncExternalStore(
    subscribePluginRuntime,
    () => revision,
    () => revision,
  );
  return names.some((name) => slotSnapshot(name).length > 0);
}

export function usePluginSlotDiagnostics() {
  useSyncExternalStore(
    subscribePluginRuntime,
    () => revision,
    () => revision,
  );
  const contributed = new Set<CakeSlotName>();
  for (const plugin of definitions.values()) {
    for (const name of cakeSlotNames) if (plugin.slots?.[name]?.length) contributed.add(name);
  }
  return [...contributed].sort().flatMap((name) => {
    const outletCount = mountedSlots.get(name) ?? 0;
    if (outletCount === 1) return [];
    return [{ name, outletCount }];
  });
}

export function pluginCommandSnapshot() {
  const counts = new Map<string, number>();
  for (const command of commands.values())
    counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
  return [...commands.values()]
    .sort((a, b) => identity(a.pluginId, a.name).localeCompare(identity(b.pluginId, b.name)))
    .map((command) => ({
      name:
        counts.get(command.name) === 1 ? command.name : identity(command.pluginId, command.name),
      description: command.description,
      argumentHint: command.argumentHint,
      source: "plugin" as const,
      sourceInfo: {
        path: `plugin:${command.pluginId}`,
        source: command.pluginId,
        scope: "user" as const,
        origin: "top-level" as const,
      },
    }));
}

export function resolvePluginCommand(input: string) {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!match) return undefined;
  const requested = match[1]!;
  const qualified = commands.get(requested);
  if (qualified) return { command: qualified, args: match[2] ?? "" };
  const aliases = [...commands.values()].filter((command) => command.name === requested);
  return aliases.length === 1 ? { command: aliases[0]!, args: match[2] ?? "" } : undefined;
}

export async function dispatchPluginCommand(input: string) {
  const resolved = resolvePluginCommand(input);
  if (!resolved) return false;
  const controller = new AbortController();
  running.add(controller);
  const context: CakeCommandContext = {
    signal: controller.signal,
    reveal(contributionId, value) {
      window.dispatchEvent(
        new CustomEvent("cake:reveal-contribution", { detail: { contributionId, input: value } }),
      );
    },
  };
  try {
    await resolved.command.run(resolved.args, context);
  } finally {
    running.delete(controller);
  }
  return true;
}

if (typeof window !== "undefined") {
  window.addEventListener(
    "pagehide",
    () => {
      for (const controller of running) controller.abort();
      running.clear();
    },
    { once: true },
  );
}

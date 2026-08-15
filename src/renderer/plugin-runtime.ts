import { useEffect } from "react";
import type { CakeCommandContext, CakePluginCommand, CakePluginDefinition } from "./cake";

interface RegisteredCommand extends CakePluginCommand { pluginId: string; name: string; token: symbol; }
const commands = new Map<string, RegisteredCommand>();
const listeners = new Set<() => void>();
const running = new Set<AbortController>();
const identity = (pluginId: string, name: string) => `${pluginId}.${name}`;
const emit = () => { for (const listener of listeners) listener(); };

function add(pluginId: string, name: string, command: CakePluginCommand, token: symbol) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Invalid command name ${JSON.stringify(name)} in ${pluginId}`);
  commands.set(identity(pluginId, name), { ...command, pluginId, name, token });
  emit();
}

export function registerPluginDefinition(plugin: CakePluginDefinition) {
  const token = Symbol(plugin.id);
  for (const [name, command] of Object.entries(plugin.commands ?? {})) add(plugin.id, name, command, token);
}

export function useCommand(pluginId: string, name: string, command: CakePluginCommand) {
  useEffect(() => {
    const token = Symbol(`${pluginId}.${name}`); add(pluginId, name, command, token);
    return () => { const key = identity(pluginId, name); if (commands.get(key)?.token === token) { commands.delete(key); emit(); } };
  }, [pluginId, name, command]);
}

export function useContributionReveal(contributionId: string, reveal: (input: unknown) => void) {
  useEffect(() => {
    const listener = (event: Event) => { const detail = (event as CustomEvent<{ contributionId: string; input?: unknown }>).detail; if (detail.contributionId === contributionId) reveal(detail.input); };
    window.addEventListener("cake:reveal-contribution", listener);
    return () => window.removeEventListener("cake:reveal-contribution", listener);
  }, [contributionId, reveal]);
}

export function subscribePluginCommands(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); }

export function pluginCommandSnapshot() {
  const counts = new Map<string, number>();
  for (const command of commands.values()) counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
  return [...commands.values()].sort((a, b) => identity(a.pluginId, a.name).localeCompare(identity(b.pluginId, b.name))).map((command) => ({
    name: counts.get(command.name) === 1 ? command.name : identity(command.pluginId, command.name), description: command.description,
    argumentHint: command.argumentHint, source: "plugin" as const,
    sourceInfo: { path: `plugin:${command.pluginId}`, source: command.pluginId, scope: "user" as const, origin: "top-level" as const }
  }));
}

export function resolvePluginCommand(input: string) {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(input.trim()); if (!match) return undefined;
  const requested = match[1]!; const qualified = commands.get(requested);
  if (qualified) return { command: qualified, args: match[2] ?? "" };
  const aliases = [...commands.values()].filter((command) => command.name === requested);
  return aliases.length === 1 ? { command: aliases[0]!, args: match[2] ?? "" } : undefined;
}

export async function dispatchPluginCommand(input: string) {
  const resolved = resolvePluginCommand(input); if (!resolved) return false;
  const controller = new AbortController(); running.add(controller);
  const context: CakeCommandContext = { signal: controller.signal, reveal(contributionId, value) { window.dispatchEvent(new CustomEvent("cake:reveal-contribution", { detail: { contributionId, input: value } })); } };
  try { await resolved.command.run(resolved.args, context); } finally { running.delete(controller); }
  return true;
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => { for (const controller of running) controller.abort(); running.clear(); }, { once: true });
}

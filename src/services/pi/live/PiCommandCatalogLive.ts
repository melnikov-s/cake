import type { Extension, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { Effect, Layer } from "effect";
import { piBuiltinSlashCommands, type SessionSnapshot } from "../../../ipc/session-contract";
import { makePiCommandCatalog, PiCommandCatalog } from "../PiCommandCatalog";
import type { PiAgentResourceContext } from "../agent-resource-data";
import { loadPiResources } from "./PiResourceLoader";

function resolveExtensionCommands(extensions: readonly Extension[]): RegisteredCommand[] {
  const commands = extensions.flatMap((extension) => [...extension.commands.values()]);
  const counts = new Map<string, number>();
  for (const command of commands) counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  const takenNames = new Set<string>();
  return commands.map((command) => {
    const occurrence = (seen.get(command.name) ?? 0) + 1;
    seen.set(command.name, occurrence);
    let invocationName =
      (counts.get(command.name) ?? 0) > 1 ? `${command.name}:${occurrence}` : command.name;
    let suffix = occurrence;
    while (takenNames.has(invocationName)) invocationName = `${command.name}:${++suffix}`;
    takenNames.add(invocationName);
    return { ...command, name: invocationName };
  });
}

export async function discoverPiCommands(
  agentDirectory: string,
  context: PiAgentResourceContext,
  signal?: AbortSignal,
): Promise<SessionSnapshot["commands"]> {
  const { resourceLoader } = await loadPiResources(agentDirectory, context, signal);
  const extensionCommands = resolveExtensionCommands(resourceLoader.getExtensions().extensions).map(
    (command) => ({
      name: command.name,
      description: command.description,
      source: "extension" as const,
      sourceInfo: command.sourceInfo,
    }),
  );
  const promptCommands = resourceLoader.getPrompts().prompts.map((prompt) => ({
    name: prompt.name,
    description: prompt.description,
    argumentHint: prompt.argumentHint,
    source: "prompt" as const,
    sourceInfo: prompt.sourceInfo,
  }));
  const skillCommands = resourceLoader.getSkills().skills.map((skill) => ({
    name: `skill:${skill.name}`,
    description: skill.description,
    source: "skill" as const,
    sourceInfo: skill.sourceInfo,
  }));
  return [...piBuiltinSlashCommands, ...extensionCommands, ...promptCommands, ...skillCommands];
}

export const makePiCommandCatalogLive = (agentDirectory: string) =>
  Layer.succeed(PiCommandCatalog)(
    makePiCommandCatalog({
      load: Effect.fn("PiCommandCatalogLive.load")((context) =>
        Effect.tryPromise({
          try: (signal) => discoverPiCommands(agentDirectory, context, signal),
          catch: (cause) => cause,
        }),
      ),
    }),
  );

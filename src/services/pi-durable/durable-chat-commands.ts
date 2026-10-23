import { splitProjectTodoReminder } from "../../contracts/projects/project-todo-context";
import {
  DefaultResourceLoader,
  formatSkillsForPrompt,
  stripFrontmatter,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { Option, Schema } from "effect";
import {
  cakeChatBuiltinSlashCommands,
  slashCommandSchema,
} from "../../contracts/conversations/session-contract";
import { compatibilityCatalog } from "../pi/live/PiCompatibilityProjection";
import { cakeBuiltinSkillsOverride } from "../pi/runtime/cake-builtin-skills";
import {
  addSessionDigestReminder,
  splitSessionDigestReminder,
} from "../../contracts/cake-chats/session-digest-reminder";

/** Durable has no AgentSession command processor. Advertise supported conversation
 * commands plus Pi-discovered text skills, not Project Session extensions or prompts. */
export async function createDurableChatCommands(
  cwd: string,
  agentDir: string,
  settingsManager: SettingsManager,
) {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    skillsOverride: await cakeBuiltinSkillsOverride(agentDir),
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  return {
    reload: () => loader.reload(),
    instructions: () => formatSkillsForPrompt(loader.getSkills().skills),
    compatibility: () => compatibilityCatalog(loader, settingsManager, cwd, agentDir),
    catalog: () => [
      ...cakeChatBuiltinSlashCommands,
      ...loader.getSkills().skills.flatMap((skill) => {
        const command = Schema.decodeUnknownOption(slashCommandSchema)({
          name: `skill:${skill.name}`,
          description: skill.description,
          source: "skill",
          sourceInfo: skill.sourceInfo,
        });
        return Option.isSome(command) ? [command.value] : [];
      }),
    ],
    async expand(text: string) {
      const input = splitSessionDigestReminder(text);
      const todos = splitProjectTodoReminder(input.text);
      const match = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/.exec(todos.text);
      if (!match) return text;
      const skill = loader.getSkills().skills.find((entry) => entry.name === match[1]);
      if (!skill) throw new Error(`Unknown skill: ${match[1]}`);
      // Match Pi AgentSession's skill envelope, which the shared transcript
      // projection already understands. Read at invocation, not from a cached body.
      const body = stripFrontmatter(await readFile(skill.filePath, "utf8")).trim();
      const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
      const args = match[2]?.trim();
      const expanded = args ? `${block}\n\n${args}` : block;
      return addSessionDigestReminder(
        todos.reminder ? `${todos.reminder}\n\n${expanded}` : expanded,
        input.reminder,
      );
    },
  };
}

import { Type, type TSchema } from "@earendil-works/pi-durable-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { SideSessionDoc } from "./durable-side-session";
import {
  createBashTool,
  createReadTool,
  createEditTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";

/**
 * Quick local tools for permanent chats. Global Chat additionally offers native edit/write
 * for explicitly authorized non-project tasks. Project Chat and investigation forks do not.
 * Bash is not a filesystem sandbox; task/target authorization remains instruction policy.
 */
export const CAKE_CHAT_BASH_DEFAULT_TIMEOUT_SECONDS = 30;
export const CAKE_CHAT_BASH_MAX_TIMEOUT_SECONDS = 120;
export const CAKE_CHAT_TOOL_OUTPUT_MAX_BYTES = 16 * 1024;
export const CAKE_CHAT_TOOL_OUTPUT_MAX_LINES = 400;

/** The timeout one call actually gets: a short default, and a ceiling that points at delegation. */
export function cakeChatBashTimeout(requested: number | undefined): number {
  if (requested === undefined) return CAKE_CHAT_BASH_DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isFinite(requested) || requested <= 0)
    throw new Error("Invalid timeout: must be a positive number of seconds");
  if (requested > CAKE_CHAT_BASH_MAX_TIMEOUT_SECONDS)
    throw new Error(
      `Cake Chat bash calls are limited to ${CAKE_CHAT_BASH_MAX_TIMEOUT_SECONDS} seconds. Delegate project code changes to a fresh Project Session via sessions.create; longer authorized non-project tasks use a fresh project-free allowMutations: true subagent with exact targets/limits. Investigate read-only via sessions.fork when existing context is useful, or an explicitly authorized private subagent for a requested different model or unhelpful context.`,
    );
  return requested;
}

const outputLimits = {
  maxBytes: CAKE_CHAT_TOOL_OUTPUT_MAX_BYTES,
  maxLines: CAKE_CHAT_TOOL_OUTPUT_MAX_LINES,
} as const;

export function createCakeChatBashTool() {
  const bash = createBashTool();
  return defineTool({
    name: "bash",
    description: `Run a quick bash command. It starts in Cake Chat's scratch directory, not a project; pass absolute paths or cd explicitly. Default timeout ${CAKE_CHAT_BASH_DEFAULT_TIMEOUT_SECONDS}s, maximum ${CAKE_CHAT_BASH_MAX_TIMEOUT_SECONDS}s. Output keeps the last ${CAKE_CHAT_TOOL_OUTPUT_MAX_LINES} lines or ${CAKE_CHAT_TOOL_OUTPUT_MAX_BYTES / 1024}KB and says when it was truncated. Never mutate a project checkout from permanent chat. Delegate project code changes to a fresh independent Project Session via sessions.create. Longer explicitly authorized non-project tasks use a fresh allowMutations: true subagent without projectPath, with exact targets/limits; never upgrade a read-only fork. Shell is not a sandbox. Investigation uses a read-only context fork via sessions.fork when existing context is useful, or an explicitly authorized private subagent for an explicitly requested different model or unhelpful context. Context-fork commands run in the assigned managed worktree and may use longer timeouts; that does not authorize code changes.`,
    parameters: Type.Object({
      command: Type.String({ description: "Bash command to execute" }),
      timeout: Type.Optional(
        Type.Number({
          description: `Timeout in seconds; default ${CAKE_CHAT_BASH_DEFAULT_TIMEOUT_SECONDS}, maximum ${CAKE_CHAT_BASH_MAX_TIMEOUT_SECONDS}`,
        }),
      ),
    }),
    replay: "unsafe",
    outputLimits: { ...outputLimits, retain: "tail" },
    async execute(args, api, context) {
      const task = await api.snapshot(SideSessionDoc, api.conversationId, context);
      const timeout = task?.workingDirectory ? args.timeout : cakeChatBashTimeout(args.timeout);
      return bash.execute({ command: args.command, timeout }, api, context);
    },
  });
}

export function createCakeChatReadTool() {
  return { ...createReadTool(), replay: "safe" as const };
}

/** Native tools stay registered for human Side Chats; never enable them for Project Chat
 * or a legacy managed investigation fork, even if inherited/saved declarations name them. */
export function createCakeChatMutationTools(sessionId: string) {
  const guard = <T extends TSchema, D extends JsonValue>(tool: ToolRegistration<T, D>) => ({
    ...tool,
    replay: "unsafe" as const,
    description: `${tool.description} Global Cake Chat only: small, explicitly user-authorized non-project edits with exact target paths. Never modify project checkouts, Cake/Pi managed settings or credentials. Ordinary external user configuration is allowed when specifically requested. Paths target Cake's backend host, not necessarily the user's frontend machine; clarify ambiguous local-config requests before writing. For longer work, use a fresh project-free allowMutations: true subagent with exact task/targets; not a research fork. Shell and file tools are not sandboxes.`,
    async execute(...args: Parameters<typeof tool.execute>) {
      const [, api, context] = args;
      if (sessionId !== CAKE_CHAT_SESSION_ID)
        throw new Error(
          "Project Chat cannot edit files. Use a fresh Project Session and managed worktree for project changes.",
        );
      const binding = await api.snapshot(SideSessionDoc, api.conversationId, context);
      if (binding?.workingDirectory)
        throw new Error(
          "Investigation forks remain read-only. Start a fresh authorized non-project worker, or a Project Session for project changes.",
        );
      return tool.execute(...args);
    },
  });
  return [guard(createEditTool()), guard(createWriteTool())] as const;
}

/** One code-owned tool selection for both new and reopened permanent chats. */
export function createCakeChatLocalTools(sessionId: string) {
  const mutations = createCakeChatMutationTools(sessionId);
  const writable = sessionId === CAKE_CHAT_SESSION_ID;
  return {
    active: [createCakeChatReadTool(), createCakeChatBashTool(), ...(writable ? mutations : [])],
    inactive: writable ? [] : [...mutations],
  };
}

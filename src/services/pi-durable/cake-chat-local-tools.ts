import { Type } from "@earendil-works/pi-durable-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { SideSessionDoc } from "./durable-side-session";
import { createBashTool, createReadTool } from "@earendil-works/pi-durable/tools";

/**
 * Cake Chat's direct local tools: `read` and `bash` for quick checks (clipboard, PR lookups,
 * "did this commit land"). There is deliberately no edit/write tool; project changes belong
 * to Project Sessions. These guards keep one quick command from swamping or freezing the
 * permanent conversation.
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
      `Cake Chat bash calls are limited to ${CAKE_CHAT_BASH_MAX_TIMEOUT_SECONDS} seconds. Delegate code changes to a fresh Project Session via sessions.create; investigate read-only via sessions.fork when existing context is useful, or an explicitly authorized private subagent for a requested different model or unhelpful context.`,
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
    description: `Run a quick bash command. It starts in Cake Chat's scratch directory, not a project; pass absolute paths or cd explicitly. Default timeout ${CAKE_CHAT_BASH_DEFAULT_TIMEOUT_SECONDS}s, maximum ${CAKE_CHAT_BASH_MAX_TIMEOUT_SECONDS}s. Output keeps the last ${CAKE_CHAT_TOOL_OUTPUT_MAX_LINES} lines or ${CAKE_CHAT_TOOL_OUTPUT_MAX_BYTES / 1024}KB and says when it was truncated. Never mutate a project checkout from permanent chat. Delegate code changes to a fresh independent Project Session via sessions.create. Investigation uses a read-only context fork via sessions.fork when existing context is useful, or an explicitly authorized private subagent for an explicitly requested different model or unhelpful context. Context-fork commands run in the assigned managed worktree and may use longer timeouts; that does not authorize code changes.`,
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

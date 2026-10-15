import { Type } from "@earendil-works/pi-durable-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createBashTool, createReadTool } from "@earendil-works/pi-durable/tools";
import { join } from "node:path";

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

/** A Cake-owned neutral directory, never a project root, where Cake Chat's commands start. */
export const cakeChatScratchDirectory = (sessionDirectory: string) =>
  join(sessionDirectory, "scratch");

/** Every Cake Chat tool call runs in the scratch directory, whatever the agent's cwd says. */
export const cakeChatExecutionEnv = (scratchDirectory: string) => () =>
  new NodeExecutionEnv({ cwd: scratchDirectory });

/** The timeout one call actually gets: a short default, and a ceiling that points at delegation. */
export function cakeChatBashTimeout(requested: number | undefined): number {
  if (requested === undefined) return CAKE_CHAT_BASH_DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isFinite(requested) || requested <= 0)
    throw new Error("Invalid timeout: must be a positive number of seconds");
  if (requested > CAKE_CHAT_BASH_MAX_TIMEOUT_SECONDS)
    throw new Error(
      `Cake Chat bash calls are limited to ${CAKE_CHAT_BASH_MAX_TIMEOUT_SECONDS} seconds. Delegate longer work to a subagent or Project Session.`,
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
    description: `Run a quick bash command. It starts in Cake Chat's scratch directory, not a project; pass absolute paths or cd explicitly. Default timeout ${CAKE_CHAT_BASH_DEFAULT_TIMEOUT_SECONDS}s, maximum ${CAKE_CHAT_BASH_MAX_TIMEOUT_SECONDS}s. Output keeps the last ${CAKE_CHAT_TOOL_OUTPUT_MAX_LINES} lines or ${CAKE_CHAT_TOOL_OUTPUT_MAX_BYTES / 1024}KB and says when it was truncated. Never mutate a project checkout from here.`,
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
      const timeout = cakeChatBashTimeout(args.timeout);
      return bash.execute({ command: args.command, timeout }, api, context);
    },
  });
}

export function createCakeChatReadTool() {
  return { ...createReadTool(), replay: "safe" as const };
}

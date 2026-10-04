import type { Client } from "../client/Client";
import type { ProjectSessionStore } from "../stores/ProjectSessionStore";

/** The one manual/agent adapter for Pi's native interactive MCP commands.
 * There is no Cake MCP connection or credential implementation here. */
export async function submitNativeMcpAction(
  client: Client,
  session: ProjectSessionStore,
  name: string,
  action: "login" | "logout" | "reconnect",
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("Invalid MCP server name.");
  if (
    !session.model.commands.some(
      (command) => command.name === "mcp" && command.sourceInfo.path === "builtin:mcp",
    )
  )
    throw new Error("Pi's native MCP command is unavailable in this Project Session.");
  if (session.isStreaming || session.model.activeTurnIds.length > 0)
    throw new Error(
      "Native MCP actions require an idle Project Session. The calling agent is busy; use Cake Chat with an explicit idle sessionId or the manual controls when idle.",
    );
  if (!(await session.conversationSessionStore.prepareForCommand()))
    throw new Error("The Project Session could not prepare the native MCP command.");
  return client.sessionChats.prompt(
    {
      sessionId: session.sessionId,
      text: `/mcp ${action} ${name}`,
      attachments: [],
      renderUserMessageAsMarkdown: false,
    },
    { signal },
  );
}

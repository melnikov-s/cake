import { Effect, Schema } from "effect";
import { ApplicationState } from "../../services/storage/ApplicationState";
import {
  LocalMcpError,
  localMcpTools,
  type LocalMcpConfiguration,
} from "../../contracts/mcp/local-mcp";
import { AgentListInput } from "../../contracts/agent/agent-list-data";
import { jsonObjectSchema, type JsonObject } from "../../contracts/serialization/json-contract";
import { projectChatSessionId } from "../cake-chats/cakeChatLocations";
import * as chatTargets from "../cake-chats/cakeChatTargets";
import * as metadata from "../project-sessions/projectSessionMetadata";
import * as projects from "../projects/projects";
import { toJsonValue } from "../../utils/to-json-value";

export const toolsForGrant = (grant: LocalMcpConfiguration) =>
  localMcpTools.filter((tool) => (grant.scopes ?? ["read"]).includes(tool.scope));

/** An external caller delegates a bounded operation to the selected Project Chat.
 * Its registry retains model resolution, task-input protection and admission policy.
 * No external command or input can select another runtime or invoke nested operations.
 */
export const invoke = Effect.fn("LocalMcpControl.invoke")(
  function* (grant: LocalMcpConfiguration, name: string, input: JsonObject) {
    const tool = localMcpTools.find((candidate) => candidate.name === name);
    if (!tool)
      return yield* new LocalMcpError({
        code: "unsupported",
        message: "Operation is not exposed by local MCP.",
      });
    if (!toolsForGrant(grant).includes(tool))
      return yield* new LocalMcpError({
        code: "denied",
        message: `This connection does not have the ${tool.scope} scope.`,
      });
    const decoded = yield* Schema.decodeUnknownEffect(tool.inputSchema)(input, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        (error) => new LocalMcpError({ code: "invalid_input", message: error.message }),
      ),
    );
    const args = yield* Schema.decodeUnknownEffect(jsonObjectSchema)(decoded);
    if (name === "projects.list")
      return toJsonValue({
        ok: true,
        command: name,
        ...(yield* projects.listForAgent(
          yield* Schema.decodeUnknownEffect(AgentListInput)(args),
          grant.projects,
        )),
      });

    const projectPath = yield* Schema.decodeUnknownEffect(Schema.String)(args.projectPath);
    const state = (yield* ApplicationState).snapshot();
    if (
      !grant.projects.includes(projectPath) ||
      !state.projects.some((item) => item.path === projectPath)
    )
      return yield* new LocalMcpError({
        code: "denied",
        message: "Project is outside this grant or is no longer registered.",
      });
    if (name === "projects.info")
      return toJsonValue({
        ok: true,
        command: name,
        ...(yield* projects.infoForAgent({ path: projectPath })),
      });

    // Read-only registry metadata above needs no executable project resources. Every
    // runtime-backed call rechecks live trust, including after the Project is removed.
    if (!state.trustedProjectPaths.includes(projectPath))
      return yield* new LocalMcpError({
        code: "denied",
        message: "Project is not trusted. Trust it in Cake; MCP cannot grant trust.",
      });
    const chatId = projectChatSessionId(projectPath);
    if (args.sessionId !== undefined) {
      const sessionId = yield* Schema.decodeUnknownEffect(Schema.String)(args.sessionId);
      if (sessionId !== chatId) {
        // Never accept suffixes, deep links or another chat's ID: validate the exact
        // identity before the ordinary registry can resolve its convenient references.
        if (!Schema.is(Schema.String.check(Schema.isUUID(4)))(sessionId))
          return yield* new LocalMcpError({
            code: "denied",
            message: "Use a canonical session ID in this Project.",
          });
        const location = yield* metadata.findLocation({ sessionId }).pipe(
          Effect.mapError(
            () =>
              new LocalMcpError({
                code: "denied",
                message: "Session is unavailable in this Project.",
              }),
          ),
        );
        if (location.projectPath !== projectPath)
          return yield* new LocalMcpError({
            code: "denied",
            message: "Session is outside this Project.",
          });
      }
    }
    const argumentsValue = { ...args };
    delete argumentsValue.projectPath;
    const handle = yield* chatTargets.acquireAvailable(chatId);
    return yield* handle.callCakeOperation(
      name,
      name === "sessions.create"
        ? { ...argumentsValue, workspacePath: projectPath }
        : name === "sessions.list"
          ? { ...argumentsValue, projectPath }
          : argumentsValue,
    );
  },
  Effect.mapError((error) =>
    error instanceof LocalMcpError
      ? error
      : new LocalMcpError({
          code: "operation_failed",
          message: error instanceof Error ? error.message : String(error),
        }),
  ),
);

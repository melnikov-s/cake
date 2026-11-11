import { Effect, FileSystem, Path, Result, Schema, type Scope } from "effect";
import { Base64 } from "effect/encoding";
import { HttpClient, HttpClientRequest } from "effect/http";
import {
  ArtifactCommandError,
  ArtifactHostInvocation,
  artifactHostCommandDescriptions,
  artifactHostCommands,
} from "../../contracts/artifacts/artifact-commands";
import { BackendAgentInvocation } from "../../contracts/application/backend-agent-control";
import { backendAgentTools } from "../../contracts/application/backend-agent-tools";
import { backendAgentSettingsTools } from "../../contracts/application/agent-settings-tools";
import { ArtifactLineageId } from "../../contracts/artifacts/artifact-lineage";
import { globalArtifactOperationContracts } from "../../contracts/artifacts/global-artifact-control";
import { isCakeChatSessionId } from "../../contracts/cake-chats/cake-chat-identity";
import {
  toDraft07JsonSchema,
  jsonObjectSchema,
  type JsonValue,
} from "../../contracts/serialization/json-contract";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";
import { rejectArtifactRuntimeReentry } from "../../services/artifact-runtime/ArtifactRuntimeExecution";
import * as agentControl from "../application/agentControl";
import * as artifactShell from "./artifactShell";
import { projectChatSessionId } from "../cake-chats/cakeChatLocations";
import * as chatTargets from "../cake-chats/cakeChatTargets";
import * as metadata from "../project-sessions/projectSessionMetadata";
import * as projectSessions from "../project-sessions/projectSessionOperations";
import * as sessionReferences from "../project-sessions/sessionReferences";
import * as sessionCompaction from "../project-sessions/sessionCompaction";
import { SessionToolPruneInput } from "../../contracts/project-sessions/session-compaction";
import * as sessionChats from "../conversations/sessionChats";
import { toJsonValue } from "../../utils/to-json-value";
import {
  assertWidgetCommand,
  widgetAttachmentContracts,
} from "../../contracts/widgets/widget-attachment";

export interface ArtifactCommandContext {
  readonly artifactId: string;
  /** Only the genuine invoking session, never inferred from the artifact creator. */
  readonly callingSessionId?: string;
  /** Actual UI connection, independent of conversation linkage. Background calls omit it. */
  readonly windowConnectionId?: number;
}

/** Discovery comes from canonical command schemas, not a second permissions registry. */
export function describe(command?: string): JsonValue {
  const descriptions = new Map(backendAgentTools().map((tool) => [tool.command, tool.summary]));
  const commands = [
    ...BackendAgentInvocation.members.map((member) => ({
      command: member.fields.name.literal,
      description:
        descriptions.get(member.fields.name.literal) ?? "Canonical backend Cake operation.",
      parameters: toDraft07JsonSchema(member.fields.arguments),
    })),
    ...backendAgentSettingsTools(),
    ...globalArtifactOperationContracts.map((definition) => ({
      command: definition.command,
      description: definition.summary,
      parameters: toDraft07JsonSchema(definition.inputSchema),
    })),
    ...widgetAttachmentContracts.map((entry) => ({
      command: entry.command,
      description: entry.summary,
      parameters: toDraft07JsonSchema(entry.inputSchema),
    })),
    ...ArtifactHostInvocation.members.map((member) => ({
      command: member.fields.name.literal,
      description: artifactHostCommandDescriptions[member.fields.name.literal],
      parameters: toDraft07JsonSchema(member.fields.arguments),
    })),
  ];
  const selected = command ? commands.filter((item) => item.command === command) : commands;
  return toJsonValue({
    ok: !command || selected.length > 0,
    commands: selected,
    context:
      "Trusted backend host. No current session is inferred. Session-relative commands require an actual callingSessionId; destination chat is always explicit.",
    limits: [
      "UI calls retain their actual connected window independently of session linkage. Commands outside this backend catalog use its canonical window registry, or the genuine calling session's Cake gateway. Background calls have no implicit window.",
      "This bridge exposes Cake commands, not arbitrary Pi tools or the Pi agent engine.",
      "Run-relative memory, reports, completion inboxes, threads, scheduled messages and normal compaction require a real calling session. Use explicit automation/session IDs where supported.",
      "sessions.tool-prune supports user-authorized unattended artifact maintenance with an explicit Project Session ID or unambiguous discovered suffix. Without a calling session it uses trusted host authority across registered, accessible projects; it never infers a creator or parent. With a calling session its existing project scope is retained.",
      "Project MCP settings require a real Project Session Working Directory; global settings work without a session.",
    ],
    ...(command && !selected.length ? { error: `Unknown backend Cake command: ${command}` } : null),
  });
}

const caller = Effect.fn("ArtifactCommands.caller")(function* (sessionId?: string) {
  if (!sessionId) return undefined;
  if (isCakeChatSessionId(sessionId)) {
    const project = (yield* ApplicationState)
      .snapshot()
      .projects.find((item) => projectChatSessionId(item.path) === sessionId);
    return {
      kind: "cake-chat" as const,
      sessionId,
      title: project?.name ?? "Cake Chat",
      ...(project ? { projectPath: project.path, projectName: project.name } : null),
    };
  }
  const known = yield* metadata.lookup({ sessionId });
  return {
    kind: "project-session" as const,
    sessionId,
    title: known.title,
    projectPath: known.projectPath,
    projectName: known.projectName,
    workingDirectory: known.workingDirectory,
  };
});

const host = Effect.fn("ArtifactCommands.host")(function* (
  invocation: ArtifactHostInvocation,
  context: ArtifactCommandContext,
) {
  const command = invocation.name;
  switch (invocation.name) {
    case "commands.list":
      return describe();
    case "commands.help":
      return describe(invocation.arguments.command);
    case "filesystem.read":
    case "filesystem.write":
    case "filesystem.list": {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = invocation.arguments;
      if (!path.isAbsolute(input.path))
        return yield* new ArtifactCommandError({
          command,
          message: "Filesystem paths must be absolute backend-host paths.",
        });
      if (invocation.name === "filesystem.list")
        return toJsonValue({
          ok: true,
          command,
          path: input.path,
          entries: yield* fs.readDirectory(input.path),
        });
      if (invocation.name === "filesystem.read") {
        const input = invocation.arguments;
        const encoding = input.encoding ?? "utf8";
        const bytes = yield* fs.readFile(input.path);
        return toJsonValue({
          ok: true,
          command,
          path: input.path,
          encoding,
          content: encoding === "base64" ? Base64.encode(bytes) : new TextDecoder().decode(bytes),
        });
      }
      const write = invocation.arguments;
      let bytes: Uint8Array;
      if (write.encoding === "base64") {
        const decoded = Base64.decode(write.content);
        if (Result.isFailure(decoded))
          return yield* new ArtifactCommandError({ command, message: decoded.failure.message });
        bytes = decoded.success;
      } else bytes = new TextEncoder().encode(write.content);
      yield* fs.writeFile(write.path, bytes);
      return toJsonValue({ ok: true, command, path: write.path, bytesWritten: bytes.byteLength });
    }
    case "shell.run":
      return toJsonValue(yield* artifactShell.run(invocation.arguments));
    case "network.request": {
      const input = invocation.arguments;
      const client = yield* HttpClient.HttpClient;
      let request = HttpClientRequest.make(input.method ?? "GET")(input.url, {
        headers: input.headers,
      });
      if (input.body !== undefined)
        request = HttpClientRequest.bodyText(request, input.body, request.headers["content-type"]);
      const response = yield* client.execute(request);
      const encoding = input.responseEncoding ?? "utf8";
      const body =
        encoding === "base64"
          ? Base64.encode(new Uint8Array(yield* response.arrayBuffer))
          : yield* response.text;
      return toJsonValue({
        ok: true,
        command,
        status: response.status,
        headers: response.headers,
        encoding,
        body,
      });
    }
    case "chat.prompt": {
      // Resolve only the explicit destination. An actual caller is provenance, never a default target.
      const sessionId = yield* sessionReferences.resolve(
        invocation.arguments.sessionId,
        context.callingSessionId,
      );
      if (isCakeChatSessionId(sessionId)) yield* chatTargets.acquireAvailable(sessionId);
      else {
        const known = yield* metadata.lookupWithLocation({ sessionId });
        yield* projectSessions.acquireTarget(known.location, sessionId, false);
      }
      const turnId = yield* sessionChats.promptArtifact({
        ...invocation.arguments,
        sessionId,
        ...context,
      });
      return toJsonValue({ ok: true, command, sessionId, turnId, status: "admitted" });
    }
  }
});

/** No Session Plugin, transcript or agent runtime is created to host an artifact. */
export const invoke: (
  command: string,
  input: JsonValue,
  context: ArtifactCommandContext,
) => Effect.Effect<
  JsonValue,
  ArtifactCommandError,
  agentControl.AgentControlServices | Scope.Scope
> = Effect.fn("ArtifactCommands.invoke")(
  function* (command: string, input: JsonValue, context: ArtifactCommandContext) {
    yield* Schema.decodeUnknownEffect(ArtifactLineageId)(context.artifactId);
    yield* Effect.try({
      try: () => assertWidgetCommand(command),
      catch: (cause) =>
        new ArtifactCommandError({
          command,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });
    if (command === "artifacts.replace" || command === "artifacts.restore") {
      const target = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ lineageId: ArtifactLineageId }),
      )(input);
      // These source operations cross a real session's callback boundary before
      // publication; reject self-reentry before generation or storage changes.
      yield* rejectArtifactRuntimeReentry(target.lineageId, command);
    }
    if (artifactHostCommands.has(command)) {
      const invocation = yield* Schema.decodeUnknownEffect(ArtifactHostInvocation)(
        { name: command, arguments: input },
        { onExcessProperty: "error" },
      );
      return yield* host(invocation, context);
    }
    if (command === "sessions.tool-prune" && context.callingSessionId === undefined) {
      const parsed = yield* Schema.decodeUnknownEffect(SessionToolPruneInput)(input, {
        onExcessProperty: "error",
      });
      const results = yield* sessionCompaction.toolPruneFromArtifact(parsed.sessionId);
      return toJsonValue({
        ok: results.every(
          (result) => result.status === "compacted" || result.status === "unchanged",
        ),
        command,
        results,
      });
    }
    const source = yield* caller(context.callingSessionId);
    const result = yield* agentControl.invoke(command, input, source, context.windowConnectionId);
    if (result !== undefined) return result;
    if (context.windowConnectionId !== undefined) {
      const window = yield* (yield* RendererRequestCoordinator).requestWindowControl(
        context.windowConnectionId,
        { name: command, arguments: input },
        source,
      );
      if (window.handled) return window.result;
    }
    if (!context.callingSessionId)
      return yield* new ArtifactCommandError({
        command,
        message: `No backend Cake command named ${command}, and no actual calling session is available for its native/window or session gateway. Discover backend commands with commands.list. No creator or coordinator is inferred.`,
      });
    const arguments_ = yield* Schema.decodeUnknownEffect(jsonObjectSchema)(input);
    if (isCakeChatSessionId(context.callingSessionId)) {
      const handle = yield* chatTargets.acquireAvailable(context.callingSessionId);
      // The full-control registry uses this real chat as its context; it is not a background identity.
      return (yield* handle.callCakeTool(command, arguments_)).json;
    }
    return yield* projectSessions.callCakeOperation(
      { sessionId: context.callingSessionId },
      command,
      arguments_,
    );
  },
  (effect, command) =>
    effect.pipe(
      Effect.mapError((cause) =>
        cause instanceof ArtifactCommandError
          ? cause
          : new ArtifactCommandError({
              command,
              message: cause instanceof Error ? cause.message : String(cause),
            }),
      ),
    ),
);

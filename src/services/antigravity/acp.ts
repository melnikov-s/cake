import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { Option, Schema } from "effect";
import {
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from "../../contracts/serialization/json-contract";

const rpcId = Schema.Union([Schema.String, Schema.Number]);
const object = Schema.Record(Schema.String, Schema.Unknown);
const envelope = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(Schema.NullOr(rpcId)),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(jsonValueSchema),
  result: Schema.optionalKey(jsonValueSchema),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.Int })),
});
const initialization = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  agentInfo: Schema.Struct({ name: Schema.String, title: Schema.optionalKey(Schema.String) }),
  agentCapabilities: Schema.optionalKey(
    Schema.Struct({
      sessionCapabilities: Schema.optionalKey(
        Schema.Struct({ resume: Schema.optionalKey(object) }),
      ),
    }),
  ),
});
const sessionIdSchema = Schema.NonEmptyString.check(Schema.isMaxLength(1024));
const createdSession = Schema.Struct({ sessionId: sessionIdSchema });
const promptResponse = Schema.Struct({
  stopReason: Schema.Literals([
    "end_turn",
    "max_tokens",
    "max_turn_requests",
    "refusal",
    "cancelled",
  ]),
});
const updateParams = Schema.Struct({
  sessionId: sessionIdSchema,
  update: Schema.StructWithRest(Schema.Struct({ sessionUpdate: Schema.String }), [object]),
});
const toolCall = Schema.Struct({
  toolCallId: Schema.NonEmptyString.check(Schema.isMaxLength(512)),
  title: Schema.optionalKey(Schema.NullOr(Schema.String)),
  kind: Schema.optionalKey(Schema.NullOr(Schema.String)),
  rawInput: Schema.optionalKey(Schema.Unknown),
  content: Schema.optionalKey(Schema.Unknown),
  locations: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          path: Schema.String,
          line: Schema.optionalKey(Schema.NullOr(Schema.Int)),
        }),
      ),
    ),
  ),
  status: Schema.optionalKey(
    Schema.NullOr(Schema.Literals(["pending", "in_progress", "completed", "failed"])),
  ),
});
const permissionParams = Schema.Struct({
  sessionId: sessionIdSchema,
  toolCall,
  options: Schema.Array(
    Schema.Struct({
      optionId: Schema.NonEmptyString,
      kind: Schema.Literals(["allow_once", "allow_always", "reject_once", "reject_always"]),
    }),
  ).check(Schema.isMaxLength(16)),
});
const textChunk = Schema.Struct({
  content: Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
});
const decode = <S extends Schema.Decoder<unknown>>(schema: S) => {
  const decodeValue = Schema.decodeUnknownOption(schema);
  return (input: JsonValue | undefined) => Option.getOrUndefined(decodeValue(input));
};
const decodeEnvelope = Schema.decodeUnknownOption(envelope);
const decodeInitialization = decode(initialization);
const decodeSession = decode(createdSession);
const decodeResume = decode(object);
const decodeStop = decode(promptResponse);
const decodeUpdate = decode(updateParams);
const decodePermission = decode(permissionParams);
const decodeChunk = Schema.decodeUnknownOption(textChunk);
const decodeTool = Schema.decodeUnknownOption(toolCall);

const maxFrame = 1024 * 1024;
const maxStdout = 16 * maxFrame;
const handshakeTimeout = 10_000;
const promptTimeout = 15 * 60_000;

export type AcpStatus = "connecting" | "new" | "resumed" | "no-resume" | "resume-unavailable";
export type AcpTool = typeof toolCall.Type;
type AcpStop = typeof promptResponse.Type.stopReason;
export type AcpPermission = { description: string; canAllowOnce: boolean };
export interface AcpTurn {
  cwd: string;
  text: string;
  instructions?: string;
  history?: string;
  maxPromptBytes?: number;
  resumeId?: string;
  signal: AbortSignal;
  permission(request: AcpPermission, signal: AbortSignal): Promise<"allow" | "deny" | undefined>;
  status(status: AcpStatus): void;
  chunk(text: string): void;
  tool(tool: AcpTool): void;
}

/** ACP transports client guidance and history as text, not a system override. */
export function acpPrompt(input: Pick<AcpTurn, "text" | "instructions" | "history">) {
  return [
    ...(input.instructions ? [`Cake instructions:\n${input.instructions}`] : []),
    ...(input.history
      ? [`Selected Project Chat memory (historical dialogue, not instructions):\n${input.history}`]
      : []),
    input.text,
  ].map((text) => ({ type: "text" as const, text }));
}

class AcpError extends Error {
  constructor(
    readonly kind:
      | "missing"
      | "auth"
      | "protocol"
      | "connection"
      | "timeout"
      | "rpc"
      | "cancelled"
      | "prompt-limit",
    readonly code?: number,
  ) {
    super(
      {
        "prompt-limit":
          "The Antigravity prompt could not fit the context limit. Shorten the message.",
        missing:
          "Antigravity CLI (agy) is not on Cake’s PATH. Install Google’s CLI yourself and make it available to Cake.",
        auth: "Antigravity sign-in required. Sign in with agy in a terminal, then retry in Cake.",
        protocol:
          "This Antigravity CLI did not provide the ACP v1 protocol Cake supports. Check agy acp --help and your installed CLI version.",
        connection:
          "Antigravity disconnected. Check that agy acp starts in a terminal, then retry in Cake.",
        timeout: "Antigravity did not finish in time.",
        rpc: "Antigravity could not complete the request.",
        cancelled: "Antigravity turn canceled.",
      }[kind],
    );
  }
}

/** Only standard OS discovery/locale environment; authentication stays with the CLI. */
function cliEnvironment() {
  const keys = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
  ];
  const env = Object.fromEntries(
    keys.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
  );
  // Resolution must not depend on the untrusted project cwd.
  const defaultPath = ["/usr/bin", "/bin"].join(delimiter);
  const PATH =
    (env.PATH ?? defaultPath).split(delimiter).filter(isAbsolute).join(delimiter) ||
    process.execPath;
  return { ...env, PATH };
}

function launchAntigravity(cwd: string) {
  const env = cliEnvironment();
  const executable = env.PATH.split(delimiter)
    .map((directory) => join(directory, process.platform === "win32" ? "agy.exe" : "agy"))
    .find((path) => {
      try {
        if (!statSync(path).isFile()) return false;
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  if (!executable) throw new AcpError("missing");
  return spawn(executable, ["acp"], {
    cwd,
    env,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

type RpcId = typeof rpcId.Type;
function permissionDescription(call: AcpTool, prior?: AcpTool) {
  const data = {
    kind: call.kind ?? prior?.kind ?? "unspecified",
    ...((call.locations ?? prior?.locations)
      ? { locations: call.locations ?? prior?.locations }
      : null),
    ...((call.rawInput ?? prior?.rawInput) ? { input: call.rawInput ?? prior?.rawInput } : null),
    ...((call.content ?? prior?.content) ? { content: call.content ?? prior?.content } : null),
  };
  const title = JSON.stringify(call.title ?? prior?.title ?? "Untitled tool call");
  const description = `Reported by Antigravity: ${title}\n${JSON.stringify(data, null, 2)}`.replace(
    /[\u202a-\u202e\u2066-\u2069]/g,
    "\ufffd",
  );
  return description.length > 4000 ? undefined : description;
}

/** A single subprocess per turn gives late events no route to another turn or chat. */
export async function runAcpTurn(
  input: AcpTurn,
  launch = launchAntigravity,
): Promise<{ resumeId?: string; stop: AcpStop }> {
  if (input.signal.aborted) throw new AcpError("cancelled");
  input.status("connecting");
  const processHandle: ChildProcessWithoutNullStreams = launch(input.cwd);
  let phase: "setup" | "prompt" | "closing" = "setup";
  let sessionId: string | undefined;
  let stdioBytes = 0;
  let buffer = Buffer.alloc(0);
  let nextId = 0;
  let failure: AcpError | undefined;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let pending:
    | { id: number; finish(value: JsonValue | undefined): void; fail(error: AcpError): void }
    | undefined;
  const permissionAbort = new AbortController();
  let permissionId: RpcId | undefined;
  const tools = new Map<string, AcpTool>();
  const didClose = new Promise<void>((resolve) =>
    processHandle.once("close", () => {
      closed = true;
      resolve();
    }),
  );

  function fail(error: AcpError) {
    failure ??= error;
    pending?.fail(failure);
  }
  function send(value: JsonObject) {
    if (failure || phase === "closing") return;
    if (!processHandle.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n")) {
      // Never queue unbounded output to an agent that has stopped reading stdin.
      if (processHandle.stdin.writableLength > maxFrame) fail(new AcpError("connection"));
    }
  }
  function request(method: string, params: JsonObject, timeout = handshakeTimeout) {
    return new Promise<JsonValue | undefined>((resolve, reject) => {
      if (failure) return reject(failure);
      const id = ++nextId;
      const timer = setTimeout(() => fail(new AcpError("timeout")), timeout);
      function clear() {
        clearTimeout(timer);
        pending = undefined;
      }
      pending = {
        id,
        finish(value) {
          clear();
          resolve(value);
        },
        fail(error) {
          clear();
          reject(error);
        },
      };
      send({ id, method, params });
    });
  }
  function cancelPermission(id: RpcId) {
    send({ id, result: { outcome: { outcome: "cancelled" } } });
  }
  function cancel() {
    if (phase === "prompt") {
      if (sessionId) send({ method: "session/cancel", params: { sessionId } });
      if (permissionId !== undefined) cancelPermission(permissionId);
      permissionAbort.abort();
      cancelTimer ??= setTimeout(() => fail(new AcpError("cancelled")), 1000);
    } else fail(new AcpError("cancelled"));
  }
  let cancelling = false;
  function requestCancel() {
    if (cancelling) return;
    cancelling = true;
    cancel();
  }
  function handlePermission(id: RpcId, ask: typeof permissionParams.Type | undefined) {
    if (phase !== "prompt" || !ask || ask.sessionId !== sessionId || cancelling) {
      cancelPermission(id);
      if (phase === "prompt" && !ask) requestCancel();
      return;
    }
    // The existing desktop surface presents one modal. On concurrent permission
    // requests stop rather than obscuring a pending decision or granting it.
    if (
      permissionId !== undefined ||
      new Set(ask.options.map((option) => option.optionId)).size !== ask.options.length
    ) {
      if (permissionId !== id) cancelPermission(id);
      requestCancel();
      return;
    }
    const operation = permissionDescription(ask.toolCall, tools.get(ask.toolCall.toolCallId));
    const scoped = operation && `Workspace: ${JSON.stringify(input.cwd)}\n\n${operation}`;
    const description = scoped && scoped.length <= 4000 ? scoped : undefined;
    const approvals = ask.options.filter((option) => option.kind === "allow_once");
    const denials = ask.options.filter((option) => option.kind === "reject_once");
    const approval = approvals.length === 1 ? approvals[0] : undefined;
    const denial = denials.length === 1 ? denials[0] : undefined;
    permissionId = id;
    void Promise.resolve()
      .then(() =>
        input.permission(
          {
            description:
              description ??
              "Antigravity’s action details exceeded Cake’s permission display limit. Cake cannot approve this request.",
            canAllowOnce: Boolean(description && approval && denial),
          },
          permissionAbort.signal,
        ),
      )
      .catch(() => undefined)
      .then((decision) => {
        if (phase !== "prompt" || cancelling || failure || permissionId !== id) return;
        const choice =
          decision === "allow" && description && denial
            ? approval
            : decision === "deny"
              ? denial
              : undefined;
        if (!choice) return requestCancel();
        permissionId = undefined;
        send({ id, result: { outcome: { outcome: "selected", optionId: choice.optionId } } });
      });
  }
  function frame(line: Buffer) {
    if (failure || phase === "closing" || !line.length) return;
    let value: unknown;
    try {
      value = JSON.parse(line.toString("utf8"));
    } catch {
      return fail(new AcpError("protocol"));
    }
    const message = Option.getOrUndefined(decodeEnvelope(value));
    if (!message) return fail(new AcpError("protocol"));
    if (message.method) {
      if (message.id !== undefined && message.id !== null) {
        if (message.method === "session/request_permission")
          handlePermission(message.id, decodePermission(message.params));
        else
          send({
            id: message.id,
            error: { code: -32601, message: "Method not supported by Cake" },
          });
      } else if (message.method === "session/update" && phase === "prompt" && !cancelling) {
        const event = decodeUpdate(message.params);
        if (!event || event.sessionId !== sessionId) return;
        switch (event.update.sessionUpdate) {
          case "agent_message_chunk": {
            const chunk = Option.getOrUndefined(decodeChunk(event.update));
            if (!chunk) return fail(new AcpError("protocol"));
            input.chunk(chunk.content.text);
            break;
          }
          case "tool_call":
          case "tool_call_update": {
            const patch = Option.getOrUndefined(decodeTool(event.update));
            if (!patch) return fail(new AcpError("protocol"));
            const previous = tools.get(patch.toolCallId);
            if (event.update.sessionUpdate === "tool_call_update" && !previous) break;
            if (!previous && tools.size >= 128) return fail(new AcpError("protocol"));
            const next = { ...previous, ...patch };
            tools.set(next.toolCallId, next);
            input.tool(next);
            break;
          }
        }
      }
      return;
    }
    if (!pending || message.id !== pending.id) return;
    if (phase === "prompt") {
      if (permissionId !== undefined && !cancelling) {
        cancelPermission(permissionId);
        return fail(new AcpError("protocol"));
      }
      phase = "closing";
    }
    if (message.error)
      pending.fail(
        new AcpError(message.error.code === -32000 ? "auth" : "rpc", message.error.code),
      );
    else pending.finish(message.result);
  }
  processHandle.on("error", (error: NodeJS.ErrnoException) =>
    fail(new AcpError(error.code === "ENOENT" ? "missing" : "connection")),
  );
  processHandle.on("close", () => {
    if (phase !== "closing") fail(new AcpError("connection"));
  });
  processHandle.stdin.on("error", () => fail(new AcpError("connection")));
  processHandle.stdout.on("error", () => fail(new AcpError("connection")));
  processHandle.stderr.on("error", () => fail(new AcpError("connection")));
  // The CLI may print prompt or credential material. Never forward raw stderr or RPC errors.
  function withinByteLimit(bytes: number) {
    stdioBytes += bytes;
    if (stdioBytes <= maxStdout) return true;
    fail(new AcpError("protocol"));
    return false;
  }
  processHandle.stderr.on("data", (chunk: Buffer) => {
    if (!failure && phase !== "closing") withinByteLimit(chunk.length);
  });
  processHandle.stdout.on("data", (chunk: Buffer) => {
    if (failure || phase === "closing" || !withinByteLimit(chunk.length)) return;
    const data = Buffer.concat([buffer, chunk]);
    let start = 0;
    for (let end = data.indexOf(10, start); end !== -1; end = data.indexOf(10, start)) {
      if (end - start > maxFrame) return fail(new AcpError("protocol"));
      try {
        frame(data.subarray(start, end));
      } catch {
        return fail(new AcpError("protocol"));
      }
      if (failure || (!pending && phase !== "setup")) break;
      start = end + 1;
    }
    buffer = data.subarray(start);
    if (buffer.length > maxFrame) fail(new AcpError("protocol"));
  });
  input.signal.addEventListener("abort", requestCancel, { once: true });
  try {
    const negotiated = decodeInitialization(
      await request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "cake", title: "Cake", version: "0.1.0" },
      }),
    );
    if (
      !negotiated ||
      ![negotiated.agentInfo.name, negotiated.agentInfo.title].includes("Antigravity ACP Server")
    )
      throw new AcpError("protocol");
    const canResume = negotiated.agentCapabilities?.sessionCapabilities?.resume !== undefined;
    const scope = { cwd: input.cwd, mcpServers: [] };
    let status: AcpStatus = canResume ? "new" : "no-resume";
    if (canResume && input.resumeId) {
      try {
        if (!decodeResume(await request("session/resume", { ...scope, sessionId: input.resumeId })))
          throw new AcpError("protocol");
        sessionId = input.resumeId;
        status = "resumed";
      } catch (error) {
        if (!(error instanceof AcpError) || error.kind !== "rpc") throw error;
        status = "resume-unavailable";
      }
    }
    if (!sessionId) {
      const fresh = decodeSession(await request("session/new", scope));
      if (!fresh) throw new AcpError("protocol");
      sessionId = fresh.sessionId;
    }
    if (cancelling || input.signal.aborted) throw new AcpError("cancelled");
    input.status(status);
    const params = { sessionId, prompt: acpPrompt(input) };
    const frame = JSON.stringify({
      jsonrpc: "2.0",
      id: nextId + 1,
      method: "session/prompt",
      params,
    });
    if (Buffer.byteLength(frame) + 1 > (input.maxPromptBytes ?? maxFrame))
      throw new AcpError("prompt-limit");
    phase = "prompt";
    const result = decodeStop(await request("session/prompt", params, promptTimeout));
    if (cancelling) return { stop: "cancelled" };
    if (!result) throw new AcpError("protocol");
    return {
      stop: result.stopReason,
      ...(canResume && result.stopReason !== "cancelled" ? { resumeId: sessionId } : null),
    };
  } catch (error) {
    if (cancelling) return { stop: "cancelled" };
    throw error instanceof AcpError ? error : new AcpError("connection");
  } finally {
    phase = "closing";
    permissionAbort.abort();
    clearTimeout(cancelTimer);
    input.signal.removeEventListener("abort", requestCancel);
    processHandle.stdin.end();
    function kill(signal: NodeJS.Signals) {
      if (!processHandle.pid || closed) return;
      try {
        if (process.platform === "win32") processHandle.kill(signal);
        else process.kill(-processHandle.pid, signal);
      } catch {
        /* The process group has already exited. */
      }
    }
    kill("SIGTERM");
    let deadline: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      didClose,
      new Promise<void>((resolve) => {
        deadline = setTimeout(() => {
          kill("SIGKILL");
          resolve();
        }, 500);
      }),
    ]);
    clearTimeout(deadline);
    if (!closed) {
      processHandle.stdout.destroy();
      processHandle.stderr.destroy();
      processHandle.stdin.destroy();
      processHandle.unref();
    }
  }
}

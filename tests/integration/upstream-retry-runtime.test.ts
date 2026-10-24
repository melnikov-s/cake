import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Type,
  createAssistantMessageEventStream,
  isRetryableAssistantError,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCakeSessionRuntimeRecovery } from "../../src/services/pi/runtime/cake-session-runtime-recovery";

type StreamFunction = AgentSession["agent"]["streamFunction"];
type Delivery = "event" | "result";
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

function assistant(
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
  content: AssistantMessage["content"] = [],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openai",
    model: "gpt-4.1-mini",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

const recovered = () => assistant("stop", undefined, [{ type: "text", text: "Recovered" }]);

function response(message: AssistantMessage, delivery: Delivery) {
  const stream = createAssistantMessageEventStream();
  if (delivery === "result") stream.end(message);
  else if (message.stopReason === "error" || message.stopReason === "aborted")
    stream.push({ type: "error", reason: message.stopReason, error: message });
  else
    stream.push({
      type: "done",
      reason: message.stopReason as "stop" | "toolUse",
      message,
    });
  return stream;
}

/** Real Pi session/retry engine and Cake adapter; only the provider stream is scripted. */
async function openRuntime(
  script: (attempt: number) => AssistantMessage,
  delivery: Delivery,
  options: { enabled?: boolean; baseDelayMs?: number } = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), "cake-upstream-retry-"));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  vi.stubEnv("PI_OFFLINE", "1");
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
  });
  await modelRuntime.setRuntimeApiKey("openai", "fixture-key");
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    cacheWarming: "off",
    retry: {
      enabled: options.enabled ?? true,
      baseDelayMs: options.baseDelayMs ?? 1,
      maxAgentDelayMs: options.baseDelayMs ?? 8,
      // Deliberately retain Pi's default maxRetries (3).
    },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    noThemes: true,
  });
  await resourceLoader.reload();
  const execute = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "Recorded once" }],
    details: undefined,
  }));
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: modelRuntime.getModel("openai", "gpt-4.1-mini"),
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: "builtin",
    customTools: [
      {
        name: "record",
        label: "Record",
        description: "Record a completed side effect",
        parameters: Type.Object({}),
        execute,
      },
    ],
  });
  let attempts = 0;
  const base = vi.fn<StreamFunction>(() => response(script(++attempts), delivery));
  session.agent.streamFunction = base;
  const emitPart = vi.fn();
  const recovery = createCakeSessionRuntimeRecovery({
    session,
    retryEnabled: () => true,
    isDisposed: () => false,
    emitPart,
    removePart: vi.fn(),
  });
  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  cleanups.push(async () => {
    await session.abort();
    recovery.dispose();
    session.dispose();
  });
  return {
    session,
    base,
    events,
    execute,
    recovery,
    emitPart,
    async prompt() {
      recovery.onUserInput();
      await recovery.withResponseRetries(() => session.prompt("Continue the task"));
      await recovery.handleSettledTurn();
    },
  };
}

describe.each(["event", "result"] as const)("native upstream retry via %s", (delivery) => {
  it.each(["no healthy upstream", "502 Bad Gateway", "503 Service Unavailable"])(
    "lets Pi recover from %s with its normal backoff",
    async (error) => {
      const h = await openRuntime(
        (attempt) => (attempt <= 2 ? assistant("error", error) : recovered()),
        delivery,
      );
      await h.prompt();
      expect(h.base).toHaveBeenCalledTimes(3);
      expect(h.events.filter((event) => event.type === "auto_retry_start")).toEqual([
        expect.objectContaining({ attempt: 1, maxAttempts: 3, delayMs: 1 }),
        expect.objectContaining({ attempt: 2, maxAttempts: 3, delayMs: 2 }),
      ]);
      expect(h.events).toContainEqual({ type: "auto_retry_end", success: true, attempt: 2 });
      expect(h.session.messages.at(-1)).toMatchObject({
        stopReason: "stop",
        content: [{ type: "text", text: "Recovered" }],
      });
      const errors = h.events.flatMap((event) =>
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.errorMessage
          ? [event.message.errorMessage]
          : [],
      );
      expect(errors).toEqual([
        error === "no healthy upstream" ? `Service unavailable: ${error}` : error,
        error === "no healthy upstream" ? `Service unavailable: ${error}` : error,
      ]);
      // Cake has not started its separate 429/empty-response retries or hidden continuation.
      expect(h.emitPart).not.toHaveBeenCalled();
    },
  );

  it("exhausts Pi's three retries without another Cake retry or continuation", async () => {
    const h = await openRuntime(() => assistant("error", "no healthy upstream"), delivery);
    await h.prompt();
    expect(h.base).toHaveBeenCalledTimes(4);
    expect(
      h.events.filter((event) => event.type === "auto_retry_start").map((event) => event.delayMs),
    ).toEqual([1, 2, 4]);
    expect(h.events).toContainEqual({
      type: "auto_retry_end",
      success: false,
      attempt: 3,
      finalError: "Service unavailable: no healthy upstream",
    });
    expect(h.session.messages.at(-1)).toMatchObject({
      stopReason: "error",
      errorMessage: "Service unavailable: no healthy upstream",
    });
    expect(h.emitPart).not.toHaveBeenCalled();
  });

  it("cancels Pi's pending backoff without issuing another provider request", async () => {
    const h = await openRuntime(() => assistant("error", "no healthy upstream"), delivery, {
      baseDelayMs: 60_000,
    });
    let retryStarted!: () => void;
    const retry = new Promise<void>((resolve) => {
      retryStarted = resolve;
    });
    h.session.subscribe((event) => {
      if (event.type === "auto_retry_start") retryStarted();
    });
    const pending = h.prompt();
    await retry;
    expect(h.session.isRetrying).toBe(true);
    h.recovery.onAbort();
    h.recovery.cancelResponseRetries();
    await h.session.abort();
    await pending;
    expect(h.base).toHaveBeenCalledOnce();
    expect(h.events).toContainEqual({
      type: "auto_retry_end",
      success: false,
      attempt: 1,
      finalError: "Retry cancelled",
    });
    expect(h.session.isRetrying).toBe(false);
    expect(h.emitPart).not.toHaveBeenCalled();
  });

  it.each(["401 Unauthorized", "insufficient_quota", "Invalid request: no healthy upstream"])(
    "does not retry a nonretryable failure: %s",
    async (error) => {
      const h = await openRuntime(() => assistant("error", error), delivery);
      await h.prompt();
      expect(h.base).toHaveBeenCalledOnce();
      expect(h.session.messages.at(-1)).toMatchObject({ stopReason: "error", errorMessage: error });
      expect(h.events.some((event) => event.type === "auto_retry_start")).toBe(false);
      expect(h.emitPart).not.toHaveBeenCalled();
    },
  );

  it("honors disabled Pi retries", async () => {
    const h = await openRuntime(() => assistant("error", "no healthy upstream"), delivery, {
      enabled: false,
    });
    await h.prompt();
    expect(h.base).toHaveBeenCalledOnce();
    expect(h.events.some((event) => event.type === "auto_retry_start")).toBe(false);
  });

  it("retains completed tools in retry context without executing them again", async () => {
    const h = await openRuntime((attempt) => {
      if (attempt === 1)
        return assistant("toolUse", undefined, [
          { type: "toolCall", id: "record-once", name: "record", arguments: {} },
        ]);
      return attempt <= 3 ? assistant("error", "no healthy upstream") : recovered();
    }, delivery);
    await h.prompt();
    expect(h.base).toHaveBeenCalledTimes(4);
    expect(h.execute).toHaveBeenCalledOnce();
    for (const call of h.base.mock.calls.slice(1)) {
      expect(call[1].messages).toContainEqual(
        expect.objectContaining({ role: "toolResult", toolCallId: "record-once", isError: false }),
      );
      expect(
        call[1].messages.some(
          (message) => message.role === "assistant" && message.stopReason === "error",
        ),
      ).toBe(false);
    }
    expect(h.session.messages.at(-1)).toMatchObject({ stopReason: "stop" });
    expect(h.emitPart).not.toHaveBeenCalled();
  });
});

describe("pinned Pi classifier evidence", () => {
  it("misses the bare gateway wording but recognizes truthful service-unavailable wording", () => {
    expect(isRetryableAssistantError(assistant("error", "no healthy upstream"))).toBe(false);
    expect(
      isRetryableAssistantError(assistant("error", "Service unavailable: no healthy upstream")),
    ).toBe(true);
  });
});

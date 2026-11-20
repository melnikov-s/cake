import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";

/**
 * Runtime startup requires a saved Session model or a Cake default preset (81eb383b); without
 * one, a new Session shows "Choose a model to continue" and never starts its runtime, so
 * extensions, the session_start hook and commands never run.
 */
export interface FixtureModelOptions {
  /** OpenAI-compatible base URL, for example `http://127.0.0.1:1/v1` when never prompted. */
  readonly baseUrl: string;
  readonly provider?: string;
  readonly modelId?: string;
  readonly name?: string;
}

export const fixtureModelPresetId = "00000000-0000-4000-8000-0000000000f1";

/** Writes Pi's models.json with one local OpenAI-compatible model. */
export async function writeFixtureModels(cakeHome: string, options: FixtureModelOptions) {
  const provider = options.provider ?? "fixture";
  const modelId = options.modelId ?? "fixture-model";
  await mkdir(join(cakeHome, "pi"), { recursive: true });
  await writeFile(
    join(cakeHome, "pi", "models.json"),
    JSON.stringify({
      providers: {
        [provider]: {
          baseUrl: options.baseUrl,
          apiKey: "fixture",
          api: "openai-completions",
          models: [
            {
              id: modelId,
              name: options.name ?? "Fixture model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 1_024,
            },
          ],
        },
      },
    }),
  );
  return { provider, modelId };
}

/** Application-state fields that make the fixture model the Cake default preset. */
export function fixtureDefaultPreset(options: Omit<FixtureModelOptions, "baseUrl"> = {}) {
  return {
    modelPresets: [
      {
        id: fixtureModelPresetId,
        name: options.name ?? "Fixture model",
        provider: options.provider ?? "fixture",
        modelId: options.modelId ?? "fixture-model",
        thinkingLevel: "off",
        fastMode: false,
      },
    ],
    defaultModelPresetId: fixtureModelPresetId,
  } as const;
}

/** Session JSONL entry that saves the fixture model on a seeded Session. */
export function fixtureModelChange(
  timestamp: string,
  options: Omit<FixtureModelOptions, "baseUrl"> & { readonly id?: string } = {},
) {
  return {
    type: "model_change",
    id: options.id ?? "model",
    parentId: null,
    timestamp,
    provider: options.provider ?? "fixture",
    modelId: options.modelId ?? "fixture-model",
  } as const;
}

/** One OpenAI-compatible streaming chunk. */
export function fixtureChunk(delta: object, finishReason: string | null = null) {
  return `data: ${JSON.stringify({
    id: "fixture",
    object: "chat.completion.chunk",
    created: 0,
    model: "fixture-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

/** A complete streamed assistant text reply. */
export const fixtureTextReply = (text: string) =>
  fixtureChunk({ role: "assistant", content: text }) +
  fixtureChunk({}, "stop") +
  "data: [DONE]\n\n";

/**
 * Cake utility-model requests (utilityWork.ts): to-do descriptions, titles, labels, session
 * descriptions, worktree names and rewording. They are not chat turns, so fixture servers
 * that count or script assistant turns must route them separately.
 */
export function isUtilityRequest(body: string) {
  return /to-do description|Title this (?:coding-agent session|side chat)|Choose up to three labels|Describe this coding-agent session|Name a Git worktree|Rewrite the supplied JSON/.test(
    body,
  );
}

export interface FixtureModelServerOptions {
  /**
   * Handles a main assistant turn. Return a full SSE body to finish it, or `undefined` to keep
   * the turn streaming until `release()` or close. Defaults to keeping every turn streaming.
   */
  readonly assistant?: (body: string, index: number) => string | undefined;
}

/**
 * Local model server for Sessions that really start. New Sessions also send utility requests
 * that a catch-all handler would mistake for the assistant turn, so those are answered
 * separately: descriptions and labels get neutral replies, titles echo the first request, and
 * other names stay pending.
 */
export async function startFixtureModelServer(options: FixtureModelServerOptions = {}) {
  const held = new Set<ServerResponse>();
  const assistantRequests: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ object: "list", data: [{ id: "fixture-model", object: "model" }] }),
      );
      return;
    }
    let body = "";
    for await (const data of request) body += data;
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (body.includes("to-do description") || body.includes("Describe this coding-agent session")) {
      response.end(fixtureTextReply("Fixture description."));
      return;
    }
    if (body.includes("Choose up to three labels")) {
      response.end(fixtureTextReply("[]"));
      return;
    }
    const firstMessage = /<first_user_message>\n([\s\S]*?)\n<\/first_user_message>/.exec(
      JSON.stringify(JSON.parse(body)).replaceAll("\\n", "\n"),
    )?.[1];
    if (body.includes("Title this") && firstMessage) {
      // Echo the user's request so typed and seeded titles remain stable and predictable.
      response.end(fixtureTextReply(firstMessage));
      return;
    }
    if (isUtilityRequest(body)) {
      // Other names (worktrees, rewording) stay pending.
      held.add(response);
      response.on("close", () => held.delete(response));
      return;
    }
    assistantRequests.push(body);
    const reply = options.assistant?.(body, assistantRequests.length - 1);
    if (reply !== undefined) {
      response.end(reply);
      return;
    }
    held.add(response);
    response.on("close", () => held.delete(response));
    response.write(fixtureChunk({ role: "assistant", content: "" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP server");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    origin: `http://127.0.0.1:${address.port}`,
    assistantRequests,
    /** Ends every held streaming response. */
    release() {
      for (const response of held) response.end(fixtureChunk({}, "stop") + "data: [DONE]\n\n");
      held.clear();
    },
    async close() {
      for (const response of held) response.destroy();
      held.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

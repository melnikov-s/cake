import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultApplicationState } from "../../src/contracts/application/application-data.ts";

/** A real provider HTTP boundary for the compiled app, not a renderer payload injection.
 * No credentials or billed model are used. Capture owns the returned cleanup after Electron closes. */
export async function openRequestInspectorFixture(
  paths: { cakeHome: string; project: string },
  {
    holdResponse = false,
    contextLimitTokens = 300_000,
    beforeResponse,
  }: {
    holdResponse?: boolean;
    contextLimitTokens?: number;
    beforeResponse?: (body: string) => Promise<void>;
  } = {},
) {
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      void respond().catch((error: Error) => response.destroy(error));
    });
    async function respond() {
      await beforeResponse?.(body);
      const chunk = (delta: object, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: "inspection-fixture", object: "chat.completion.chunk", model: "inspection-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (holdResponse) {
        response.flushHeaders();
        return;
      }
      response.end(
        chunk(
          { role: "assistant", content: "Request captured by the local inspection fixture." },
          null,
        ) +
          chunk({}, "stop") +
          "data: [DONE]\n\n",
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No inspection fixture address");
    const provider = "inspection-fixture";
    const modelId = "inspection-fixture";
    const presetId = "00000000-0000-4000-8000-000000000123";
    await writeFile(
      join(paths.cakeHome, "pi", "models.json"),
      JSON.stringify({
        providers: {
          [provider]: {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKey: "local-fixture",
            api: "openai-completions",
            models: [
              {
                id: modelId,
                name: "Inspection fixture",
                reasoning: false,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200000,
                maxTokens: 4096,
              },
            ],
          },
        },
      }),
    );
    await writeFile(
      join(paths.cakeHome, "state", "application.json"),
      JSON.stringify({
        version: 6,
        data: {
          ...defaultApplicationState(),
          projects: [
            {
              path: paths.project,
              name: "visual-capture-project",
              addedAt: new Date(0).toISOString(),
              lastOpenedAt: new Date(0).toISOString(),
            },
          ],
          trustedProjectPaths: [paths.project],
          modelPresets: [
            {
              id: presetId,
              name: "Inspection fixture",
              provider,
              modelId,
              thinkingLevel: "off",
              fastMode: false,
            },
          ],
          defaultModelPresetId: presetId,
          utilityModel: { provider, modelId, thinkingLevel: "off" },
          cakeChatPreferences: {
            contextLimitTokens,
            memoryViewBytes: 4096,
            instructions: "Prefer independent worktrees. Ask before merging changes.",
          },
        },
      }),
    );
    return close;
  } catch (error) {
    await close();
    throw error;
  }
}

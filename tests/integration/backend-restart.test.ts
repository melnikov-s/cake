import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { unexpectedNodeStderr } from "./fixtures/node-stderr";

it.each([
  ["recovery", `recovery-intents/${"a".repeat(64)}.json`],
  ["workers", `private-workers/${"a".repeat(64)}.json`],
  ["coordination", "session-coordination.json"],
])(
  "keeps the production backend available with malformed %s metadata and preserves the evidence",
  async (surface, relativeFile) => {
    const root = await mkdtemp(join(process.cwd(), ".restart-corrupt-test-"));
    try {
      const file = join(root, "state", relativeFile);
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, "{bad json");
      const output = join(root, "restart-check.mjs");
      await exec(process.execPath, [
        "--input-type=module",
        "--eval",
        `import { build } from "esbuild"; import { serverBuildOptions } from "./scripts/build-server.mjs"; await build({ ...serverBuildOptions, entryPoints: ["tests/integration/fixtures/restart-backend.ts"], outfile: ${JSON.stringify(output)} });`,
      ]);
      const result = await exec(process.execPath, [output, "health", surface], {
        env: {
          PATH: process.env.PATH,
          HOME: root,
          CAKE_HOME: root,
          PI_CODING_AGENT_DIR: join(root, "pi"),
          PI_CODING_AGENT_SESSION_DIR: "",
        },
        timeout: 30_000,
      });
      expect(result.stdout).toContain('"marker":"backend-available"');
      expect(result.stdout).toContain(file);
      expect(result.stdout).toContain("Automatic restart recovery is paused");
      expect(await readFile(file, "utf8")).toBe("{bad json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);

const exec = promisify(execFile);
const chunk = (text: string, stop = false) =>
  `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: stop ? "stop" : null }] })}\n\n`;

it.each([
  "clean quit",
  "crash",
  "crash with queue",
  "stopped with queue",
  "report retry",
  "global chat",
  "project chat",
  "uncertain tool",
])(
  "production backend automatically resumes after %s, and the next launch stays idle",
  async (shutdown) => {
    const root = await mkdtemp(join(process.cwd(), ".restart-node-test-"));
    const stoppedWithQueue = shutdown === "stopped with queue";
    const uncertainTool = shutdown === "uncertain tool";
    const hasQueue = shutdown.includes("queue");
    const surface =
      shutdown === "global chat"
        ? "global"
        : shutdown === "project chat"
          ? "project-chat"
          : "project-session";
    let started: () => void = () => undefined;
    const firstRequest = new Promise<void>((resolve) => {
      started = resolve;
    });
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (requests === 1) {
        if (uncertainTool) {
          response.write(
            `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "mutation-call", type: "function", function: { name: "uncertain_mutation", arguments: "{}" } }] }, finish_reason: "tool_calls" }] })}\n\n`,
          );
          response.end("data: [DONE]\n\n");
        } else response.write(chunk("Working"));
        started();
      } else {
        response.write(chunk("Recovered once", true));
        response.end("data: [DONE]\n\n");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture provider address");
    const environment = {
      PATH: process.env.PATH,
      HOME: root,
      CAKE_HOME: root,
      PI_CODING_AGENT_DIR: join(root, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    };
    const output = join(root, "restart-check.mjs");
    let first: ReturnType<typeof spawn> | undefined;
    try {
      await mkdir(join(root, "project", ".pi", "extensions"), { recursive: true });
      await writeFile(
        join(root, "project", ".pi", "extensions", "fixture.ts"),
        `import { appendFileSync } from "node:fs";
        export default function(pi) {
          pi.registerTool({ name: "uncertain_mutation", label: "Uncertain mutation", description: "Fixture tool that changes state before losing its result", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => { appendFileSync(process.env.CAKE_HOME + "/mutation-count", "1"); console.log("restart-fixture-mutated"); return await new Promise(() => {}); } });
          pi.registerProvider("restart-fixture", ${JSON.stringify({
            name: "Restart fixture",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKey: "fixture",
            api: "openai-completions",
            models: [
              {
                id: "fixture",
                name: "Fixture",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 4096,
                maxTokens: 1024,
              },
            ],
          })}); }`,
      );
      await mkdir(join(root, "pi", "extensions"), { recursive: true });
      await copyFile(
        join(root, "project", ".pi", "extensions", "fixture.ts"),
        join(root, "pi", "extensions", "fixture.ts"),
      );
      await exec(process.execPath, [
        "--input-type=module",
        "--eval",
        `import { build } from "esbuild"; import { serverBuildOptions } from "./scripts/build-server.mjs"; await build({ ...serverBuildOptions, entryPoints: ["tests/integration/fixtures/restart-backend.ts"], outfile: ${JSON.stringify(output)} });`,
      ]);
      const child = spawn(
        process.execPath,
        [
          output,
          stoppedWithQueue
            ? "start-stopped"
            : hasQueue
              ? "start-queued"
              : shutdown === "report retry"
                ? "start-report"
                : "start",
          surface,
        ],
        {
          env: environment,
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      first = child;
      let stdout = "";
      let stderr = "";
      const exited = new Promise<{ code: number | null; signal: string | null }>(
        (resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code, signal) => resolve({ code, signal }));
        },
      );
      const accepted = new Promise<void>((resolve, reject) => {
        child.stdout?.on("data", (data: Buffer) => {
          stdout += data.toString();
          if (stdout.includes("restart-fixture-accepted")) resolve();
        });
        child.stderr?.on("data", (data: Buffer) => {
          stderr += data.toString();
        });
        child.once("exit", () => {
          if (!stdout.includes("restart-fixture-accepted"))
            reject(new Error(`Fixture exited before admission: ${stdout}\n${stderr}`));
        });
      });
      await accepted;
      await firstRequest;
      if (uncertainTool && !stdout.includes("restart-fixture-mutated"))
        await new Promise<void>((resolve) =>
          child.stdout?.on("data", () => {
            if (stdout.includes("restart-fixture-mutated")) resolve();
          }),
        );
      if (stoppedWithQueue) {
        const stopped = new Promise<void>((resolve) =>
          child.stdout?.on("data", () => {
            if (stdout.includes("restart-fixture-stopped")) resolve();
          }),
        );
        child.send("stop");
        await stopped;
        child.send("quit");
      } else if (shutdown === "clean quit") child.send("quit");
      else child.kill("SIGKILL");
      const exit = await exited;
      expect(exit).toEqual(
        shutdown === "clean quit" || stoppedWithQueue
          ? { code: 0, signal: null }
          : { code: null, signal: "SIGKILL" },
      );
      expect(unexpectedNodeStderr(stderr)).toBe("");
      if (stoppedWithQueue) {
        const paused = await exec(process.execPath, [output, "inspect-stopped", surface], {
          env: environment,
          timeout: 30_000,
        });
        expect(paused.stdout).toContain(
          '"state":"stopped","inputs":1,"streaming":false,"outcome":"aborted","unread":false',
        );
        expect(requests).toBe(1);
      }
      if (uncertainTool) {
        const blocked = await exec(process.execPath, [output, "inspect-blocked", surface], {
          env: environment,
          timeout: 30_000,
        });
        expect(blocked.stdout).toContain(
          '"state":"blocked","recoveryIssue":true,"inputs":1,"streaming":false',
        );
        expect(requests).toBe(1);
        expect(await readFile(join(root, "mutation-count"), "utf8")).toBe("1");
      }
      const recovered = await exec(
        process.execPath,
        [
          output,
          stoppedWithQueue || uncertainTool ? "continue" : hasQueue ? "recover-queued" : "recover",
          surface,
        ],
        {
          env: environment,
          timeout: 30_000,
        },
      );
      expect(recovered.stdout).toContain(
        `"state":"complete","inputs":0,"streaming":false,"outcome":"complete","unread":${surface === "project-session"}`,
      );
      expect(requests).toBe(hasQueue ? 3 : 2);
      expect(recovered.stdout).toContain(
        `"users":${stoppedWithQueue ? 3 : hasQueue || uncertainTool ? 2 : 1}`,
      );
      const again = await exec(
        process.execPath,
        [output, shutdown === "report retry" ? "inspect-duplicate" : "inspect", surface],
        {
          env: environment,
          timeout: 30_000,
        },
      );
      expect(again.stdout).toContain(
        `"state":"complete","inputs":0,"streaming":false,"outcome":"complete","unread":${surface === "project-session"}`,
      );
      expect(requests).toBe(hasQueue ? 3 : 2);
      if (uncertainTool) expect(await readFile(join(root, "mutation-count"), "utf8")).toBe("1");
    } finally {
      if (first && first.exitCode === null && first.signalCode === null) first.kill("SIGKILL");
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  90_000,
);

import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { unexpectedNodeStderr } from "./fixtures/node-stderr";

const exec = promisify(execFile);
const chunk = (text: string, stop = false) =>
  `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: stop ? "stop" : null }] })}\n\n`;

it.each([
  ["worker-global", "clean quit"],
  ["worker-global", "crash"],
  ["worker-project", "crash"],
  ["worker-global", "uncertain tool"],
  ["worker-project", "busy parent report"],
])(
  "restores %s after %s with the same handle, transcript and exact grants",
  async (surface, shutdown) => {
    const root = await mkdtemp(join(process.cwd(), ".worker-restart-test-"));
    let started: () => void = () => undefined;
    const workerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let requests = 0;
    let workerRequests = 0;
    let parentHeld = false;
    let finishWorker = () => {};
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (data: Buffer) => {
        body += data.toString();
      });
      request.on("end", () => {
        requests++;
        response.writeHead(200, { "content-type": "text/event-stream" });
        // Utility-model title/summarization requests can interleave with work.
        // Identify the worker, never assume the second HTTP request is its turn.
        const workerRequest =
          body.includes("You are a lightweight agent handling one delegated task.") ||
          body.includes("You are a hidden, temporary project investigator reporting to Cake Chat.");
        const busyParent = body.includes("Keep the parent busy while the worker completes");
        if (workerRequest && ++workerRequests === 1) {
          if (shutdown === "uncertain tool") {
            response.write(
              `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "mutation-call", type: "function", function: { name: "uncertain_mutation", arguments: "{}" } }] }, finish_reason: "tool_calls" }] })}\n\n`,
            );
            response.end("data: [DONE]\n\n");
          } else {
            response.write(chunk("Working on private evidence"));
            finishWorker = () => {
              response.write(chunk("Worker finished", true));
              response.end("data: [DONE]\n\n");
            };
          }
          started();
        } else if (shutdown === "busy parent report" && busyParent && !parentHeld) {
          parentHeld = true;
          response.write(chunk("Parent is busy"));
          finishWorker();
        } else {
          response.write(
            chunk(
              busyParent || workerRequest || workerRequests > 0 ? "Recovered once" : "Parent ready",
              true,
            ),
          );
          response.end("data: [DONE]\n\n");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing provider address");
    const environment = {
      PATH: process.env.PATH,
      HOME: root,
      CAKE_HOME: root,
      PI_CODING_AGENT_DIR: join(root, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    };
    const output = join(root, "restart-check.mjs");
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await mkdir(join(root, "pi", "extensions"), { recursive: true });
      await writeFile(
        join(root, "pi", "extensions", "fixture.ts"),
        `import { appendFileSync } from "node:fs"; export default function(pi) { pi.registerTool({ name: "uncertain_mutation", label: "Uncertain mutation", description: "Changes state before losing its result", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => { appendFileSync(process.env.CAKE_HOME + "/mutation-count", "1"); console.log("restart-fixture-mutated"); return await new Promise(() => {}); } }); pi.registerProvider("restart-fixture", ${JSON.stringify({ name: "Restart fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture", api: "openai-completions", models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 1024 }] })}); }`,
      );
      await exec(process.execPath, [
        "--input-type=module",
        "--eval",
        `import { build } from "esbuild"; import { serverBuildOptions } from "./scripts/build-server.mjs"; await build({ ...serverBuildOptions, entryPoints: ["tests/integration/fixtures/restart-backend.ts"], outfile: ${JSON.stringify(output)} });`,
      ]);
      const first = spawn(
        process.execPath,
        [output, shutdown === "busy parent report" ? "start-busy-report" : "start", surface],
        {
          env: environment,
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          timeout: 30_000,
          killSignal: "SIGKILL",
        },
      );
      child = first;
      let stdout = "";
      let stderr = "";
      const exited = new Promise<{ code: number | null; signal: string | null }>(
        (resolve, reject) => {
          first.once("error", reject);
          first.once("exit", (code, signal) => resolve({ code, signal }));
        },
      );
      const accepted = new Promise<void>((resolve, reject) => {
        first.stdout?.on("data", (data: Buffer) => {
          stdout += data.toString();
          if (stdout.includes("restart-fixture-accepted")) resolve();
        });
        first.stderr?.on("data", (data: Buffer) => {
          stderr += data.toString();
        });
        first.once("exit", () => {
          if (!stdout.includes("restart-fixture-accepted"))
            reject(new Error(`Worker fixture exited before admission: ${stdout}\n${stderr}`));
        });
      });
      await accepted;
      await Promise.race([
        workerStarted,
        exited.then(() => {
          throw new Error(`Worker exited before starting: ${stdout}\n${stderr}`);
        }),
      ]);
      if (shutdown === "uncertain tool" && !stdout.includes("restart-fixture-mutated"))
        await new Promise<void>((resolve) =>
          first.stdout?.on("data", () => {
            if (stdout.includes("restart-fixture-mutated")) resolve();
          }),
        );
      const workerDirectory = join(root, "state", "private-workers");
      const name = (await readdir(workerDirectory)).find((file) => file.endsWith(".json"));
      if (!name) throw new Error("Worker metadata is missing");
      const workerFile = join(workerDirectory, name);
      const before = { data: [JSON.parse(await readFile(workerFile, "utf8")).data] };
      expect(before.data).toHaveLength(1);
      const identity = {
        handleId: before.data[0].handleId,
        privateSessionId: before.data[0].privateSessionId,
      };
      expect(before.data[0].pendingInputs).toHaveLength(shutdown === "busy parent report" ? 0 : 1);
      if (shutdown === "busy parent report") {
        expect(stdout).toContain("restart-fixture-report-pending");
        expect(before.data[0].completionDisposition).toBe("notifying");
      }
      expect(before.data[0].parts).toBeUndefined();
      if (shutdown === "clean quit") first.send("quit");
      else first.kill("SIGKILL");
      expect(await exited).toEqual(
        shutdown === "clean quit" ? { code: 0, signal: null } : { code: null, signal: "SIGKILL" },
      );
      expect(unexpectedNodeStderr(stderr)).toBe("");
      const recovered = await exec(
        process.execPath,
        [output, shutdown === "uncertain tool" ? "inspect-blocked" : "recover", surface],
        { env: environment, timeout: 30_000 },
      );
      expect(unexpectedNodeStderr(recovered.stderr)).toBe("");
      const result = JSON.parse(
        recovered.stdout
          .split("\n")
          .find((line) => line.includes('"marker":"private-worker-result"')) ?? "null",
      );
      expect(result).toMatchObject({
        ...identity,
        status: shutdown === "uncertain tool" ? "error" : "complete",
        disposition: "notified",
        inputs: 0,
        users: 1,
        attachmentReadable: true,
        messageReadable: true,
        unforwardedDenied: true,
      });
      // Pi Durable can also summarize earlier messages through the utility model.
      const expectedRequests = requests;
      if (shutdown === "busy parent report") expect(workerRequests).toBe(1);
      expect(requests).toBeGreaterThanOrEqual(shutdown === "uncertain tool" ? 3 : 4);
      // Simulate a crash after the parent durably received the report but before the worker
      // recorded its acknowledgement. Stable completion IDs must suppress a second report.
      const saved = JSON.parse(await readFile(workerFile, "utf8"));
      saved.data.completionDisposition = "notifying";
      await writeFile(workerFile, JSON.stringify(saved));
      const again = await exec(
        process.execPath,
        [output, shutdown === "uncertain tool" ? "inspect-blocked" : "inspect", surface],
        { env: environment, timeout: 30_000 },
      );
      expect(again.stdout).toContain(
        `"status":"${shutdown === "uncertain tool" ? "error" : "complete"}","disposition":"notified"`,
      );
      expect(requests).toBe(expectedRequests);
      if (shutdown === "uncertain tool") {
        expect(await readFile(join(root, "mutation-count"), "utf8")).toBe("1");
        await exec(process.execPath, [output, "continue-worker", surface], {
          env: environment,
          timeout: 30_000,
        });
        expect(requests).toBeGreaterThan(expectedRequests);
        expect(await readFile(join(root, "mutation-count"), "utf8")).toBe("1");
      }
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  90_000,
);

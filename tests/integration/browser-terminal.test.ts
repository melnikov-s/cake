import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium, expect as browserExpect } from "@playwright/test";
import { Deferred, Effect, Queue, Stream } from "effect";
import { beforeAll, expect, it } from "vitest";
import { openNetworkListener } from "../../src/server/NetworkListener";
import * as cakeChatLocations from "../../src/domain/cake-chats/cakeChatLocations";
import type { TerminalEvent } from "../../src/services/terminal/Terminal";
import { makeNetworkTestBackend } from "./fixtures/network-backend";
import { browserBackendAdapter, browserTestModel } from "./fixtures/browser-backend";

beforeAll(async () => {
  await promisify(execFile)(process.execPath, ["scripts/build-server.mjs"]);
  await promisify(execFile)(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "build", "--config", "vite.browser.config.ts"],
    { maxBuffer: 4 * 1024 * 1024 },
  );
}, 60_000);

it("opens a socket-owned browser terminal, accepts input/output and never replays it after reconnect", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "cake-browser-terminal-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      const projectPath = join(root, "project");
      yield* Effect.promise(() => mkdir(projectPath));
      const controlled = browserBackendAdapter(projectPath, true);
      const allowSubscription = yield* Deferred.make<void>();
      const owners = new Map<number, Queue.Queue<TerminalEvent>>();
      const processes = new Map<string, number>();
      const writes: string[] = [];
      let opens = 0;
      let closedOwners = 0;
      const backend = yield* makeNetworkTestBackend({
        adapter: controlled.adapter,
        models: [browserTestModel],
        projectPath,
        terminal: {
          events: (owner) =>
            Stream.unwrap(
              Effect.gen(function* () {
                yield* Deferred.await(allowSubscription);
                const queue = yield* Queue.unbounded<TerminalEvent>();
                owners.set(owner, queue);
                return Stream.concat(
                  Stream.succeed({
                    type: "renderer-events-ready" as const,
                    channel: "terminals" as const,
                  }),
                  Stream.fromQueue(queue),
                );
              }),
            ),
          open: (owner, target) =>
            Effect.gen(function* () {
              assert.equal(target.workingDirectory, projectPath);
              const terminalId = crypto.randomUUID();
              opens++;
              processes.set(terminalId, owner);
              const queue = owners.get(owner);
              if (queue)
                yield* Queue.offer(queue, {
                  type: "terminal-data",
                  terminalId,
                  data: `shell-${opens}> `,
                });
              return { terminalId, shell: "test-shell" };
            }),
          write: (owner, terminalId, data) =>
            Effect.gen(function* () {
              assert.equal(processes.get(terminalId), owner);
              writes.push(data);
              const queue = owners.get(owner);
              if (queue) yield* Queue.offer(queue, { type: "terminal-data", terminalId, data });
            }),
          resize: (owner, terminalId) =>
            Effect.sync(() => {
              assert.equal(processes.get(terminalId), owner);
            }),
          close: (owner, terminalId) =>
            Effect.sync(() => {
              assert.equal(processes.get(terminalId), owner);
              processes.delete(terminalId);
            }),
          closeOwner: (owner) =>
            Effect.sync(() => {
              closedOwners++;
              owners.delete(owner);
              for (const [id, processOwner] of processes)
                if (processOwner === owner) processes.delete(id);
            }),
          runningProgramCount: () => Effect.succeed(0),
        },
      });
      const listener = yield* openNetworkListener(
        { port: 0, browserAssetsDirectory: resolve("out/browser") },
        {
          homeDirectory: "/home/test",
          cakeChat: {
            agentDirectory: "/agent",
            location: cakeChatLocations.make({
              homeDirectory: "/home/test",
              sessionDirectory: "/chat",
              resolvedSessionDirectory: "/chat-resolved",
            }),
          },
        },
      ).pipe(Effect.provideContext(backend.context));
      if (listener.address._tag !== "TcpAddress") throw new Error("Expected TCP listener");
      const port = listener.address.port;
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ channel: "chromium-headless-shell" })),
        (instance) => Effect.promise(() => instance.close()),
      );
      const page = yield* Effect.promise(() => browser.newPage());
      page.setDefaultTimeout(5_000);
      yield* Effect.promise(async () => {
        await page.goto(`http://127.0.0.1:${port}`);
        await page
          .locator(`[data-slot="sidebar"] [data-session-id="${controlled.existingId}"]`)
          .last()
          .click();
        const toggle = page.getByRole("button", { name: "Terminal", exact: true }).first();
        await browserExpect(toggle).toBeDisabled();
        expect(opens).toBe(0);
        await Effect.runPromise(Deferred.succeed(allowSubscription, undefined));
        await browserExpect(toggle).toBeEnabled();
        await toggle.click();
        const terminal = page.locator(".xterm-screen");
        await browserExpect(terminal).toContainText("shell-1>");
        await page.locator(".xterm-helper-textarea").focus();
        await page.keyboard.type("echo browser");
        await browserExpect(terminal).toContainText("echo browser");
        expect(writes.join("")).toBe("echo browser");
        expect(opens).toBe(1);
        await page.reload();
        await browserExpect.poll(() => closedOwners).toBeGreaterThan(0);
        await page
          .locator(`[data-slot="sidebar"] [data-session-id="${controlled.existingId}"]`)
          .last()
          .click();
        expect(opens).toBe(1);
        expect(writes.join("")).toBe("echo browser");
        await page.getByRole("button", { name: "Terminal", exact: true }).first().click();
        await browserExpect(page.locator(".xterm-screen")).toContainText("shell-2>");
        expect(opens).toBe(2);
        expect(writes.join("")).toBe("echo browser");
      });
    }).pipe(Effect.scoped),
  );
}, 90_000);

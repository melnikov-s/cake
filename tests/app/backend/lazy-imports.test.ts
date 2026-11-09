import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("real module loading and listener acquisition follow demand, including cold first-use cost", async () => {
  const root = resolve(import.meta.dirname, "../../..");
  const directory = await mkdtemp(join(tmpdir(), "cake-lazy-imports-"));
  try {
    await symlink(join(root, "node_modules"), join(directory, "node_modules"), "dir");
    await build({
      absWorkingDir: root,
      stdin: {
        contents: `
        export { LocalMcpServer } from './src/services/local-mcp/LocalMcpServer';
        export { makeCakeChatDurableLive, CakeChatDurable } from './src/services/pi-durable/CakeChatDurable';
        export { createCoordinatorRuntime } from './src/layers/CakeOperations';
      `,
        resolveDir: root,
      },
      outdir: directory,
      entryNames: "probe",
      outExtension: { ".js": ".mjs" },
      bundle: true,
      splitting: true,
      platform: "node",
      format: "esm",
      packages: "external",
      loader: { ".md": "text" },
    });
    const runner = join(directory, "runner.mjs");
    await writeFile(
      runner,
      `
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      const loaded = [];
      registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context); } });
      const graphStart = performance.now();
      const { LocalMcpServer, makeCakeChatDurableLive, CakeChatDurable, createCoordinatorRuntime } = await import('./probe.mjs');
      const graphMs = performance.now() - graphStart;
      assert.equal(typeof createCoordinatorRuntime, 'function');
      const durableLoaded = () => loaded.some(url => /pi-durable[@/]/.test(url));
      const listenerLoaded = () => loaded.some(url => url.includes('LocalMcpListener-'));
      assert.equal(durableLoaded(), false, 'durable SDK was pulled back into the eager graph');
      assert.equal(listenerLoaded(), false, 'MCP listener was imported eagerly');
      const { Effect, Layer } = await import('effect');
      let factoryCalls = 0;
      const durable = makeCakeChatDurableLive(async () => { factoryCalls++; throw new Error('unexpected runtime demand'); }, () => { throw new Error('unexpected side chat'); });
      const endpoint = { tools: [], call: async () => ({ content: [] }) };
      const samples = {};
      let url;
      await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const server = yield* LocalMcpServer;
        const chats = yield* CakeChatDurable;
        yield* server.configure(undefined);
        assert.equal((yield* server.get()).status, 'disabled');
        assert.equal(listenerLoaded(), false);
        assert.equal(durableLoaded(), false);
        const before = performance.now();
        const first = yield* server.configure({ port: 0, token: 'isolated-fixture', endpoint });
        samples.firstListenerMs = performance.now() - before;
        assert.equal(first.status, 'serving', JSON.stringify(first));
        url = first.url;
        assert.equal(listenerLoaded(), true);
        assert.equal((yield* Effect.promise(() => fetch(url))).status, 401);
        yield* server.configure(undefined);
        const again = performance.now();
        const second = yield* server.configure({ port: 0, token: 'isolated-fixture', endpoint });
        assert.equal(second.status, 'serving');
        url = second.url;
        samples.warmListenerMs = performance.now() - again;
        const catalogStart = performance.now();
        const entries = yield* Effect.all([chats.catalogEntry(${JSON.stringify(join(directory, "absent-chat"))}), chats.catalogEntry(${JSON.stringify(join(directory, "absent-chat"))})], { concurrency: 'unbounded' });
        samples.firstCatalogMs = performance.now() - catalogStart;
        assert.deepEqual(entries, [undefined, undefined]);
        assert.equal(durableLoaded(), true);
        assert.equal(factoryCalls, 0);
        const catalogAgain = performance.now();
        yield* chats.catalogEntry(${JSON.stringify(join(directory, "absent-chat"))});
        samples.warmCatalogMs = performance.now() - catalogAgain;
      }).pipe(Effect.provide(Layer.merge(LocalMcpServer.layer, durable)))));
      await assert.rejects(fetch(url));
      const moduleCounts = new Map();
      for (const url of loaded) moduleCounts.set(url, (moduleCounts.get(url) ?? 0) + 1);
      assert.ok([...moduleCounts].filter(([url]) => /pi-durable[@/]|LocalMcpListener-/.test(url)).every(([, count]) => count === 1), 'concurrent cold demand loaded a module more than once');
      console.log(JSON.stringify({ graphMs, ...samples, factoryCalls }));
    `,
    );
    const result = spawnSync(process.execPath, [runner], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    console.info(
      "Isolated real module/listener demand (not end-to-end desktop)",
      result.stdout.trim(),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 45_000);

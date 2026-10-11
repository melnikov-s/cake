import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { openNetworkListener } from "../../src/server/NetworkListener";
import { loadBrowserAssets } from "../../src/server/browserAssets";
import * as cakeChatLocations from "../../src/domain/cake-chats/cakeChatLocations";
import { makeNetworkTestBackend } from "./fixtures/network-backend";

it("serves only the bounded browser build with HTTP authority checks and correct content types", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-browser-assets-"));
  try {
    await mkdir(join(directory, "assets"));
    await writeFile(join(directory, "index.html"), "<!doctype html><title>Cake</title>");
    await writeFile(join(directory, "assets", "chat-123.js"), "export {};");
    await writeFile(join(directory, "assets", "chat-123.js.map"), "secret map");
    await writeFile(join(directory, "secret.json"), "secret data");
    await mkdir(join(directory, "excalidraw", "fonts", "Excalifont"), { recursive: true });
    await writeFile(
      join(directory, "excalidraw", "configure-fonts.js"),
      "window.EXCALIDRAW_ASSET_PATH = '/excalidraw/';",
    );
    await writeFile(
      join(directory, "excalidraw", "fonts", "Excalifont", "regular.woff2"),
      "font bytes",
    );
    await writeFile(join(directory, "excalidraw", "configure-fonts.js.map"), "private source map");
    await writeFile(join(directory, "excalidraw", "unrelated.js"), "private script");
    await writeFile(
      join(directory, "excalidraw", "fonts", "Excalifont", "private.js"),
      "private script",
    );
    await symlink(
      join(directory, "secret.json"),
      join(directory, "excalidraw", "fonts", "linked.woff2"),
    );
    await symlink(join(directory, "secret.json"), join(directory, "assets", "symlink.js"));
    await Effect.runPromise(
      Effect.gen(function* () {
        const backend = yield* makeNetworkTestBackend();
        const listener = yield* openNetworkListener(
          { port: 0, browserAssetsDirectory: directory },
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
        assert.equal(listener.address._tag, "TcpAddress");
        const port = listener.address.port;
        assert.ok(listener.editorPort);
        const get = (
          path: string,
          headers: Record<string, string> | string[] = {},
          method = "GET",
        ) =>
          new Promise<{
            status: number | undefined;
            type: string | undefined;
            body: string;
            csp: string | string[] | undefined;
          }>((resolve, reject) => {
            const req = request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
              let body = "";
              res.setEncoding("utf8");
              res.on("data", (chunk: string) => {
                body += chunk;
              });
              res.on("end", () =>
                resolve({
                  status: res.statusCode,
                  type: res.headers["content-type"],
                  body,
                  csp: res.headers["content-security-policy"],
                }),
              );
            });
            req.on("error", reject);
            req.end();
          });
        yield* Effect.promise(async () => {
          expect(await get("/")).toMatchObject({
            status: 200,
            type: "text/html; charset=utf-8",
            body: "<!doctype html><title>Cake</title>",
            csp: expect.stringContaining(
              `frame-src 'self' blob: http://127.0.0.1:${listener.editorPort};`,
            ),
          });
          expect(await get("/assets/chat-123.js")).toMatchObject({
            status: 200,
            type: "text/javascript; charset=utf-8",
            body: "export {};",
          });
          expect(await get("/excalidraw/configure-fonts.js")).toMatchObject({
            status: 200,
            type: "text/javascript; charset=utf-8",
            body: "window.EXCALIDRAW_ASSET_PATH = '/excalidraw/';",
          });
          expect(await get("/excalidraw/fonts/Excalifont/regular.woff2")).toMatchObject({
            status: 200,
            type: "font/woff2",
            body: "font bytes",
          });
          expect(await get("/", {}, "HEAD")).toMatchObject({ status: 200, body: "" });
          expect((await get("/", {}, "POST")).status).toBe(405);
          for (const path of [
            "/../secret.json",
            "/assets/../secret.json",
            "/assets/%2e%2e/secret.json",
            "/assets/%2fsecret.json",
            "/secret.json",
            "/assets/chat-123.js.map",
            "/assets/symlink.js",
            "/excalidraw/configure-fonts.js.map",
            "/excalidraw/unrelated.js",
            "/excalidraw/fonts/Excalifont/private.js",
            "/excalidraw/fonts/linked.woff2",
            "/excalidraw/fonts/../configure-fonts.js",
            "/excalidraw/fonts/%2e%2e/configure-fonts.js",
            "/excalidraw/fonts/%2fExcalifont/regular.woff2",
            "/excalidraw/fonts/Excalifont/regular.woff2?file=secret.json",
            "/missing",
            "/?file=secret.json",
          ])
            expect((await get(path)).status, path).toBe(404);
          expect((await get("/", { Host: "evil.example" })).status).toBe(403);
          expect((await get("/", { Origin: "https://evil.example" })).status).toBe(403);
          expect((await get("/", { Origin: `http://127.0.0.1:${port}` })).status).toBe(200);
          expect(
            (
              await get("/", [
                "Host",
                `127.0.0.1:${port}`,
                "Origin",
                `http://127.0.0.1:${port}`,
                "Origin",
                "https://evil.example",
              ])
            ).status,
          ).toBe(403);
          expect(
            (await get("/", ["Host", `127.0.0.1:${port}`, "Host", "evil.example"])).status,
          ).toBe(403);
        });
        yield* listener.close();
        expect(backend.stats.backendClosed).toBe(false);
      }).pipe(Effect.scoped),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects an Excalidraw asset directory escaping the browser build", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-browser-asset-escape-"));
  const outside = await mkdtemp(join(tmpdir(), "cake-browser-outside-"));
  try {
    await mkdir(join(directory, "assets"));
    await writeFile(join(directory, "index.html"), "Cake");
    await writeFile(join(outside, "configure-fonts.js"), "private external bytes");
    await symlink(outside, join(directory, "excalidraw"));
    await expect(Effect.runPromise(loadBrowserAssets(directory))).rejects.toThrow(
      "Browser asset escapes its build directory",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

it("applies the existing per-asset bound to nested Excalidraw fonts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-browser-font-bound-"));
  try {
    await mkdir(join(directory, "assets"));
    await mkdir(join(directory, "excalidraw", "fonts", "Excalifont"), { recursive: true });
    await writeFile(join(directory, "index.html"), "Cake");
    await writeFile(
      join(directory, "excalidraw", "fonts", "Excalifont", "large.woff2"),
      Buffer.alloc(32 * 1024 * 1024 + 1),
    );
    await expect(Effect.runPromise(loadBrowserAssets(directory))).rejects.toThrow(
      "Browser build exceeds asset limits",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("missing entry/build fails explicitly rather than exposing another directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-browser-missing-"));
  try {
    await expect(Effect.runPromise(loadBrowserAssets(directory))).rejects.toThrow(
      "Cannot load browser build",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

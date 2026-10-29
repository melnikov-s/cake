import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { chromium, expect as browserExpect } from "@playwright/test";
import { Effect } from "effect";
import { expect } from "vitest";
import * as cakeChatLocations from "../../src/domain/cake-chats/cakeChatLocations";
import { openNetworkListener } from "../../src/server/NetworkListener";
import { makeGoogleRemoteAccess } from "../../src/services/remote-access/GoogleRemoteAccess";
import {
  publishInlineWidget,
  revokeInlineWidget,
} from "../../src/services/widgets/inline-widget-document-registry";
import { compileInlineWidget } from "../../src/services/widgets/inline-widget-service";
import { makeNetworkTestBackend } from "./fixtures/network-backend";

// Deliberately preserve browser Host, Origin and cookies, including for upgrades.
// The only optional mutation recreates the old widget response, not an auth bypass.
async function httpsProxy() {
  const [key, cert] = await Promise.all([
    readFile(join(import.meta.dirname, "fixtures/preview-localhost.key")),
    readFile(join(import.meta.dirname, "fixtures/preview-localhost.crt")),
  ]);
  let port = 0;
  let stripSandbox = false;
  const proxy = createHttpsServer({ key, cert }, (incoming, outgoing) => {
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: incoming.url,
        method: incoming.method,
        headers: incoming.headers,
      },
      (response) => {
        const headers = { ...response.headers };
        if (stripSandbox && incoming.url?.startsWith("/widget-assets/document/")) {
          const csp = headers["content-security-policy"];
          if (typeof csp === "string")
            headers["content-security-policy"] = csp
              .split(";")
              .filter((directive) => !/^\s*sandbox\b/.test(directive))
              .join(";");
        }
        outgoing.writeHead(response.statusCode ?? 502, headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => outgoing.destroy());
    incoming.pipe(upstream);
  });
  const tunnels = new Set<ReturnType<typeof connect>>();
  proxy.on("upgrade", (incoming, socket, head) => {
    const upstream = connect(port, "127.0.0.1");
    tunnels.add(upstream);
    upstream.once("connect", () => {
      upstream.write(
        `${incoming.method} ${incoming.url} HTTP/${incoming.httpVersion}\r\n${incoming.rawHeaders.map((value, index) => `${value}${index % 2 ? "\r\n" : ": "}`).join("")}\r\n`,
      );
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => {
      socket.destroy();
      tunnels.delete(upstream);
    });
  });
  await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
  const address = proxy.address();
  assert.ok(address && typeof address !== "string");
  return {
    origin: `https://127.0.0.1:${address.port}`,
    route: (backendPort: number) => {
      port = backendPort;
    },
    stripSandbox: (enabled: boolean) => {
      stripSandbox = enabled;
    },
    close: async () => {
      for (const tunnel of tunnels) tunnel.destroy();
      proxy.closeAllConnections();
      await new Promise<void>((done) => proxy.close(() => done()));
    },
  };
}

// Run the same probes in an approved host, an old-style top-level widget, and
// a sandboxed top-level widget. A broken cookie/proxy/RPC cannot look like a fix.
const authorityProbe = `
(async () => {
  const origin = new URL(location.href).origin;
  const data = fetch(origin + "/assets/private.js", { credentials: "include" })
    .then(response => response.ok ? response.text() : "denied", () => "denied");
  const rpc = new Promise(resolve => {
    const socket = new WebSocket(origin.replace("https:", "wss:") + "/rpc");
    socket.onopen = () => socket.send(JSON.stringify({
      _tag: "Request", id: "1", tag: "application.getHomeDirectory", payload: null, headers: []
    }));
    socket.onmessage = event => { resolve(event.data); socket.close(); };
    socket.onerror = socket.onclose = () => resolve("denied");
  });
  document.body.dataset.authority = JSON.stringify(await Promise.all([data, rpc]));
})();`;

const widgetSource = `<button id="save">Save count</button><output id="state">Loading</output>
<script>
  ${authorityProbe}
  cakeArtifact.subscribe(() => {
    const state = cakeArtifact.getSnapshot();
    document.querySelector("#state").textContent = state.version + ":" + state.value?.count;
  });
  document.querySelector("#save").onclick = async () => {
    const state = cakeArtifact.getSnapshot();
    await cakeArtifact.replace({ count: state.value.count + 1 }, state.version);
  };
</script>`;

// Controlled host boundary, using the production compiler's artifact bridge and
// wire protocol. This is not a replacement for renderer Store/component tests.
function hostScript(token: string) {
  return `${authorityProbe}
const token = ${JSON.stringify(token)};
const frame = document.querySelector("iframe");
let state = { version: 1, value: { count: 0 } };
document.body.dataset.saves = "0";
addEventListener("message", event => {
  const message = event.data;
  if (event.source !== frame.contentWindow || message?.source !== "cake-inline-widget" || message.token !== token) return;
  if (message.type !== "artifact-state-read" && message.type !== "artifact-state-replace") return;
  if (message.type === "artifact-state-replace") {
    if (message.value.expectedVersion !== state.version) throw new Error("Unexpected state version");
    state = { version: state.version + 1, value: message.value.value };
    document.body.dataset.saves = String(Number(document.body.dataset.saves) + 1);
  }
  frame.contentWindow.postMessage({
    source: "cake-artifact-host", token, type: "state-result",
    value: { id: message.value.id, ok: true, state }
  }, "*");
});
frame.src = "/widget-assets/document/" + token;`;
}

it.live(
  "isolates authenticated direct widget navigation while preserving the embedded artifact bridge",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "cake-widget-sandbox-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      const compiled = yield* Effect.promise(() =>
        compileInlineWidget("html", widgetSource, "artifact"),
      );
      publishInlineWidget(compiled);
      yield* Effect.addFinalizer(() => Effect.sync(() => revokeInlineWidget(compiled.token)));
      yield* Effect.promise(async () => {
        await mkdir(join(directory, "assets"));
        await writeFile(
          join(directory, "index.html"),
          '<!doctype html><body><iframe title="Artifact" sandbox="allow-scripts allow-downloads"></iframe><script src="/assets/host.js"></script>',
        );
        await writeFile(join(directory, "assets/host.js"), hostScript(compiled.token));
        await writeFile(join(directory, "assets/private.js"), "authenticated Cake data");
      });
      const proxy = yield* Effect.acquireRelease(Effect.promise(httpsProxy), (value) =>
        Effect.promise(() => value.close()),
      );
      let nonce = "";
      const auth = makeGoogleRemoteAccess({
        clientId: "widget-test.apps.googleusercontent.com",
        origin: proxy.origin,
        allowedEmails: ["owner@example.com"],
        verifyIdentity: async (credential) => {
          assert.equal(credential, "test-credential");
          return { sub: "test-owner", email: "owner@example.com", email_verified: true, nonce };
        },
        bindAccount: async () => {},
      });
      const backend = yield* makeNetworkTestBackend();
      const listener = yield* openNetworkListener(
        {
          port: 0,
          bind: "127.0.0.1",
          browserAssetsDirectory: directory,
          allowedHosts: [new URL(proxy.origin).host],
          allowedOrigins: [proxy.origin],
        },
        {
          homeDirectory: directory,
          cakeChat: {
            agentDirectory: directory,
            location: cakeChatLocations.make({
              homeDirectory: directory,
              sessionDirectory: directory,
            }),
          },
        },
        undefined,
        auth,
      ).pipe(Effect.provideContext(backend.context));
      assert.equal(listener.address._tag, "TcpAddress");
      proxy.route(listener.address.port);
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ channel: "chromium-headless-shell" })),
        (value) => Effect.promise(() => value.close()),
      );
      yield* Effect.promise(async () => {
        const context = await browser.newContext({ ignoreHTTPSErrors: true });
        try {
          const widgetUrl = `${proxy.origin}/widget-assets/document/${compiled.token}`;
          expect((await context.request.get(widgetUrl)).status()).toBe(401);
          const login = await context.request.get(`${proxy.origin}/auth/login`);
          expect(login.status()).toBe(200);
          const match = /data-nonce="([a-zA-Z0-9_-]+)"/.exec(await login.text());
          assert.ok(match?.[1]);
          nonce = match[1];
          await context.addCookies([
            { name: "g_csrf_token", value: "test-csrf", url: proxy.origin },
          ]);
          const callback = await context.request.post(`${proxy.origin}/auth/google/callback`, {
            headers: { Origin: "https://accounts.google.com" },
            form: { credential: "test-credential", g_csrf_token: "test-csrf" },
            maxRedirects: 0,
          });
          expect(callback.status()).toBe(303);
          expect(
            (await context.cookies()).find((cookie) => cookie.name === "__Host-cake-session"),
          ).toMatchObject({ secure: true, httpOnly: true, sameSite: "Lax" });

          const page = await context.newPage();
          page.setDefaultTimeout(10_000);
          // Negative control: stripping only the response sandbox reproduces the
          // original authority leak, without changing the shared source checkout.
          proxy.stripSandbox(true);
          expect((await page.goto(widgetUrl))?.status()).toBe(200);
          await page.waitForFunction(() => !!document.body.dataset.authority);
          const leaked = JSON.parse(
            (await page.locator("body").getAttribute("data-authority")) ?? "null",
          );
          expect(leaked[0]).toBe("authenticated Cake data");
          expect(JSON.parse(leaked[1])).toMatchObject({
            _tag: "Exit",
            exit: { _tag: "Success", value: directory },
          });

          proxy.stripSandbox(false);
          const response = await page.goto(widgetUrl);
          expect(response?.status()).toBe(200);
          expect(await response?.headerValue("content-security-policy")).toMatch(
            /(?:^|;)\s*sandbox allow-scripts allow-downloads(?:;|$)/,
          );
          expect(await response?.headerValue("content-security-policy")).not.toContain(
            "allow-same-origin",
          );
          await page.waitForFunction(() => !!document.body.dataset.authority);
          expect(
            JSON.parse((await page.locator("body").getAttribute("data-authority")) ?? "null"),
          ).toEqual(["denied", "denied"]);

          // The authenticated host still has normal HTTP/RPC authority, while the
          // real compiled artifact executes and persists edits through postMessage.
          expect((await page.goto(proxy.origin))?.status()).toBe(200);
          await page.waitForFunction(() => !!document.body.dataset.authority);
          expect(
            JSON.parse((await page.locator("body").getAttribute("data-authority")) ?? "null"),
          ).toEqual(leaked);
          const frame = page.frameLocator('iframe[title="Artifact"]');
          await browserExpect(frame.locator("#state")).toHaveText("1:0");
          await browserExpect(frame.locator("body")).toHaveAttribute(
            "data-authority",
            '["denied","denied"]',
          );

          // Exercise the production runtime's source check: even the correct
          // token cannot turn a self-posted message into host-owned state.
          await frame.locator("body").evaluate(async (_body, token) => {
            const barrier = new Promise<void>((resolve) => {
              const receive = (event: MessageEvent) => {
                if (event.data !== "source-barrier") return;
                removeEventListener("message", receive);
                resolve();
              };
              addEventListener("message", receive);
            });
            postMessage(
              {
                source: "cake-artifact-host",
                token,
                type: "state",
                value: { version: 99, value: { count: 99 } },
              },
              "*",
            );
            postMessage("source-barrier", "*");
            await barrier;
          }, compiled.token);
          await browserExpect(frame.locator("#state")).toHaveText("1:0");

          // Exercise the production token check with an actual parent message.
          // An ordered marker proves it was delivered, without an arbitrary sleep.
          await frame.locator("body").evaluate(() => {
            const receive = (event: MessageEvent) => {
              if (event.data !== "token-barrier") return;
              removeEventListener("message", receive);
              document.body.dataset.bridgeBarrier = "done";
            };
            addEventListener("message", receive);
          });
          await page.evaluate(() => {
            const target = document.querySelector("iframe")?.contentWindow;
            target?.postMessage(
              {
                source: "cake-artifact-host",
                token: "wrong-token",
                type: "state",
                value: { version: 99, value: { count: 99 } },
              },
              "*",
            );
            target?.postMessage("token-barrier", "*");
          });
          await browserExpect(frame.locator("body")).toHaveAttribute("data-bridge-barrier", "done");
          await browserExpect(frame.locator("#state")).toHaveText("1:0");
          await browserExpect(page.locator("body")).toHaveAttribute("data-saves", "0");
          await frame.locator("#save").click();
          await browserExpect(frame.locator("#state")).toHaveText("2:1");
          await browserExpect(page.locator("body")).toHaveAttribute("data-saves", "1");
        } finally {
          await context.close();
        }
      });
    }),
  30_000,
);

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import { NodeSocket } from "@effect/platform-node-shared";
import { expect, it } from "vitest";
import { openNativePreviewTunnel } from "../../src/services/browser/NativePreviewTunnel";

/** The fixture certificate is a test-only CA. Production never disables TLS verification. */
it("trusted HTTPS/WSS Cake endpoint carries bounded preview HTTP POST and same-origin HMR with certificate verification", async () => {
  const certPath = join(import.meta.dirname, "fixtures/preview-localhost.crt");
  // NODE_EXTRA_CA_CERTS is read once at process startup. Run the actual bridge in
  // an isolated Node process with this test CA; production TLS validation is unchanged.
  if (!process.env.CAKE_PREVIEW_TRUSTED_TLS_CHILD) {
    const output = await new Promise<{ code: number | null; text: string }>(
      (resolveResult, reject) => {
        const child = spawn(
          process.execPath,
          [
            resolve(import.meta.dirname, "../../node_modules/vitest/vitest.mjs"),
            "run",
            "--config",
            resolve(import.meta.dirname, "../../vitest.integration.config.ts"),
            join(import.meta.dirname, "preview-trusted-tls.test.ts"),
          ],
          {
            env: {
              ...process.env,
              NODE_EXTRA_CA_CERTS: certPath,
              CAKE_PREVIEW_TRUSTED_TLS_CHILD: "1",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let text = "";
        child.stdout.on("data", (chunk: Buffer) => (text += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (text += chunk.toString()));
        child.once("error", reject);
        child.once("exit", (code) => resolveResult({ code, text }));
      },
    );
    expect(output.code, output.text).toBe(0);
    return;
  }
  const [key, cert] = await Promise.all([
    readFile(join(import.meta.dirname, "fixtures/preview-localhost.key")),
    readFile(certPath),
  ]);
  const lease = { endpoint: `/preview/${"a".repeat(64)}/`, secret: "b".repeat(64) };
  let tlsPort = 0;
  let upstreamOrigin = "";
  const server = createServer({ key, cert }, (request, response) => {
    if (
      request.headers.host !== `localhost:${tlsPort}` ||
      (request.headers.origin !== undefined && request.headers.origin !== upstreamOrigin)
    ) {
      response.writeHead(403);
      response.end();
      return;
    }
    if (
      !request.url?.startsWith(lease.endpoint) ||
      request.headers["x-cake-preview-bridge"] !== lease.secret
    ) {
      response.writeHead(403);
      response.end();
      return;
    }
    const path = request.url.slice(lease.endpoint.length - 1);
    if (path === "/submit" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => response.end(`trusted-post:${body}`));
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end("trusted-preview-document");
  });
  const websocketServer = new NodeSocket.NodeWS.WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
  });
  server.on("upgrade", (request, socket, head) => {
    if (
      request.headers.host !== `localhost:${tlsPort}` ||
      request.headers.origin !== upstreamOrigin ||
      request.headers["x-cake-preview-bridge"] !== lease.secret ||
      request.url !== `${lease.endpoint}hot`
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (client) => {
      client.on("message", (data) => client.send(`trusted-hmr:${client.protocol}:${data}`));
    });
  });
  let tunnel: Awaited<ReturnType<typeof openNativePreviewTunnel>> | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "::1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Trusted TLS fixture unavailable");
    tlsPort = address.port;
    upstreamOrigin = `https://localhost:${tlsPort}`;
    tunnel = await openNativePreviewTunnel(`wss://localhost:${tlsPort}/rpc`, lease);
    const local = new URL(tunnel.endpoint);
    const requestLocal = (
      path: string,
      options: { method?: string; body?: string; headers?: Record<string, string> } = {},
    ) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = httpRequest(
          `http://127.0.0.1:${local.port}${path}`,
          {
            method: options.method ?? "GET",
            headers: { host: local.host, ...options.headers },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () =>
              resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
            );
          },
        );
        request.once("error", reject);
        request.end(options.body);
      });
    expect(await requestLocal("/")).toEqual({ status: 200, body: "trusted-preview-document" });
    expect(await requestLocal("/submit", { method: "POST", body: "clicked" })).toEqual({
      status: 200,
      body: "trusted-post:clicked",
    });
    const ws = new NodeSocket.NodeWS.WebSocket(`ws://127.0.0.1:${local.port}/hot`, "vite-hmr", {
      origin: tunnel.endpoint.slice(0, -1),
      headers: { host: local.host },
    });
    try {
      const message = await new Promise<string>((resolve, reject) => {
        ws.once("error", reject);
        ws.once("open", () => ws.send("change"));
        ws.once("close", () =>
          reject(new Error("Preview WSS upstream closed before HMR response")),
        );
        ws.once("message", (data) => resolve(String(data)));
      });
      expect(message).toBe("trusted-hmr:vite-hmr:change");
    } finally {
      ws.terminate();
    }
    const unauthorized = await new Promise<number>((resolve, reject) => {
      httpsRequest(`${upstreamOrigin}${lease.endpoint}`, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      })
        .once("error", reject)
        .end();
    });
    expect(unauthorized).toBe(403);
    // Even when the test CA is trusted, hostname verification must not be bypassed.
    const hostnameError = await new Promise<string>((resolve) => {
      httpsRequest(
        `https://localhost:${tlsPort}${lease.endpoint}`,
        { servername: "wrong.localhost" },
        (response) => {
          response.resume();
          resolve("unexpected-success");
        },
      )
        .once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "unknown"))
        .end();
    });
    expect(hostnameError).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
  } finally {
    tunnel?.close();
    for (const socket of websocketServer.clients) socket.terminate();
    websocketServer.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 15_000);

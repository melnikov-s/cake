import { createServer, request as httpRequest } from "node:http";
import { expect, it } from "vitest";
import { Effect } from "effect";
import { connect } from "node:net";
import { previewProxyTarget, proxyPreviewHttp } from "../../src/server/previewProxy";
import { PreviewLeases } from "../../src/services/browser/PreviewLeases";

it("preview path and bridge header refuse traversal, duplicate credentials, invalid secrets and revoked leases", async () => {
  const revocation = new AbortController();
  const id = "a".repeat(64);
  const secret = "b".repeat(64);
  const lease = { id, secret, connectionId: 1, sessionId: "session", port: 6500, revocation };
  const previews = PreviewLeases.of({
    acquire: () => Effect.die("Unexpected acquisition"),
    find: (input, credential) =>
      input === id && credential === secret && !revocation.signal.aborted ? lease : undefined,
    releaseConnection: () => Effect.void,
    releaseSession: () => Effect.void,
    configure: () => Effect.void,
    shutdown: () => Effect.void,
  });
  const server = createServer((request, response) => {
    const target = previewProxyTarget(previews, request);
    if (!target) {
      response.writeHead(403);
      response.end();
      return;
    }
    proxyPreviewHttp(request, response, target, new AbortController().signal);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const get = (path: string, headers: Record<string, string> = {}) =>
    new Promise<number>((resolve, reject) => {
      httpRequest(`http://127.0.0.1:${address.port}${path}`, { headers }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      })
        .once("error", reject)
        .end();
    });
  try {
    expect(await get(`/preview/${id}/`, { "x-cake-preview-bridge": "0".repeat(64) })).toBe(403);
    expect(await get(`/preview/${id}/a%252fb`, { "x-cake-preview-bridge": secret })).toBe(403);
    expect(await get(`/preview/${id}/../a`, { "x-cake-preview-bridge": secret })).toBe(403);
    expect(await get(`/preview/${id}//a`, { "x-cake-preview-bridge": secret })).toBe(403);
    const duplicateStatus = await new Promise<string>((resolve, reject) => {
      const socket = connect(address.port, "127.0.0.1", () =>
        socket.write(
          `GET /preview/${id}/ HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nX-Cake-Preview-Bridge: ${secret}\r\nx-cake-preview-bridge: ${secret}\r\nConnection: close\r\n\r\n`,
        ),
      );
      let response = "";
      socket.on("data", (chunk) => (response += chunk.toString()));
      socket.on("end", () => resolve(response));
      socket.on("error", reject);
    });
    expect(duplicateStatus).toContain("403 Forbidden");
    revocation.abort();
    expect(await get(`/preview/${id}/`, { "x-cake-preview-bridge": secret })).toBe(403);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

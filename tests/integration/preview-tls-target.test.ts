import { createServer as createTcpServer } from "node:net";
import { request as httpRequest } from "node:http";
import { expect, it } from "vitest";
import { openNativePreviewTunnel } from "../../src/services/browser/NativePreviewTunnel";

it("WSS-only Cake endpoint initiates TLS for preview assets and refuses an untrusted peer", async () => {
  const handshakes: Buffer[] = [];
  const tlsEndpoint = createTcpServer((socket) => {
    socket.once("data", (bytes: Buffer) => {
      handshakes.push(bytes);
      socket.destroy(); // No server certificate: this peer cannot complete a trusted connection.
    });
  });
  await new Promise<void>((resolve) => tlsEndpoint.listen(0, "127.0.0.1", resolve));
  const address = tlsEndpoint.address();
  if (!address || typeof address === "string") throw new Error("TLS fixture failed to bind");
  const tunnel = await openNativePreviewTunnel(`wss://127.0.0.1:${address.port}/rpc`, {
    endpoint: `/preview/${"a".repeat(64)}/`,
    secret: "b".repeat(64),
  });
  try {
    const origin = new URL(tunnel.endpoint);
    const status = await new Promise<number>((resolve, reject) => {
      httpRequest(
        `http://127.0.0.1:${origin.port}/asset.js`,
        {
          headers: { host: origin.host },
        },
        (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode ?? 0));
        },
      )
        .once("error", reject)
        .end();
    });
    expect(status).toBe(502);
    expect(handshakes).toHaveLength(1);
    expect(handshakes[0]?.[0]).toBe(0x16); // TLS Handshake record; no plaintext HTTP to WSS host.
  } finally {
    tunnel.close();
    await new Promise<void>((resolve) => tlsEndpoint.close(() => resolve()));
  }
});

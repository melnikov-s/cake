// Cake companion extension. Runs inside the openvscode-server extension host and
// relays traffic with the Cake main process over localhost HTTP:
//   - POSTs {type:"hello", port} once its own reveal server is listening
//   - POSTs {type:"activity", path} when the active editor changes
//   - serves POST /reveal {path, line} so Cake can jump to a workspace file
"use strict";

const http = require("node:http");
const path = require("node:path");

const BRIDGE_PORT = Number(process.env.CAKE_BRIDGE_PORT || 0);
const WORKSPACE = process.env.CAKE_WORKSPACE_PATH || "";
const HELLO_RETRIES = 5;
const HELLO_RETRY_DELAY_MS = 2_000;

let revealServer = undefined;
let activitySubscription = undefined;

function postBridge(payload) {
  if (!BRIDGE_PORT || !WORKSPACE) return;
  const body = Buffer.from(JSON.stringify({ ...payload, workspace: WORKSPACE }));
  const request = http.request({
    host: "127.0.0.1",
    port: BRIDGE_PORT,
    method: "POST",
    path: "/",
    headers: {
      "content-type": "application/json",
      "content-length": body.length,
    },
    timeout: 5_000,
  });
  request.on("error", () => {});
  request.on("timeout", () => request.destroy());
  request.end(body);
}

function postHello(attempt) {
  const address = revealServer && revealServer.address();
  if (!address || address.port === undefined) return;
  postBridge({ type: "hello", port: address.port });
  if (attempt > 1) {
    const timer = setTimeout(() => postHello(attempt - 1), HELLO_RETRY_DELAY_MS);
    timer.unref();
  }
}

function readBody(request) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 65_536) {
        reject(new Error("Payload too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function activate(context) {
  const vscode = require("vscode");

  const reveal = async (payload) => {
    const relativePath = String(payload.path || "");
    if (!relativePath) throw new Error("A file path is required");
    const target = path.resolve(WORKSPACE || context.extensionPath, relativePath);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    const line = Number.isFinite(payload.line) ? Math.max(0, Number(payload.line)) : 0;
    await vscode.window.showTextDocument(document, {
      selection: new vscode.Range(line, 0, line, 0),
      preview: false,
    });
  };

  revealServer = http.createServer((request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    readBody(request)
      .then((raw) => reveal(JSON.parse(raw)))
      .then(() => response.writeHead(204).end())
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        response.writeHead(400, { "content-type": "text/plain" }).end(message);
      });
  });
  revealServer.on("error", () => {});

  context.subscriptions.push(
    {
      dispose: () => {
        activitySubscription?.dispose();
        revealServer?.close();
        revealServer = undefined;
      },
    },
    vscode.commands.registerCommand("cake.reveal", (payload) => reveal(payload || {})),
  );

  activitySubscription = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (!editor) return;
    const filePath = editor.document.uri.fsPath;
    if (!WORKSPACE || !filePath.startsWith(WORKSPACE)) return;
    postBridge({
      type: "activity",
      path: path.relative(WORKSPACE, filePath).split(path.sep).join("/"),
    });
  });

  revealServer.listen(0, "127.0.0.1", () => postHello(HELLO_RETRIES));
}

function deactivate() {
  activitySubscription?.dispose();
  revealServer?.close();
}

module.exports = { activate, deactivate };

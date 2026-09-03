// Cake companion extension. Runs inside the openvscode-server extension host and
// relays explicit user selections to Cake while projecting Cake source locations and
// discussion annotations into native VS Code surfaces.
"use strict";

const http = require("node:http");
const path = require("node:path");

const BRIDGE_PORT = Number(process.env.CAKE_BRIDGE_PORT || 0);
const BRIDGE_TOKEN = process.env.CAKE_BRIDGE_TOKEN || "";
const WORKSPACE = process.env.CAKE_WORKSPACE_PATH || "";
const HELLO_RETRIES = 5;
const HELLO_RETRY_DELAY_MS = 2_000;

let revealServer;
let selectionSubscription;
let selectionTimer;
const revealDecorations = new Set();
let annotationSessionId;
let annotations = [];
let annotationEmitter;
let annotationDecorations;

function postBridge(payload) {
  if (!BRIDGE_PORT || !BRIDGE_TOKEN || !WORKSPACE) return;
  const body = Buffer.from(JSON.stringify({ ...payload, workspace: WORKSPACE }));
  const request = http.request({
    host: "127.0.0.1",
    port: BRIDGE_PORT,
    method: "POST",
    path: "/",
    headers: {
      "content-type": "application/json",
      "content-length": body.length,
      "x-cake-token": BRIDGE_TOKEN,
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

function workspaceRelative(filePath) {
  if (!WORKSPACE) return undefined;
  const relativePath = path.relative(WORKSPACE, filePath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  )
    return undefined;
  return relativePath.split(path.sep).join("/");
}

function sendUserSelection(event) {
  const editor = event.textEditor;
  if (event.kind === undefined || editor.document.uri.scheme !== "file") return;
  const relativePath = workspaceRelative(editor.document.uri.fsPath);
  if (!relativePath || editor.selection.isEmpty) {
    postBridge({ type: "selection-cleared" });
    return;
  }
  const endLine =
    editor.selection.end.character === 0 && editor.selection.end.line > editor.selection.start.line
      ? editor.selection.end.line - 1
      : editor.selection.end.line;
  postBridge({
    type: "selection",
    path: relativePath,
    startLine: editor.selection.start.line,
    endLine,
  });
}

function scheduleUserSelection(event) {
  if (selectionTimer) clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => sendUserSelection(event), 75);
  selectionTimer.unref?.();
}

function readBody(request) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 512_000) {
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

function boundedPosition(vscode, document, value, defaultToEnd) {
  const line = Math.min(document.lineCount - 1, Math.max(0, Number(value?.line) || 0));
  const lineLength = document.lineAt(line).text.length;
  const character = Number.isFinite(value?.column)
    ? Math.min(lineLength, Math.max(0, Number(value.column)))
    : defaultToEnd
      ? lineLength
      : 0;
  return new vscode.Position(line, character);
}

function rangeFor(vscode, document, requestedRange) {
  const start = boundedPosition(vscode, document, requestedRange?.start, false);
  const end = boundedPosition(vscode, document, requestedRange?.end || requestedRange?.start, true);
  return new vscode.Range(start, end.isBefore(start) ? start : end);
}

function annotationStatusLabel(status) {
  return (
    {
      open: "Open",
      pending: "Pending",
      answered: "Answered",
      resolved: "Resolved",
    }[status] || "Open"
  );
}

function annotationReplyLabel(replyCount) {
  return `${replyCount} ${replyCount === 1 ? "reply" : "replies"}`;
}

function matchingAnnotations(editor) {
  const relativePath = workspaceRelative(editor.document.uri.fsPath);
  return relativePath
    ? annotations.filter((annotation) => annotation.location?.path === relativePath)
    : [];
}

function annotationHover(vscode, annotation) {
  const hover = new vscode.MarkdownString();
  hover.appendMarkdown(`**Cake discussion · ${annotationStatusLabel(annotation.status)}**\n\n`);
  if (annotation.preview) {
    hover.appendText(annotation.preview);
    hover.appendMarkdown("\n\n");
  }
  hover.appendText(annotationReplyLabel(annotation.replyCount || 0));
  hover.appendMarkdown("\n\nSelect the Cake CodeLens to open the full conversation.");
  return hover;
}

function applyAnnotationDecorations(vscode) {
  if (!annotationDecorations) return;
  for (const editor of vscode.window.visibleTextEditors) {
    const matching = matchingAnnotations(editor);
    for (const [status, decoration] of Object.entries(annotationDecorations)) {
      editor.setDecorations(
        decoration,
        matching
          .filter((annotation) => annotation.status === status)
          .map((annotation) => ({
            range: rangeFor(vscode, editor.document, annotation.location.range),
            hoverMessage: annotationHover(vscode, annotation),
          })),
      );
    }
  }
}

function updateAnnotations(vscode, payload) {
  annotationSessionId = payload.sessionId || undefined;
  annotations = Array.isArray(payload.annotations) ? payload.annotations : [];
  applyAnnotationDecorations(vscode);
  annotationEmitter?.fire();
}

async function openSourceControl(vscode) {
  await vscode.commands.executeCommand("workbench.view.scm");
}

async function hasGitChange(vscode, targetUri) {
  try {
    const extension = vscode.extensions.getExtension("vscode.git");
    if (!extension) return false;
    const exports = extension.isActive ? extension.exports : await extension.activate();
    const api = exports?.getAPI?.(1);
    if (!api) return false;
    await Promise.allSettled(api.repositories.map((repository) => repository.status()));
    const targetPath = path.resolve(targetUri.fsPath);
    return api.repositories.some((repository) => {
      const state = repository.state;
      return [
        ...(state.workingTreeChanges || []),
        ...(state.indexChanges || []),
        ...(state.mergeChanges || []),
      ].some((change) => {
        const changeUri = change.uri || change.resourceUri;
        return changeUri?.scheme === "file" && path.resolve(changeUri.fsPath) === targetPath;
      });
    });
  } catch {
    return false;
  }
}

async function setTheme(vscode, payload) {
  const themeLabel = payload.theme === "dark" ? "Cake Dark" : "Cake Light";
  await vscode.workspace
    .getConfiguration("workbench")
    .update("colorTheme", themeLabel, vscode.ConfigurationTarget.Global);
}

async function runScript(vscode, payload) {
  const source = String(payload.source || "");
  if (source.length === 0) throw new Error("A JavaScript source body is required");
  if (source.length > 65_536) throw new Error("JavaScript source exceeds 65536 characters");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction("vscode", "input", "require", `"use strict";\n${source}`);
  const value = await execute(vscode, payload.input ?? null, require);
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("The script result is not JSON-compatible");
  if (Buffer.byteLength(serialized) > 256_000)
    throw new Error("The script result exceeds 256000 bytes");
  return JSON.parse(serialized);
}

function activate(context) {
  const vscode = require("vscode");
  const annotationMarker = (color) =>
    vscode.Uri.parse(
      `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14"><path d="M2 2h10v7H7l-3 3V9H2z" fill="${color}"/></svg>`)}`,
    );
  annotationDecorations = {
    open: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      gutterIconPath: annotationMarker("#7c5cff"),
      gutterIconSize: "contain",
    }),
    pending: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      gutterIconPath: annotationMarker("#d97706"),
      gutterIconSize: "contain",
    }),
    answered: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      gutterIconPath: annotationMarker("#16a34a"),
      gutterIconSize: "contain",
    }),
    resolved: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      gutterIconPath: annotationMarker("#888888"),
      gutterIconSize: "contain",
      opacity: "0.55",
    }),
  };
  annotationEmitter = new vscode.EventEmitter();
  const annotationCodeLensProvider = {
    onDidChangeCodeLenses: annotationEmitter.event,
    provideCodeLenses(document) {
      const editor = vscode.window.visibleTextEditors.find(
        (candidate) => candidate.document.uri.toString() === document.uri.toString(),
      );
      if (!editor || !annotationSessionId) return [];
      return matchingAnnotations(editor).map((annotation) => {
        const range = rangeFor(vscode, document, annotation.location.range);
        return new vscode.CodeLens(range, {
          command: "cake.openAnnotation",
          title: `$(comment-discussion) Cake: ${annotationStatusLabel(annotation.status)} · ${annotationReplyLabel(annotation.replyCount || 0)}`,
          arguments: [annotationSessionId, annotation.id],
          tooltip: annotation.preview || "Open this Cake discussion",
        });
      });
    },
  };
  context.subscriptions.push(
    annotationEmitter,
    ...Object.values(annotationDecorations),
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, annotationCodeLensProvider),
  );

  const reveal = async (payload) => {
    const relativePath = String(payload.path || "");
    if (!relativePath) throw new Error("A file path is required");
    const target = path.resolve(WORKSPACE || context.extensionPath, relativePath);
    if (!workspaceRelative(target)) throw new Error("The source location is outside the workspace");
    const targetUri = vscode.Uri.file(target);
    if (payload.view === "changes" && (await hasGitChange(vscode, targetUri))) {
      await openSourceControl(vscode);
      try {
        await vscode.commands.executeCommand("git.openChange", targetUri);
        return;
      } catch {
        // Deleted, untracked, or non-Git files may not have a native change editor.
        // Fall through to the ordinary source document when the file still exists.
      }
    }
    const document = await vscode.workspace.openTextDocument(targetUri);
    if (Number.isInteger(payload.documentVersion) && payload.documentVersion !== document.version)
      void vscode.window.showWarningMessage(
        `This Cake source location was created for version ${payload.documentVersion}; the open document is version ${document.version}.`,
      );

    let requestedRange = payload.range;
    if (!requestedRange && payload.symbol) {
      const symbols =
        (await vscode.commands.executeCommand(
          "vscode.executeDocumentSymbolProvider",
          document.uri,
        )) || [];
      const findSymbol = (items) => {
        for (const item of items) {
          if (item.name === payload.symbol) return item;
          const nested = item.children && findSymbol(item.children);
          if (nested) return nested;
        }
        return undefined;
      };
      const symbol = findSymbol(symbols);
      const symbolRange =
        symbol && (symbol.selectionRange || symbol.range || symbol.location?.range);
      if (symbolRange)
        requestedRange = {
          start: { line: symbolRange.start.line, column: symbolRange.start.character },
          end: { line: symbolRange.end.line, column: symbolRange.end.character },
        };
    }
    const range = requestedRange ? rangeFor(vscode, document, requestedRange) : undefined;
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    for (const decoration of revealDecorations) decoration.dispose();
    revealDecorations.clear();
    if (!range) return;
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    const decoration = vscode.window.createTextEditorDecorationType({
      border: "1px solid",
      borderColor: new vscode.ThemeColor("editorInfo.foreground"),
      isWholeLine: requestedRange?.start?.column === undefined,
    });
    revealDecorations.add(decoration);
    editor.setDecorations(decoration, [range]);
  };

  revealServer = http.createServer((request, response) => {
    if (request.headers["x-cake-token"] !== BRIDGE_TOKEN) {
      response.writeHead(401).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    readBody(request)
      .then((raw) => JSON.parse(raw))
      .then(async (payload) => {
        if (payload.type === "script") {
          const result = await runScript(vscode, payload);
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify(result));
          return;
        }
        if (payload.type === "annotations") await updateAnnotations(vscode, payload);
        else if (payload.type === "open-source-control") await openSourceControl(vscode);
        else if (payload.type === "set-theme") await setTheme(vscode, payload);
        else await reveal(payload);
        response.writeHead(204).end();
      })
      .catch((error) => {
        response
          .writeHead(400, { "content-type": "text/plain" })
          .end(error instanceof Error ? error.message : String(error));
      });
  });
  revealServer.on("error", () => {});

  context.subscriptions.push(
    {
      dispose: () => {
        selectionSubscription?.dispose();
        if (selectionTimer) clearTimeout(selectionTimer);
        for (const decoration of revealDecorations) decoration.dispose();
        revealDecorations.clear();
        revealServer?.close();
        revealServer = undefined;
      },
    },
    vscode.commands.registerCommand("cake.reveal", (payload) => reveal(payload || {})),
    vscode.commands.registerCommand("cake.openAnnotation", (sessionId, threadId) => {
      if (sessionId !== annotationSessionId || !annotations.some((item) => item.id === threadId))
        return;
      postBridge({ type: "open-annotation", sessionId, threadId });
    }),
    vscode.commands.registerCommand("cake.backToAgent", () =>
      postBridge({ type: "back-to-agent" }),
    ),
    vscode.commands.registerCommand("cake.toggleChatSidebar", () =>
      postBridge({ type: "toggle-chat-sidebar" }),
    ),
    vscode.window.onDidChangeVisibleTextEditors(() => {
      applyAnnotationDecorations(vscode);
      annotationEmitter.fire();
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => scheduleUserSelection(event)),
  );

  selectionSubscription = vscode.window.onDidChangeActiveTextEditor(() => {
    if (selectionTimer) clearTimeout(selectionTimer);
    postBridge({ type: "selection-cleared" });
  });
  revealServer.listen(0, "127.0.0.1", () => {
    postHello(HELLO_RETRIES);
    postBridge({ type: "selection-cleared" });
  });
}

function deactivate() {
  activitySubscription?.dispose();
  if (activityTimer) clearTimeout(activityTimer);
  for (const decoration of revealDecorations) decoration.dispose();
  revealDecorations.clear();
  revealServer?.close();
}

module.exports = { activate, deactivate };

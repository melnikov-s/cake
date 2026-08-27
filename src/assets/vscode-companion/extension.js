// Cake companion extension. Runs inside the openvscode-server extension host and
// relays editor activity to Cake while projecting Cake source locations and
// transcript-derived agent changes into native VS Code surfaces.
"use strict";

const http = require("node:http");
const path = require("node:path");

const BRIDGE_PORT = Number(process.env.CAKE_BRIDGE_PORT || 0);
const BRIDGE_TOKEN = process.env.CAKE_BRIDGE_TOKEN || "";
const WORKSPACE = process.env.CAKE_WORKSPACE_PATH || "";
const HELLO_RETRIES = 5;
const HELLO_RETRY_DELAY_MS = 2_000;
const MAX_SELECTION_LENGTH = 48_000;
const MAX_CONTEXT_LENGTH = 8_000;
const CHANGE_FLASH_MS = 1_800;

let revealServer;
let activitySubscription;
let activityTimer;
let changeStatus;
let temporaryTimer;
let agentChanges = [];
const reviewedChanges = new Set();
const temporaryChanges = new Set();
const revealDecorations = new Set();
let changeDecorations;

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

function sendEditorActivity(vscode, editor = vscode.window.activeTextEditor) {
  if (!editor || editor.document.uri.scheme !== "file") {
    postBridge({ type: "activity-cleared" });
    return;
  }
  const relativePath = workspaceRelative(editor.document.uri.fsPath);
  if (!relativePath) {
    postBridge({ type: "activity-cleared" });
    return;
  }
  const selection = editor.selection;
  const selectedText = editor.document.getText(selection).slice(0, MAX_SELECTION_LENGTH);
  const lines = editor.document.getText().split(/\r?\n/);
  postBridge({
    type: "activity",
    path: relativePath,
    documentVersion: editor.document.version,
    startLine: selection.start.line,
    startColumn: selection.start.character,
    endLine: selection.end.line,
    endColumn: selection.end.character,
    selectedText,
    contextBefore: lines
      .slice(Math.max(0, selection.start.line - 3), selection.start.line)
      .join("\n")
      .slice(-MAX_CONTEXT_LENGTH),
    contextAfter: lines
      .slice(selection.end.line + 1, selection.end.line + 4)
      .join("\n")
      .slice(0, MAX_CONTEXT_LENGTH),
  });
}

function scheduleEditorActivity(vscode, editor = vscode.window.activeTextEditor) {
  if (activityTimer) clearTimeout(activityTimer);
  activityTimer = setTimeout(() => sendEditorActivity(vscode, editor), 75);
  activityTimer.unref?.();
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

function changeRange(vscode, editor, change) {
  return rangeFor(vscode, editor.document, change.range);
}

function editorMatches(editor, change) {
  return workspaceRelative(editor.document.uri.fsPath) === change.path;
}

function applyChangeDecorations(vscode) {
  if (!changeDecorations) return;
  for (const editor of vscode.window.visibleTextEditors) {
    const matching = agentChanges.filter((change) => editorMatches(editor, change));
    editor.setDecorations(
      changeDecorations.current,
      matching
        .filter((change) => change.currentTurn && !reviewedChanges.has(change.id))
        .map((change) => changeRange(vscode, editor, change)),
    );
    editor.setDecorations(
      changeDecorations.previous,
      matching
        .filter((change) => !change.currentTurn && !reviewedChanges.has(change.id))
        .map((change) => changeRange(vscode, editor, change)),
    );
    editor.setDecorations(
      changeDecorations.reviewed,
      matching
        .filter((change) => reviewedChanges.has(change.id))
        .map((change) => changeRange(vscode, editor, change)),
    );
    editor.setDecorations(
      changeDecorations.temporary,
      matching
        .filter((change) => temporaryChanges.has(change.id))
        .map((change) => changeRange(vscode, editor, change)),
    );
  }
  const current = agentChanges.filter((change) => change.currentTurn);
  const unreviewed = current.filter((change) => !reviewedChanges.has(change.id));
  if (current.length === 0) {
    changeStatus.hide();
  } else {
    changeStatus.text = `$(diff) ${unreviewed.length}/${current.length} Cake changes`;
    changeStatus.tooltip = `${unreviewed.length} unreviewed changes in the current agent turn`;
    changeStatus.show();
  }
}

function updateAgentChanges(vscode, payload) {
  const previousIds = new Set(agentChanges.map((change) => change.id));
  agentChanges = Array.isArray(payload.changes) ? payload.changes : [];
  const activeIds = new Set(agentChanges.map((change) => change.id));
  for (const id of reviewedChanges) if (!activeIds.has(id)) reviewedChanges.delete(id);
  for (const change of agentChanges) {
    if (change.currentTurn && !previousIds.has(change.id)) temporaryChanges.add(change.id);
  }
  if (temporaryTimer) clearTimeout(temporaryTimer);
  temporaryTimer = setTimeout(() => {
    temporaryChanges.clear();
    applyChangeDecorations(vscode);
  }, CHANGE_FLASH_MS);
  temporaryTimer.unref?.();
  applyChangeDecorations(vscode);
}

function navigationChanges() {
  const current = agentChanges.filter((change) => change.currentTurn);
  const currentUnreviewed = current.filter((change) => !reviewedChanges.has(change.id));
  return currentUnreviewed.length > 0
    ? currentUnreviewed
    : current.length > 0
      ? current
      : agentChanges;
}

async function showAgentChange(vscode, change) {
  if (!change) {
    void vscode.window.showInformationMessage("Cake has no agent changes to show.");
    return;
  }
  const target = path.resolve(WORKSPACE, change.path);
  if (!workspaceRelative(target)) throw new Error("The change is outside the workspace");
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
  const range = rangeFor(vscode, document, change.range);
  const editor = await vscode.window.showTextDocument(document, {
    selection: range,
    preview: false,
  });
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  reviewedChanges.add(change.id);
  applyChangeDecorations(vscode);
}

async function navigateChange(vscode, direction) {
  const changes = navigationChanges();
  if (changes.length === 0) return showAgentChange(vscode, undefined);
  const editor = vscode.window.activeTextEditor;
  const activePath = editor && workspaceRelative(editor.document.uri.fsPath);
  let index = changes.findIndex((change) => {
    if (change.path !== activePath) return false;
    if (!editor || !change.range) return true;
    return changeRange(vscode, editor, change).contains(editor.selection.active);
  });
  if (index < 0) index = direction > 0 ? -1 : 0;
  const next = (index + direction + changes.length) % changes.length;
  await showAgentChange(vscode, changes[next]);
}

async function openCompleteChange(vscode) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const uri = editor.document.uri;
  try {
    const extension = vscode.extensions.getExtension("vscode.git");
    const exports = extension ? await extension.activate() : undefined;
    const repository = exports?.getAPI?.(1)?.getRepository?.(uri);
    const state = repository?.state;
    const resources = [
      ...(state?.workingTreeChanges || []),
      ...(state?.indexChanges || []),
      ...(state?.untrackedChanges || []),
    ];
    const resource = resources.find((candidate) => candidate.uri?.fsPath === uri.fsPath);
    if (resource?.originalUri) {
      await vscode.commands.executeCommand(
        "vscode.diff",
        resource.originalUri,
        resource.uri,
        `${path.basename(uri.fsPath)} — Complete Cake change`,
      );
      return;
    }
  } catch {
    // Fall through to the Git extension's native open-change command.
  }
  await vscode.commands.executeCommand("git.openChange", uri);
}

function activate(context) {
  const vscode = require("vscode");
  const marker = vscode.Uri.parse(
    `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="16" viewBox="0 0 8 16"><rect x="2" y="2" width="4" height="12" rx="2" fill="#7c5cff"/></svg>')}`,
  );
  const dimMarker = vscode.Uri.parse(
    `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="16" viewBox="0 0 8 16"><rect x="2" y="3" width="4" height="10" rx="2" fill="#888" fill-opacity=".55"/></svg>')}`,
  );
  changeDecorations = {
    current: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      gutterIconPath: marker,
      gutterIconSize: "contain",
      overviewRulerColor: new vscode.ThemeColor("editorInfo.foreground"),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    }),
    previous: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      gutterIconPath: dimMarker,
      gutterIconSize: "contain",
      overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.border"),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    }),
    reviewed: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      gutterIconPath: dimMarker,
      gutterIconSize: "contain",
      opacity: "0.45",
    }),
    temporary: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("editor.wordHighlightStrongBackground"),
    }),
  };
  changeStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  changeStatus.command = "cake.nextChange";
  context.subscriptions.push(changeStatus, ...Object.values(changeDecorations));

  const sendSelection = (action) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") {
      void vscode.window.showInformationMessage("Open a workspace file before using Cake.");
      return;
    }
    const relativePath = workspaceRelative(editor.document.uri.fsPath);
    if (!relativePath) {
      void vscode.window.showInformationMessage("Cake can only use files in this project.");
      return;
    }
    const selection = editor.selection;
    const selectedText = editor.document.getText(selection);
    if (!selectedText) {
      void vscode.window.showInformationMessage("Select some code before using Cake.");
      return;
    }
    if (selectedText.length > MAX_SELECTION_LENGTH) {
      void vscode.window.showWarningMessage(
        "That selection is too large. Select a smaller region before using Cake.",
      );
      return;
    }
    const lines = editor.document.getText().split(/\r?\n/);
    postBridge({
      type: "selection",
      action,
      path: relativePath,
      documentVersion: editor.document.version,
      startLine: selection.start.line,
      startColumn: selection.start.character,
      endLine: selection.end.line,
      endColumn: selection.end.character,
      selectedText,
      contextBefore: lines
        .slice(Math.max(0, selection.start.line - 3), selection.start.line)
        .join("\n")
        .slice(-MAX_CONTEXT_LENGTH),
      contextAfter: lines
        .slice(selection.end.line + 1, selection.end.line + 4)
        .join("\n")
        .slice(0, MAX_CONTEXT_LENGTH),
    });
  };
  const askAboutSelection = () => sendSelection("ask");
  const addSelectionToProjectChat = () => sendSelection("add-to-project-chat");

  const reveal = async (payload) => {
    const relativePath = String(payload.path || "");
    if (!relativePath) throw new Error("A file path is required");
    const target = path.resolve(WORKSPACE || context.extensionPath, relativePath);
    if (!workspaceRelative(target)) throw new Error("The source location is outside the workspace");
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
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
    const range = rangeFor(vscode, document, requestedRange);
    const editor = await vscode.window.showTextDocument(document, {
      selection: range,
      preview: false,
    });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    const decoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor("editor.rangeHighlightBackground"),
      isWholeLine: requestedRange?.start?.column === undefined,
    });
    revealDecorations.add(decoration);
    editor.setDecorations(decoration, [range]);
    const timer = setTimeout(() => {
      revealDecorations.delete(decoration);
      decoration.dispose();
    }, 1_500);
    timer.unref?.();
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
      .then((payload) =>
        payload.type === "agent-changes" ? updateAgentChanges(vscode, payload) : reveal(payload),
      )
      .then(() => response.writeHead(204).end())
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
        activitySubscription?.dispose();
        if (activityTimer) clearTimeout(activityTimer);
        if (temporaryTimer) clearTimeout(temporaryTimer);
        for (const decoration of revealDecorations) decoration.dispose();
        revealDecorations.clear();
        revealServer?.close();
        revealServer = undefined;
      },
    },
    vscode.commands.registerCommand("cake.reveal", (payload) => reveal(payload || {})),
    vscode.commands.registerCommand("cake.askAboutSelection", askAboutSelection),
    vscode.commands.registerCommand("cake.addSelectionToProjectChat", addSelectionToProjectChat),
    vscode.commands.registerCommand("cake.previousChange", () => navigateChange(vscode, -1)),
    vscode.commands.registerCommand("cake.nextChange", () => navigateChange(vscode, 1)),
    vscode.commands.registerCommand("cake.openCompleteChange", () => openCompleteChange(vscode)),
    vscode.commands.registerCommand("cake.clearReviewedChanges", () => {
      for (const change of agentChanges) reviewedChanges.add(change.id);
      applyChangeDecorations(vscode);
    }),
    vscode.commands.registerCommand("cake.backToAgent", () =>
      postBridge({ type: "back-to-agent" }),
    ),
    vscode.commands.registerCommand("cake.toggleChatSidebar", () =>
      postBridge({ type: "toggle-chat-sidebar" }),
    ),
    vscode.window.onDidChangeVisibleTextEditors(() => applyChangeDecorations(vscode)),
    vscode.window.onDidChangeTextEditorSelection((event) =>
      scheduleEditorActivity(vscode, event.textEditor),
    ),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === vscode.window.activeTextEditor?.document)
        scheduleEditorActivity(vscode);
    }),
  );

  activitySubscription = vscode.window.onDidChangeActiveTextEditor((editor) =>
    scheduleEditorActivity(vscode, editor),
  );
  revealServer.listen(0, "127.0.0.1", () => {
    postHello(HELLO_RETRIES);
    sendEditorActivity(vscode);
  });
}

function deactivate() {
  activitySubscription?.dispose();
  if (activityTimer) clearTimeout(activityTimer);
  if (temporaryTimer) clearTimeout(temporaryTimer);
  for (const decoration of revealDecorations) decoration.dispose();
  revealDecorations.clear();
  revealServer?.close();
}

module.exports = { activate, deactivate };

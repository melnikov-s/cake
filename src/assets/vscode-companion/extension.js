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
const MAX_SELECTION_LENGTH = 48_000;
const MAX_CONTEXT_LENGTH = 8_000;
const MAX_COMMENT_LENGTH = 16_000;
const SELECTION_CONTEXT_LINES = 3;
// Cake waits 5 s for a reveal. The Git probe must finish well inside that so a
// slow or unready Git extension degrades to a plain file open instead of a
// transport error.
const GIT_PROBE_TIMEOUT_MS = 2_000;

let revealServer;
let selectionSubscription;
let selectionTimer;
let selectionDecoration;
let selectionLocations = [];
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

/**
 * Resolves the workspace file a text document presents. Diff editors show Git
 * revision documents (`git:` scheme) beside or instead of the working-tree file,
 * and the Git extension records the working-tree path in that URI's query.
 */
function documentFilePath(uri) {
  if (uri.scheme === "file") return uri.fsPath;
  if (uri.scheme !== "git") return undefined;
  try {
    const revisionPath = String(JSON.parse(uri.query)?.path || "");
    if (revisionPath) return revisionPath;
  } catch {
    // Revision URIs mirror the file path, so fall back to it below.
  }
  return uri.fsPath;
}

/**
 * Picks the editor an explicit Cake action targets. Editor context menus pass
 * the clicked document's URI, which identifies the exact side of a diff editor;
 * the command palette passes nothing and means the active editor.
 */
function explicitSelectionEditor(vscode, resource) {
  const clicked =
    resource instanceof vscode.Uri
      ? vscode.window.visibleTextEditors.find(
          (editor) => editor.document.uri.toString() === resource.toString(),
        )
      : undefined;
  return clicked || vscode.window.activeTextEditor;
}

/**
 * Captures an editor's non-empty selection for an explicit Cake action.
 * Unlike the implicit selection relay, this includes the selected source and a
 * few surrounding lines because the user asked Cake to look at exactly this code.
 */
function captureExplicitSelection(vscode, resource) {
  const editor = explicitSelectionEditor(vscode, resource);
  const filePath = editor ? documentFilePath(editor.document.uri) : undefined;
  if (!editor || !filePath) {
    void vscode.window.showInformationMessage("Open a workspace file before using Cake.");
    return undefined;
  }
  const relativePath = workspaceRelative(filePath);
  if (!relativePath) {
    void vscode.window.showInformationMessage("Cake can only use files inside this project.");
    return undefined;
  }
  const selection = editor.selection;
  const selectedText = editor.document.getText(selection);
  if (!selectedText) {
    void vscode.window.showInformationMessage("Select some code before using Cake.");
    return undefined;
  }
  if (selectedText.length > MAX_SELECTION_LENGTH) {
    void vscode.window.showWarningMessage(
      "That selection is too large for Cake. Select a smaller region and try again.",
    );
    return undefined;
  }
  const document = editor.document;
  const lineText = (line) => document.lineAt(line).text;
  const contextBefore = [];
  for (
    let line = Math.max(0, selection.start.line - SELECTION_CONTEXT_LINES);
    line < selection.start.line;
    line += 1
  )
    contextBefore.push(lineText(line));
  const contextAfter = [];
  for (
    let line = selection.end.line + 1;
    line <= Math.min(document.lineCount - 1, selection.end.line + SELECTION_CONTEXT_LINES);
    line += 1
  )
    contextAfter.push(lineText(line));
  return {
    path: relativePath,
    startLine: selection.start.line,
    startColumn: selection.start.character,
    endLine: selection.end.line,
    endColumn: selection.end.character,
    selectedText,
    contextBefore: contextBefore.join("\n").slice(-MAX_CONTEXT_LENGTH),
    contextAfter: contextAfter.join("\n").slice(0, MAX_CONTEXT_LENGTH),
  };
}

async function addAnnotation(vscode, resource) {
  const selection = captureExplicitSelection(vscode, resource);
  if (!selection) return;
  const comment = await vscode.window.showInputBox({
    title: "Cake: Add annotation",
    prompt:
      "Add a note about this selection (optional). Press Enter to attach it to your next message.",
    placeHolder: "Why does this matter?",
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.length > MAX_COMMENT_LENGTH
        ? `Keep the note under ${MAX_COMMENT_LENGTH} characters.`
        : undefined,
  });
  // Escape cancels the annotation; an empty note attaches the bare selection.
  if (comment === undefined) return;
  const trimmed = comment.trim();
  postBridge({
    type: "add-annotation",
    ...selection,
    ...(trimmed ? { comment: trimmed } : null),
  });
}

function askInSideChat(vscode, resource) {
  const selection = captureExplicitSelection(vscode, resource);
  if (!selection) return;
  postBridge({ type: "ask-in-side-chat", ...selection });
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

function resolvedRanges(vscode, editor, requestedRanges) {
  const ranges = requestedRanges.map((range) => rangeFor(vscode, editor.document, range));
  if (ranges.length) editor.revealRange(ranges[0], vscode.TextEditorRevealType.InCenter);
  return ranges.map((range) => ({
    start: { line: range.start.line, column: range.start.character },
    end: { line: range.end.line, column: range.end.character },
  }));
}

function gitRevision(uri) {
  if (uri.scheme !== "git") return undefined;
  try {
    return JSON.parse(uri.query)?.ref;
  } catch {
    return undefined;
  }
}

function matchingSelectionLocations(editor, editors) {
  const uri = editor.document.uri;
  const target = documentFilePath(uri);
  if (!target) return [];
  const absolutePath = path.resolve(target);
  const relativePath = workspaceRelative(absolutePath);
  // A diff's modified side has a file URI just like an ordinary tab. Its
  // original side is visible in the same editor group, with the base in the
  // Git URI. Distinguish the two instead of painting ordinary file tabs.
  const original = editors.find(
    (other) =>
      other !== editor &&
      other.viewColumn === editor.viewColumn &&
      other.document.uri.scheme === "git" &&
      documentFilePath(other.document.uri) &&
      path.resolve(documentFilePath(other.document.uri)) === absolutePath,
  );
  const base = gitRevision(uri.scheme === "git" ? uri : (original?.document.uri ?? uri));
  return selectionLocations.filter((location) => {
    if (location.kind === "absolute-file" && location.view === "file" && uri.scheme === "file")
      return path.resolve(location.path) === absolutePath && !base;
    if (location.kind !== "working-directory" || location.path !== relativePath) return false;
    if (location.view === "file") return uri.scheme === "file" && !base;
    return (
      location.view === "changes" &&
      location.base === base &&
      (location.side === "before" ? uri.scheme === "git" : uri.scheme === "file")
    );
  });
}

function applySelectionHighlights(vscode) {
  if (!selectionDecoration) return;
  const editors = vscode.window.visibleTextEditors;
  for (const editor of editors) {
    const ranges = matchingSelectionLocations(editor, editors).map((location) =>
      rangeFor(vscode, editor.document, location.range),
    );
    editor.setDecorations(selectionDecoration, ranges);
  }
}

function updateSelectionHighlights(vscode, payload) {
  selectionLocations = Array.isArray(payload.locations) ? payload.locations : [];
  applySelectionHighlights(vscode);
}

async function visibleDiffEditor(vscode, target, side, base) {
  const before = side === "before";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const editors = vscode.window.visibleTextEditors;
    const editor = editors.find((candidate) => {
      const uri = candidate.document.uri;
      const filePath = documentFilePath(uri);
      if (!filePath || path.resolve(filePath) !== target) return false;
      if (before) return gitRevision(uri) === base;
      return (
        uri.scheme === "file" &&
        editors.some(
          (other) =>
            other.viewColumn === candidate.viewColumn &&
            documentFilePath(other.document.uri) &&
            path.resolve(documentFilePath(other.document.uri)) === target &&
            gitRevision(other.document.uri) === base,
        )
      );
    });
    if (editor) return editor;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return undefined;
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

function gitUnavailable() {
  return { changed: false, fallback: "git-unavailable" };
}

/**
 * The base revision is handed to `git diff <base> -- <path>` as one argument.
 * Cake validates it before sending, but `cake.reveal` is also a VS Code
 * command, so refuse option-like values and ranges here as well.
 */
function changesBase(payload) {
  const base = payload.base === undefined ? "HEAD" : String(payload.base).trim();
  if (!base || base.startsWith("-") || base.includes("..") || /[\s:]/.test(base))
    throw new Error("The changes base must be a single Git revision");
  return base;
}

/**
 * Decides whether the target's working tree differs from the base revision.
 *
 * This asks Git about the one path only (`git diff <base> -- <path>`), which
 * stays fast in very large checkouts. It deliberately avoids both alternatives:
 * `repository.status()` refreshes the whole working tree and takes longer than
 * Cake waits for a reveal, while the extension's cached Source Control list can
 * lag behind a commit and would open an empty diff.
 */
async function probeWorkingTreeChange(vscode, targetUri, base) {
  const probe = (async () => {
    const extension = vscode.extensions.getExtension("vscode.git");
    if (!extension) return gitUnavailable();
    const exports = extension.isActive ? extension.exports : await extension.activate();
    const api = exports?.getAPI?.(1);
    const repository = api?.getRepository?.(targetUri);
    if (!api || !repository) return gitUnavailable();
    let diff;
    try {
      diff = await repository.diffWith(base, path.resolve(targetUri.fsPath));
    } catch {
      // Git rejected the comparison; an unknown revision is by far the usual cause.
      return { changed: false, fallback: "unknown-base" };
    }
    return diff ? { changed: true, api } : { changed: false, fallback: "no-changes" };
  })();
  let timer;
  const deadline = new Promise((resolvePromise) => {
    timer = setTimeout(() => resolvePromise(gitUnavailable()), GIT_PROBE_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([probe.catch(gitUnavailable), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Opens VS Code's native diff editor for the target's working tree against the
 * base revision. The left side is a `git:` URI whose content comes from one
 * `git show <base>:<path>`, so this stays fast regardless of repository size
 * and does not depend on the Source Control list being current.
 */
async function openWorkingTreeDiff(vscode, api, targetUri, base) {
  const name = path.basename(targetUri.fsPath);
  const title = base === "HEAD" ? `${name} (Working Tree)` : `${name} (${base} ↔ Working Tree)`;
  await vscode.commands.executeCommand(
    "vscode.diff",
    api.toGitUri(targetUri, base),
    targetUri,
    title,
    { preview: false },
  );
}

async function setTheme(vscode, payload) {
  const themeLabel = payload.theme === "dark" ? "Cake Dark" : "Cake Light";
  await vscode.workspace
    .getConfiguration("workbench")
    .update("colorTheme", themeLabel, vscode.ConfigurationTarget.Global);
}

function editorViewColumn(vscode, group) {
  const columns = {
    active: vscode.ViewColumn.Active,
    beside: vscode.ViewColumn.Beside,
    one: vscode.ViewColumn.One,
    two: vscode.ViewColumn.Two,
    three: vscode.ViewColumn.Three,
    four: vscode.ViewColumn.Four,
    five: vscode.ViewColumn.Five,
    six: vscode.ViewColumn.Six,
    seven: vscode.ViewColumn.Seven,
    eight: vscode.ViewColumn.Eight,
    nine: vscode.ViewColumn.Nine,
  };
  return group ? columns[group] : undefined;
}

function workspaceActionUri(vscode, requestedPath) {
  const value = String(requestedPath || "").trim();
  if (!value) throw new Error("A workspace-relative file path is required");
  if (path.isAbsolute(value)) throw new Error("Editor actions require workspace-relative paths");
  const target = path.resolve(WORKSPACE, value);
  if (!workspaceRelative(target))
    throw new Error("The editor action path is outside the workspace");
  return vscode.Uri.file(target);
}

async function performEditorAction(vscode, action) {
  if (!action) throw new Error("An editor action is required");
  if (action.type === "layout.set") {
    const commands = {
      single: "workbench.action.editorLayoutSingle",
      "two-columns": "workbench.action.editorLayoutTwoColumns",
      "two-rows": "workbench.action.editorLayoutTwoRows",
      grid: "workbench.action.editorLayoutTwoByTwoGrid",
    };
    const command = commands[action.layout];
    if (!command) throw new Error("The editor layout is invalid");
    await vscode.commands.executeCommand(command);
    return { action: action.type, layout: action.layout };
  }
  if (action.type === "diff.open") {
    const left = workspaceActionUri(vscode, action.leftPath);
    const right = workspaceActionUri(vscode, action.rightPath);
    await vscode.commands.executeCommand("vscode.diff", left, right, action.title || undefined);
    return { action: action.type, leftPath: action.leftPath, rightPath: action.rightPath };
  }
  if (action.type === "editor.status") {
    const active = vscode.window.activeTextEditor;
    return {
      action: action.type,
      active: active
        ? {
            path: workspaceRelative(active.document.uri.fsPath) || active.document.uri.fsPath,
            line: active.selection.active.line + 1,
            column: active.selection.active.character + 1,
            group: active.viewColumn,
          }
        : null,
      visible: vscode.window.visibleTextEditors.slice(0, 32).map((editor) => ({
        path: workspaceRelative(editor.document.uri.fsPath) || editor.document.uri.fsPath,
        group: editor.viewColumn,
        active: editor === active,
      })),
    };
  }
  if (action.type === "diagnostics.list") {
    const requestedUri = action.path ? workspaceActionUri(vscode, action.path) : undefined;
    const entries = requestedUri
      ? [[requestedUri, vscode.languages.getDiagnostics(requestedUri)]]
      : vscode.languages.getDiagnostics();
    const diagnostics = [];
    let truncated = false;
    for (const [uri, items] of entries) {
      if (uri.scheme !== "file") continue;
      const relativePath = workspaceRelative(uri.fsPath);
      if (!relativePath) continue;
      for (const diagnostic of items) {
        if (diagnostics.length >= 500) {
          truncated = true;
          break;
        }
        const item = {
          path: relativePath,
          severity: ["error", "warning", "information", "hint"][diagnostic.severity] || "unknown",
          message: String(diagnostic.message).slice(0, 4_096),
          line: diagnostic.range.start.line + 1,
          column: diagnostic.range.start.character + 1,
          endLine: diagnostic.range.end.line + 1,
          endColumn: diagnostic.range.end.character + 1,
        };
        if (diagnostic.source) item.source = String(diagnostic.source).slice(0, 256);
        if (diagnostic.code !== undefined)
          item.code = String(diagnostic.code?.value ?? diagnostic.code).slice(0, 256);
        diagnostics.push(item);
      }
      if (truncated) break;
    }
    return { action: action.type, diagnostics, truncated };
  }
  if (action.type === "panel.show") {
    const commands = {
      explorer: "workbench.view.explorer",
      search: "workbench.view.search",
      "source-control": "workbench.view.scm",
      problems: "workbench.actions.view.problems",
      output: "workbench.action.output.toggleOutput",
      terminal: "workbench.action.terminal.toggleTerminal",
      "debug-console": "workbench.debug.action.toggleRepl",
    };
    const command = commands[action.panel];
    if (!command) throw new Error("The editor panel is invalid");
    await vscode.commands.executeCommand(command);
    return { action: action.type, panel: action.panel };
  }
  throw new Error("The editor action is unsupported");
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

async function activate(context) {
  const vscode = require("vscode");
  // Cake owns this embedded workbench's initial layout. Run this during eager
  // activation and finish closing the Explorer before startup work continues.
  // Users can still reopen it normally afterward.
  await vscode.commands.executeCommand("workbench.action.closeSidebar").then(undefined, () => {});
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
  // Whole-line left rule avoids the per-line border grid on multi-line ranges.
  selectionDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderWidth: "0 0 0 2px",
    borderStyle: "solid",
    borderColor: new vscode.ThemeColor("editorInfo.foreground"),
  });
  context.subscriptions.push(selectionDecoration);
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
    const requestedPath = String(payload.path || "");
    if (!requestedPath) throw new Error("A file path is required");
    let target;
    if (payload.kind === "absolute-file") {
      if (!path.isAbsolute(requestedPath)) throw new Error("An absolute file path is required");
      target = path.resolve(requestedPath);
    } else if (payload.kind === "working-directory") {
      target = path.resolve(WORKSPACE || context.extensionPath, requestedPath);
      if (!workspaceRelative(target))
        throw new Error("The source location is outside the workspace");
    } else {
      throw new Error("The editor location kind is invalid");
    }
    const targetUri = vscode.Uri.file(target);
    let fallback;
    if (payload.view === "changes") {
      const base = changesBase(payload);
      const probe = await probeWorkingTreeChange(vscode, targetUri, base);
      fallback = probe.fallback;
      if (probe.changed) {
        try {
          await openSourceControl(vscode);
          await openWorkingTreeDiff(vscode, probe.api, targetUri, base);
          const requestedRanges = payload.ranges || (payload.range ? [payload.range] : []);
          const locations = [];
          if (requestedRanges.length > 0) {
            const side = payload.side === "before" ? "before" : "after";
            await vscode.commands.executeCommand(
              side === "before"
                ? "workbench.action.compareEditor.focusPrimarySide"
                : "workbench.action.compareEditor.focusSecondarySide",
            );
            const editor = await visibleDiffEditor(vscode, target, side, base);
            if (!editor) throw new Error("The requested diff editor side is unavailable");
            locations.push(
              ...resolvedRanges(vscode, editor, requestedRanges).map((range) => ({
                kind: "working-directory",
                path: workspaceRelative(target),
                view: "changes",
                side,
                base,
                range,
              })),
            );
          }
          return { outcome: { view: "changes" }, locations };
        } catch {
          // Fall through to the ordinary source document when the diff editor
          // cannot open; the caller learns about it through the fallback.
          fallback = "git-unavailable";
        }
      }
    }
    const outcome = fallback ? { view: "file", fallback } : { view: "file" };
    const document = await vscode.workspace.openTextDocument(targetUri);
    if (Number.isInteger(payload.documentVersion) && payload.documentVersion !== document.version)
      void vscode.window.showWarningMessage(
        `This Cake source location was created for version ${payload.documentVersion}; the open document is version ${document.version}.`,
      );

    let requestedRanges = payload.ranges || (payload.range ? [payload.range] : []);
    if (requestedRanges.length === 0 && payload.symbol) {
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
        requestedRanges = [
          {
            start: { line: symbolRange.start.line, column: symbolRange.start.character },
            end: { line: symbolRange.end.line, column: symbolRange.end.character },
          },
        ];
    }
    const editor = await vscode.window.showTextDocument(document, {
      preview: payload.preview ?? false,
      preserveFocus: payload.preserveFocus ?? false,
      viewColumn: editorViewColumn(vscode, payload.group),
    });
    const locations = resolvedRanges(vscode, editor, requestedRanges).map((range) => ({
      kind: payload.kind,
      path: payload.kind === "absolute-file" ? target : workspaceRelative(target),
      view: "file",
      range,
    }));
    return { outcome, locations };
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
        if (payload.type === "script" || payload.type === "editor-action") {
          const result =
            payload.type === "script"
              ? await runScript(vscode, payload)
              : await performEditorAction(vscode, payload.action);
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify(result));
          return;
        }
        if (payload.type === "reveal") {
          const outcome = await reveal(payload);
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify(outcome));
          return;
        }
        if (payload.type === "selection-highlights") updateSelectionHighlights(vscode, payload);
        else if (payload.type === "annotations") await updateAnnotations(vscode, payload);
        else if (payload.type === "open-source-control") await openSourceControl(vscode);
        else if (payload.type === "set-theme") await setTheme(vscode, payload);
        else throw new Error("The companion request type is unsupported");
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
        selectionLocations = [];
        selectionDecoration?.dispose();
        selectionDecoration = undefined;
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
    vscode.commands.registerCommand("cake.addAnnotation", (resource) =>
      addAnnotation(vscode, resource),
    ),
    vscode.commands.registerCommand("cake.askInSideChat", (resource) =>
      askInSideChat(vscode, resource),
    ),
    vscode.commands.registerCommand("cake.backToAgent", () =>
      postBridge({ type: "back-to-agent" }),
    ),
    vscode.commands.registerCommand("cake.toggleProjectSidebar", () =>
      postBridge({ type: "toggle-project-sidebar" }),
    ),
    vscode.commands.registerCommand("cake.toggleChatSidebar", () =>
      postBridge({ type: "toggle-chat-sidebar" }),
    ),
    vscode.window.onDidChangeVisibleTextEditors(() => {
      applySelectionHighlights(vscode);
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
  selectionSubscription?.dispose();
  if (selectionTimer) clearTimeout(selectionTimer);
  selectionLocations = [];
  selectionDecoration?.dispose();
  selectionDecoration = undefined;
  revealServer?.close();
}

module.exports = { activate, deactivate };

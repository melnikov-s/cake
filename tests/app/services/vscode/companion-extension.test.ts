import { copyFile, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import Module from "node:module";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const WORKSPACE = "/workspace/project";
const companionSource = join(import.meta.dirname, "../../../../src/assets/vscode-companion");

/** Minimal stand-in for `vscode.Uri`; only the members the companion reads. */
class FakeUri {
  constructor(
    readonly scheme: string,
    readonly path: string,
    readonly query = "",
  ) {}
  get fsPath() {
    return this.path;
  }
  toString() {
    return `${this.scheme}:${this.path}${this.query ? `?${encodeURIComponent(this.query)}` : ""}`;
  }
  static file(path: string) {
    return new FakeUri("file", path);
  }
  static parse(value: string) {
    return new FakeUri("data", value);
  }
}

class FakePosition {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
  isBefore(other: FakePosition) {
    return this.line < other.line || (this.line === other.line && this.character < other.character);
  }
}

class FakeRange {
  constructor(
    readonly start: FakePosition,
    readonly end: FakePosition,
  ) {}
}

class FakeSelection extends FakeRange {}

interface FakeEditor {
  document: {
    uri: FakeUri;
    lineCount: number;
    lineAt(line: number): { text: string };
    getText(range: FakeRange): string;
  };
  selection: FakeRange & { isEmpty: boolean };
}

function editorFor(uri: FakeUri, lines: string[], start: [number, number], end: [number, number]) {
  const selection = Object.assign(
    new FakeRange(new FakePosition(...start), new FakePosition(...end)),
    { isEmpty: false },
  );
  const editor: FakeEditor = {
    document: {
      uri,
      lineCount: lines.length,
      lineAt: (line) => ({ text: lines[line] ?? "" }),
      getText: (range) =>
        lines
          .slice(range.start.line, range.end.line + 1)
          .map((text, index, selected) => {
            const from = index === 0 ? range.start.character : 0;
            const to = index === selected.length - 1 ? range.end.character : text.length;
            return text.slice(from, to);
          })
          .join("\n"),
    },
    selection,
  };
  return editor;
}

/** Git revision URI in the shape the built-in Git extension produces for diff editors. */
function gitRevisionUri(filePath: string, ref: string) {
  return new FakeUri("git", filePath, JSON.stringify({ path: filePath, ref }));
}

const commands = new Map<string, (...args: unknown[]) => unknown>();
const showInformationMessage = vi.fn();
const openTextDocument = vi.fn(async (uri: FakeUri) => ({
  uri,
  version: 1,
  lineCount: lines.length,
  lineAt: (line: number) => ({ text: lines[line] ?? "" }),
}));
const showTextDocument = vi.fn(async () => ({}));
const revealDecorations: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];

/**
 * Stand-in for the built-in Git extension's API for one repository. `status`
 * is the repository-wide refresh the companion must never trigger, `state` is
 * the cached Source Control list it must not trust, and `diffWith` is the
 * single-path probe it relies on instead.
 */
interface FakeGitRepository {
  status: ReturnType<typeof vi.fn>;
  diffWith: ReturnType<typeof vi.fn>;
  state: { workingTreeChanges: Array<{ uri: FakeUri }> };
}
let gitRepository: FakeGitRepository | undefined;
function fakeGitRepository(options: {
  workingTreeChanges?: string[];
  diff?: string | (() => Promise<string>);
}): FakeGitRepository {
  const diff = options.diff ?? "";
  return {
    status: vi.fn(async () => undefined),
    diffWith: vi.fn(typeof diff === "function" ? diff : async () => diff),
    state: {
      workingTreeChanges: (options.workingTreeChanges ?? []).map((file) => ({
        uri: FakeUri.file(file),
      })),
    },
  };
}
let visibleTextEditorsListener: (editors: unknown[]) => void = () => {};
const window = {
  activeTextEditor: undefined as FakeEditor | undefined,
  visibleTextEditors: [] as FakeEditor[],
  showInformationMessage,
  showTextDocument,
  showWarningMessage: vi.fn(),
  showInputBox: vi.fn(async () => ""),
  createTextEditorDecorationType: (options: { borderWidth?: string }) => {
    const decoration = { dispose: vi.fn() };
    if (options.borderWidth) revealDecorations.push(decoration);
    return decoration;
  },
  onDidChangeVisibleTextEditors: (listener: (editors: unknown[]) => void) => {
    visibleTextEditorsListener = listener;
    return { dispose() {} };
  },
  onDidChangeTextEditorSelection: () => ({ dispose() {} }),
  onDidChangeActiveTextEditor: () => ({ dispose() {} }),
};
const fakeVscode = {
  Uri: FakeUri,
  Position: FakePosition,
  Range: FakeRange,
  Selection: FakeSelection,
  TextEditorRevealType: { InCenter: 0 },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
  ThemeColor: class {
    constructor(readonly id: string) {}
  },
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  },
  window,
  commands: {
    executeCommand: vi.fn(async () => undefined),
    registerCommand(id: string, handler: (...args: unknown[]) => unknown) {
      commands.set(id, handler);
      return { dispose() {} };
    },
  },
  extensions: {
    getExtension: () =>
      gitRepository
        ? {
            isActive: true,
            exports: {
              getAPI: () => ({
                getRepository: () => gitRepository,
                toGitUri: (uri: FakeUri, ref: string) => gitRevisionUri(uri.fsPath, ref),
              }),
            },
          }
        : undefined,
  },
  languages: { registerCodeLensProvider: () => ({ dispose() {} }) },
  workspace: { openTextDocument },
};

const posted: Array<Record<string, unknown>> = [];
const moduleLoader = Module as unknown as {
  _load(request: string, ...rest: unknown[]): unknown;
};
const originalLoad = moduleLoader._load;
let installRoot: string;

beforeAll(async () => {
  // The manager installs the companion as `package.json` + `extension.js`; the
  // extension host loads that layout as CommonJS, unlike this ESM repository.
  installRoot = await mkdtemp(join(tmpdir(), "cake-companion-"));
  await copyFile(
    join(companionSource, "companion-manifest.json"),
    join(installRoot, "package.json"),
  );
  await copyFile(join(companionSource, "extension.js"), join(installRoot, "extension.js"));
  process.env.CAKE_BRIDGE_PORT = "4321";
  process.env.CAKE_BRIDGE_TOKEN = "token";
  process.env.CAKE_WORKSPACE_PATH = WORKSPACE;
  moduleLoader._load = function (request, ...rest) {
    if (request === "vscode") return fakeVscode;
    return originalLoad.call(this, request, ...rest);
  };
  vi.spyOn(http, "request").mockImplementation((() => ({
    on() {},
    end(body: Buffer) {
      posted.push(JSON.parse(body.toString("utf8")));
    },
    destroy() {},
  })) as unknown as typeof http.request);
  vi.spyOn(http, "createServer").mockImplementation((() => ({
    on() {},
    listen() {},
    close() {},
    address: () => undefined,
  })) as unknown as typeof http.createServer);
  const load = createRequire(import.meta.url);
  const extension = load(join(installRoot, "extension.js")) as {
    activate(context: { subscriptions: unknown[]; extensionPath: string }): Promise<void>;
  };
  await extension.activate({ subscriptions: [], extensionPath: WORKSPACE });
});

afterAll(async () => {
  moduleLoader._load = originalLoad;
  vi.restoreAllMocks();
  await rm(installRoot, { recursive: true, force: true });
});

afterEach(() => {
  window.visibleTextEditors = [];
  visibleTextEditorsListener([]);
  posted.length = 0;
  revealDecorations.length = 0;
  gitRepository = undefined;
  vi.useRealTimers();
  showInformationMessage.mockClear();
  fakeVscode.commands.executeCommand.mockClear();
  openTextDocument.mockClear();
  showTextDocument.mockReset();
  showTextDocument.mockResolvedValue({});
  window.activeTextEditor = undefined;
});

const lines = ["import a;", "", "export function run() {", "  return compute();", "}"];

describe("companion editor reveals", () => {
  it("opens an absolute local file without treating it as a workspace source location", async () => {
    await commands.get("cake.reveal")!({ kind: "absolute-file", path: "/tmp/cake.log" });

    expect(openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ scheme: "file", path: "/tmp/cake.log" }),
    );
    expect(showTextDocument).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ preview: false }),
    );
  });

  it("continues rejecting Working Directory locations that escape the workspace", async () => {
    await expect(
      commands.get("cake.reveal")!({ kind: "working-directory", path: "../outside.ts" }),
    ).rejects.toThrow("outside the workspace");
    expect(openTextDocument).not.toHaveBeenCalled();
  });

  it("reveals disjoint ranges without selecting text and retains highlights in split editors", async () => {
    const document = {
      lineCount: lines.length,
      lineAt: (line: number) => ({ text: lines[line] ?? "" }),
    };
    const leftEditor = {
      document,
      revealRange: vi.fn(),
      setDecorations: vi.fn(),
      selection: undefined,
    };
    const rightEditor = {
      document,
      revealRange: vi.fn(),
      setDecorations: vi.fn(),
      selection: undefined,
    };
    showTextDocument.mockResolvedValueOnce(leftEditor).mockResolvedValueOnce(rightEditor);

    await commands.get("cake.reveal")!({
      kind: "working-directory",
      path: "src/left.ts",
      ranges: [
        { start: { line: 1 }, end: { line: 1 } },
        { start: { line: 3 }, end: { line: 4 } },
      ],
    });
    await commands.get("cake.reveal")!({
      kind: "working-directory",
      path: "src/right.ts",
      range: { start: { line: 2 }, end: { line: 3 } },
    });

    expect(leftEditor.selection).toBeUndefined();
    expect(rightEditor.selection).toBeUndefined();
    expect(revealDecorations).toHaveLength(2);
    expect(revealDecorations[0]?.dispose).not.toHaveBeenCalled();
    expect(revealDecorations[1]?.dispose).not.toHaveBeenCalled();
    expect(leftEditor.setDecorations).toHaveBeenCalledWith(revealDecorations[0], [
      expect.anything(),
      expect.anything(),
    ]);
    expect(rightEditor.setDecorations).toHaveBeenCalledWith(revealDecorations[1], [
      expect.anything(),
    ]);
  });

  it("opens a native diff and marks the requested range without selecting text", async () => {
    const changedPath = `${WORKSPACE}/src/run.ts`;
    gitRepository = fakeGitRepository({ diff: "@@ -1 +1 @@\n-old\n+new\n" });
    const before = Object.assign(
      editorFor(gitRevisionUri(changedPath, "HEAD"), lines, [0, 0], [0, 0]),
      { revealRange: vi.fn(), setDecorations: vi.fn() },
    );
    const after = Object.assign(editorFor(FakeUri.file(changedPath), lines, [0, 0], [0, 0]), {
      revealRange: vi.fn(),
      setDecorations: vi.fn(),
    });
    window.visibleTextEditors = [before, after];
    const beforeSelection = before.selection;
    const afterSelection = after.selection;

    const outcome = await commands.get("cake.reveal")!({
      kind: "working-directory",
      path: "src/run.ts",
      view: "changes",
      side: "before",
      range: { start: { line: 2 }, end: { line: 3 } },
    });

    expect(outcome).toEqual({ view: "changes" });
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith("workbench.view.scm");
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith(
      "vscode.diff",
      expect.objectContaining({ scheme: "git", path: changedPath }),
      expect.objectContaining({ scheme: "file", path: changedPath }),
      "run.ts (Working Tree)",
      { preview: false },
    );
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith(
      "workbench.action.compareEditor.focusPrimarySide",
    );
    // A repository-wide status walk is what made large checkouts time out.
    expect(gitRepository.status).not.toHaveBeenCalled();
    expect(gitRepository.diffWith).toHaveBeenCalledWith("HEAD", changedPath);
    expect(openTextDocument).not.toHaveBeenCalled();
    expect(before.selection).toBe(beforeSelection);
    expect(before.revealRange).toHaveBeenCalledOnce();
    expect(after.revealRange).not.toHaveBeenCalled();

    await commands.get("cake.reveal")!({
      kind: "working-directory",
      path: "src/run.ts",
      view: "changes",
      range: { start: { line: 1 }, end: { line: 1 } },
    });

    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith(
      "workbench.action.compareEditor.focusSecondarySide",
    );
    expect(after.selection).toBe(afterSelection);
    expect(after.revealRange).toHaveBeenCalledOnce();
  });

  it("does not trust a stale Source Control entry once the file's changes are committed", async () => {
    const changedPath = `${WORKSPACE}/src/run.ts`;
    // The Git extension's watcher has not refreshed since an external commit.
    gitRepository = fakeGitRepository({ workingTreeChanges: [changedPath], diff: "" });

    const outcome = await commands.get("cake.reveal")!({
      kind: "working-directory",
      path: "src/run.ts",
      view: "changes",
    });

    expect(outcome).toEqual({ view: "file", fallback: "no-changes" });
    expect(gitRepository.diffWith).toHaveBeenCalledWith("HEAD", changedPath);
    expect(fakeVscode.commands.executeCommand).not.toHaveBeenCalledWith(
      "vscode.diff",
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(openTextDocument).toHaveBeenCalledOnce();
  });

  it("opens the file itself and says why when there are no uncommitted changes to diff", async () => {
    const changedPath = `${WORKSPACE}/src/run.ts`;
    gitRepository = fakeGitRepository({ diff: "" });
    const editor = {
      document: {
        lineCount: lines.length,
        lineAt: (line: number) => ({ text: lines[line] ?? "" }),
      },
      revealRange: vi.fn(),
      setDecorations: vi.fn(),
    };
    showTextDocument.mockResolvedValueOnce(editor);

    const outcome = await commands.get("cake.reveal")!({
      kind: "working-directory",
      path: "src/run.ts",
      view: "changes",
      range: { start: { line: 1 }, end: { line: 1 } },
    });

    expect(outcome).toEqual({ view: "file", fallback: "no-changes" });
    expect(gitRepository.diffWith).toHaveBeenCalledWith("HEAD", changedPath);
    expect(gitRepository.status).not.toHaveBeenCalled();
    expect(fakeVscode.commands.executeCommand).not.toHaveBeenCalledWith(
      "vscode.diff",
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ scheme: "file", path: changedPath }),
    );
    expect(showTextDocument).toHaveBeenCalledOnce();
    // The requested range is still marked in the plain file.
    expect(editor.revealRange).toHaveBeenCalledOnce();
  });

  it("compares the working tree with a requested base revision instead of HEAD", async () => {
    const changedPath = `${WORKSPACE}/src/run.ts`;
    gitRepository = fakeGitRepository({ diff: "@@ -1 +1 @@\n-old\n+new\n" });

    const outcome = await commands.get("cake.reveal")!({
      kind: "working-directory",
      path: "src/run.ts",
      view: "changes",
      base: "origin/main",
    });

    expect(outcome).toEqual({ view: "changes" });
    expect(gitRepository.diffWith).toHaveBeenCalledWith("origin/main", changedPath);
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith(
      "vscode.diff",
      expect.objectContaining({
        scheme: "git",
        path: changedPath,
        query: JSON.stringify({ path: changedPath, ref: "origin/main" }),
      }),
      expect.objectContaining({ scheme: "file", path: changedPath }),
      "run.ts (origin/main ↔ Working Tree)",
      { preview: false },
    );
  });

  it("opens the file itself and says so when Git cannot resolve the base revision", async () => {
    gitRepository = fakeGitRepository({
      diff: () => Promise.reject(new Error("fatal: bad revision 'nope'")),
    });

    const outcome = await commands.get("cake.reveal")!({
      kind: "working-directory",
      path: "src/run.ts",
      view: "changes",
      base: "nope",
    });

    expect(outcome).toEqual({ view: "file", fallback: "unknown-base" });
    expect(openTextDocument).toHaveBeenCalledOnce();
  });

  it("refuses option-like or range base revisions before touching Git", async () => {
    gitRepository = fakeGitRepository({ diff: "@@" });

    for (const base of ["--output=/tmp/x", "main..HEAD", "HEAD:src/run.ts", " "]) {
      await expect(
        commands.get("cake.reveal")!({
          kind: "working-directory",
          path: "src/run.ts",
          view: "changes",
          base,
        }),
      ).rejects.toThrow("single Git revision");
    }
    expect(gitRepository.diffWith).not.toHaveBeenCalled();
    expect(openTextDocument).not.toHaveBeenCalled();
  });

  it("falls back to the file within its time budget when Git does not answer", async () => {
    vi.useFakeTimers();
    gitRepository = fakeGitRepository({ diff: () => new Promise<string>(() => {}) });

    const pending = commands.get("cake.reveal")!({
      kind: "working-directory",
      path: "src/run.ts",
      view: "changes",
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(openTextDocument).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({ view: "file", fallback: "git-unavailable" });
    expect(openTextDocument).toHaveBeenCalledOnce();
    expect(showTextDocument).toHaveBeenCalledOnce();
  });

  it("opens the file itself and says so when the Git extension is missing", async () => {
    gitRepository = undefined;

    const outcome = await commands.get("cake.reveal")!({
      kind: "working-directory",
      path: "src/run.ts",
      view: "changes",
    });

    expect(outcome).toEqual({ view: "file", fallback: "git-unavailable" });
    expect(openTextDocument).toHaveBeenCalledOnce();
  });

  it("reports a plain file view for ordinary reveals", async () => {
    const outcome = await commands.get("cake.reveal")!({
      kind: "working-directory",
      path: "src/run.ts",
    });

    expect(outcome).toEqual({ view: "file" });
  });

  it("replaces the previous reveal highlight within the same editor", async () => {
    const editor = {
      document: {
        lineCount: lines.length,
        lineAt: (line: number) => ({ text: lines[line] ?? "" }),
      },
      revealRange: vi.fn(),
      setDecorations: vi.fn(),
      selection: undefined,
    };
    showTextDocument.mockResolvedValue(editor);

    await commands.get("cake.reveal")!({
      kind: "working-directory",
      path: "src/run.ts",
      range: { start: { line: 1 }, end: { line: 1 } },
    });
    await commands.get("cake.reveal")!({
      kind: "working-directory",
      path: "src/run.ts",
      range: { start: { line: 3 }, end: { line: 3 } },
    });

    expect(revealDecorations).toHaveLength(2);
    expect(revealDecorations[0]?.dispose).toHaveBeenCalledOnce();
    expect(revealDecorations[1]?.dispose).not.toHaveBeenCalled();
    expect(editor.setDecorations).toHaveBeenCalledTimes(2);
  });
});

describe("companion explicit selection actions in diff editors", () => {
  it("captures the original Git revision side that was right-clicked, not the active side", () => {
    const original = editorFor(
      gitRevisionUri(`${WORKSPACE}/src/run.ts`, "HEAD"),
      lines,
      [2, 0],
      [3, 20],
    );
    const modified = editorFor(FakeUri.file(`${WORKSPACE}/src/run.ts`), lines, [0, 0], [0, 6]);
    window.visibleTextEditors = [original, modified];
    window.activeTextEditor = modified;

    commands.get("cake.askInSideChat")!(original.document.uri);

    expect(showInformationMessage).not.toHaveBeenCalled();
    expect(posted).toEqual([
      {
        type: "ask-in-side-chat",
        workspace: WORKSPACE,
        path: "src/run.ts",
        startLine: 2,
        startColumn: 0,
        endLine: 3,
        endColumn: 20,
        selectedText: "export function run() {\n  return compute();",
        contextBefore: "import a;\n",
        contextAfter: "}",
      },
    ]);
  });

  it("resolves a staged (index) revision from the command palette through the active editor", async () => {
    const staged = editorFor(
      gitRevisionUri(`${WORKSPACE}/src/run.ts`, "~"),
      lines,
      [3, 2],
      [3, 19],
    );
    window.visibleTextEditors = [staged];
    window.activeTextEditor = staged;
    window.showInputBox.mockResolvedValueOnce("Why compute here?");

    await commands.get("cake.addAnnotation")!();

    expect(posted).toEqual([
      expect.objectContaining({
        type: "add-annotation",
        path: "src/run.ts",
        startLine: 3,
        endLine: 3,
        selectedText: "return compute();",
        comment: "Why compute here?",
      }),
    ]);
  });

  it("still works for ordinary working-tree files", () => {
    const editor = editorFor(FakeUri.file(`${WORKSPACE}/src/run.ts`), lines, [0, 0], [0, 9]);
    window.visibleTextEditors = [editor];
    window.activeTextEditor = editor;

    commands.get("cake.askInSideChat")!(editor.document.uri);

    expect(posted).toEqual([
      expect.objectContaining({
        type: "ask-in-side-chat",
        path: "src/run.ts",
        selectedText: "import a;",
      }),
    ]);
  });

  it("refuses documents that are neither workspace files nor Git revisions of them", () => {
    const untitled = editorFor(new FakeUri("untitled", "Untitled-1"), lines, [0, 0], [0, 9]);
    const outside = editorFor(gitRevisionUri("/elsewhere/run.ts", "HEAD"), lines, [0, 0], [0, 9]);
    window.visibleTextEditors = [untitled, outside];

    window.activeTextEditor = untitled;
    commands.get("cake.askInSideChat")!(untitled.document.uri);
    expect(showInformationMessage).toHaveBeenLastCalledWith(
      "Open a workspace file before using Cake.",
    );

    window.activeTextEditor = outside;
    commands.get("cake.askInSideChat")!(outside.document.uri);
    expect(showInformationMessage).toHaveBeenLastCalledWith(
      "Cake can only use files inside this project.",
    );
    expect(posted).toEqual([]);
  });
});

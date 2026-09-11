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
const window = {
  activeTextEditor: undefined as FakeEditor | undefined,
  visibleTextEditors: [] as FakeEditor[],
  showInformationMessage,
  showWarningMessage: vi.fn(),
  showInputBox: vi.fn(async () => ""),
  createTextEditorDecorationType: () => ({ dispose() {} }),
  onDidChangeVisibleTextEditors: () => ({ dispose() {} }),
  onDidChangeTextEditorSelection: () => ({ dispose() {} }),
  onDidChangeActiveTextEditor: () => ({ dispose() {} }),
};
const fakeVscode = {
  Uri: FakeUri,
  Position: FakePosition,
  Range: FakeRange,
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
  languages: { registerCodeLensProvider: () => ({ dispose() {} }) },
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
  posted.length = 0;
  showInformationMessage.mockClear();
  window.activeTextEditor = undefined;
  window.visibleTextEditors = [];
});

const lines = ["import a;", "", "export function run() {", "  return compute();", "}"];

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

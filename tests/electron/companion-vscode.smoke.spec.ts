import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";
import { installLocalModelHttpGuard } from "./main-harness";

const repositoryRoot = resolve(import.meta.dirname, "../..");
function chunk(delta: object, finishReason: string | null = null) {
  return `data: ${JSON.stringify({ id: "companion-vscode", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

test("Companion discovers VS Code scripting, arranges editors and configures the viewed project directly", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "cake-companion-vscode-"));
  const paths = {
    cakeHome: join(root, "cake-home"),
    project: join(root, "project"),
    userData: join(root, "user-data"),
  };
  await findVisualCaptureScenario("dictation-input")!.seed(paths, "dark");
  await writeFile(join(paths.project, "left.ts"), "export const left = 1;\n");
  await writeFile(join(paths.project, "right.ts"), "export const right = 2;\n");
  const invocations = [
    { command: "vscode" },
    { command: "vscode.enter" },
    {
      command: "vscode.script.run",
      input: {
        source: `
        const root = vscode.workspace.workspaceFolders[0].uri;
        for (const [file, column] of [['left.ts', vscode.ViewColumn.One], ['right.ts', vscode.ViewColumn.Two]]) {
          const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, file));
          await vscode.window.showTextDocument(document, { viewColumn: column, preview: false });
        }
        const settings = vscode.workspace.getConfiguration('editor');
        await settings.update('fontSize', input.size, vscode.ConfigurationTarget.Workspace);
        return { after: settings.get('fontSize'), directory: root.fsPath, files: vscode.window.visibleTextEditors.map(editor => require('node:path').basename(editor.document.uri.fsPath)).sort() };
      `,
        input: { size: 19 },
      },
    },
  ];
  const requests: Array<{ messages?: Array<{ role: string; content: unknown }> }> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (/Compaction: (?:compress message|merge lines)/.test(body)) {
      response.end(
        chunk({ content: "work: configured editor" }) + chunk({}, "stop") + "data: [DONE]\n\n",
      );
      return;
    }
    const invocation = invocations[requests.length];
    requests.push(JSON.parse(body));
    response.end(
      chunk(
        invocation
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: `vscode-${requests.length}`,
                  type: "function",
                  function: { name: "cake", arguments: JSON.stringify(invocation) },
                },
              ],
            }
          : { content: "VS Code configured." },
      ) +
        chunk({}, invocation ? "tool_calls" : "stop") +
        "data: [DONE]\n\n",
    );
  });
  await new Promise<void>((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const stateFile = join(paths.cakeHome, "state", "application.json");
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  await writeFile(
    stateFile,
    JSON.stringify({
      ...state,
      utilityModel: { provider: "conversation-visual", modelId: "fixture", thinkingLevel: "off" },
    }),
  );
  const modelsFile = join(paths.cakeHome, "pi", "models.json");
  const models = JSON.parse(await readFile(modelsFile, "utf8"));
  models.providers["conversation-visual"].baseUrl = `${origin}/v1`;
  models.providers["conversation-visual"].models[0].contextWindow = 128_000;
  await writeFile(modelsFile, JSON.stringify(models));
  const application = await electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: paths.userData,
      CAKE_HOME: paths.cakeHome,
      PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });
  try {
    await installLocalModelHttpGuard(application, origin);
    const page = await application.firstWindow();
    const trigger = page.getByRole("button", { name: "Ask session assistant", exact: true });
    await expect(trigger).toBeVisible({ timeout: 20_000 });
    await trigger.click({ button: "right" });
    const dialog = page.getByRole("dialog", { name: "Session assistant chat", exact: true });
    const input = dialog.getByRole("combobox", { name: "Message session assistant", exact: true });
    await expect(input).toBeFocused();
    await input.pressSequentially(
      "Open left.ts and right.ts side-by-side and set this workspace's editor font size to 19.",
    );
    await expect(input).toHaveValue(/side-by-side/);
    await expect(dialog.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "Send", exact: true }).click();
    await expect(dialog.getByText("VS Code configured.", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    expect(requests).toHaveLength(4);
    const toolResults = requests
      .at(-1)!
      .messages!.filter((message) => message.role === "tool")
      .map((message) => JSON.stringify(message.content))
      .join("\n");
    expect(toolResults).toContain("vscode.script.run");
    expect(toolResults).toContain("left.ts");
    expect(toolResults).toContain("right.ts");
    expect(toolResults).toContain(paths.project);
    const settings = JSON.parse(
      await readFile(join(paths.project, ".vscode", "settings.json"), "utf8"),
    );
    expect(settings["editor.fontSize"]).toBe(19);
    // Only Companion's model was called; no delegation or turn in the main agent.
    expect(
      requests.every((request) => JSON.stringify(request.messages).includes("app-wide companion")),
    ).toBe(true);
    await expect(page.getByRole("region", { name: "VS Code workspace" })).toBeVisible();
  } finally {
    await application.close();
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true });
  }
});

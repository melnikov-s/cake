import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { CAKE_CHAT_SESSION_ID } from "../../src/contracts/cake-chats/cake-chat-identity";
import { seedCakeChatHistory } from "./durable-chat-fixture";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const templateId = "reusable-checklist";
const instanceId = "independent-checklist";
const templateState = {
  title: "Original checklist",
  items: [{ text: "Original item", done: false }],
};
const source = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<main><h1></h1><label><input type="checkbox"><span></span></label></main>
<script>
const api = globalThis.cakeArtifact;
const checkbox = document.querySelector('input');
function render() {
  const snapshot = api.getSnapshot();
  if (!snapshot.hydrated) return;
  document.querySelector('h1').textContent = snapshot.value.title;
  document.querySelector('span').textContent = snapshot.value.items[0].text;
  checkbox.checked = snapshot.value.items[0].done;
}
api.subscribe(render);
api.read().then(render);
checkbox.addEventListener('change', async () => {
  const snapshot = api.getSnapshot();
  await api.replace({ ...snapshot.value, items: [{ ...snapshot.value.items[0], done: checkbox.checked }] }, snapshot.version);
});
</script></body></html>`;

const reactSource = `import { useArtifactState } from '@cake/artifact-sdk';
export default function Checklist() {
  const { value, hydrated, save } = useArtifactState({ title: '', items: [{ text: '', done: false }] });
  if (!hydrated) return null;
  return <main><h1>{value.title}</h1><label>
    <input type="checkbox" checked={value.items[0].done} onChange={event => void save({
      ...value, items: [{ ...value.items[0], done: event.target.checked }]
    })} /><span>{value.items[0].text}</span>
  </label></main>;
}`;

for (const language of ["html", "react"] as const) {
  test(`retained ${language} widget creates independent editable documents without new source`, async () => {
    test.setTimeout(90_000);
    const root = await mkdtemp(join(tmpdir(), "cake-widget-instantiation-"));
    const cakeHome = join(root, "cake-home");
    const project = join(root, "project");
    const userData = join(root, "user-data");
    await Promise.all([
      mkdir(join(cakeHome, "state"), { recursive: true }),
      mkdir(project, { recursive: true }),
      mkdir(userData, { recursive: true }),
    ]);
    await writeFile(
      join(cakeHome, "state/application.json"),
      JSON.stringify({ schemaVersion: 1, projects: [], trustedProjectPaths: [] }),
    );
    await seedCakeChatHistory(cakeHome, `cake://artifact/${templateId}`);
    const launch = () =>
      electron.launch({
        args: [repositoryRoot],
        cwd: repositoryRoot,
        env: {
          ...process.env,
          CAKE_ELECTRON_SMOKE: "1",
          CAKE_ELECTRON_USER_DATA: userData,
          CAKE_HOME: cakeHome,
          PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
          PI_CODING_AGENT_SESSION_DIR: "",
        },
      });
    let app: ElectronApplication | undefined;
    const invoke = async <Result>(
      command: string,
      input: Record<string, unknown>,
    ): Promise<Result> => {
      if (!app) throw new Error("Test application is closed");
      const result = await app.evaluate(
        async (_electron, request) => {
          const operation = Reflect.get(globalThis, "cakeSmokeInvokeArtifact") as (
            value: typeof request,
          ) => Promise<{ details: { result: Result } }>;
          return operation(request);
        },
        { sessionId: CAKE_CHAT_SESSION_ID, workingDirectory: project, command, input },
      );
      return result.details.result;
    };
    type ChecklistState = { version: number; value: typeof templateState };
    try {
      app = await launch();
      let page = await app.firstWindow();
      await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
      await app.evaluate(
        async (_electron, input) => {
          const capture = Reflect.get(globalThis, "cakeSmokeCaptureInlineWidget") as (
            value: typeof input,
          ) => Promise<unknown>;
          await capture(input);
        },
        {
          sessionId: CAKE_CHAT_SESSION_ID,
          workingDirectory: project,
          artifactId: templateId,
          language,
          source: language === "html" ? source : reactSource,
          artifactState: templateState,
          capability: "artifact",
        },
      );
      const original = await invoke<ChecklistState>("artifacts.state.read", {
        lineageId: templateId,
      });
      await invoke("widgets.instantiate", {
        id: instanceId,
        title: "Reusable checklist copy",
        reference: `cake://artifact/${templateId}@r1`,
        initialState: {
          title: "Independent checklist",
          items: [{ text: "Independent item", done: false }],
        },
        fallback: { markdown: "Independent editable checklist." },
      });
      const openInstance = async () => {
        await page.getByRole("button", { name: "2 artifacts", exact: true }).click();
        await page
          .getByRole("dialog", { name: "Artifacts", exact: true })
          .getByRole("button", { name: /Reusable checklist copy/ })
          .click();
        return page
          .getByRole("dialog", { name: "Reusable checklist copy", exact: true })
          .locator(`[data-artifact-id="${instanceId}"] iframe`)
          .first();
      };
      let iframe = await openInstance();
      const drawing = iframe.contentFrame();
      await expect(drawing.getByRole("heading", { name: "Independent checklist" })).toBeVisible();
      await expect(drawing.getByText("Independent item", { exact: true })).toBeVisible();
      const src = await iframe.getAttribute("src");
      await drawing.getByRole("checkbox").click();
      await expect(drawing.getByRole("checkbox")).toBeChecked();
      await expect
        .poll(
          async () =>
            (
              await invoke<ChecklistState>("artifacts.state.read", {
                lineageId: instanceId,
              })
            ).value.items[0]?.done,
        )
        .toBe(true);
      const beforeEdit = await invoke<ChecklistState>("artifacts.state.read", {
        lineageId: instanceId,
      });
      await invoke("artifacts.state.update", {
        lineageId: instanceId,
        expectedVersion: beforeEdit.version,
        edits: [{ op: "set", path: "/title", value: "Updated checklist" }],
      });
      await expect(drawing.getByRole("heading", { name: "Updated checklist" })).toBeVisible();
      expect(await iframe.getAttribute("src")).toBe(src);
      expect(
        await invoke<ChecklistState>("artifacts.state.read", { lineageId: templateId }),
      ).toEqual(original);
      expect(await invoke("artifacts.resolve-reference", { reference: instanceId })).toMatchObject({
        selectedRevision: 1,
      });
      await app.close();
      app = await launch();
      page = await app.firstWindow();
      await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
      iframe = await openInstance();
      await expect(
        iframe.contentFrame().getByRole("heading", { name: "Updated checklist" }),
      ).toBeVisible();
      await expect(iframe.contentFrame().getByRole("checkbox")).toBeChecked();
      expect(
        await invoke<ChecklistState>("artifacts.state.read", { lineageId: templateId }),
      ).toEqual(original);
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every(
            (window) => !window.isVisible() && !window.isFocused(),
          ),
        ),
      ).toBe(true);
    } finally {
      await app?.close();
      await promisify(execFile)("chmod", ["-R", "u+w", root]);
      await rm(root, { recursive: true, force: true });
    }
  });
}

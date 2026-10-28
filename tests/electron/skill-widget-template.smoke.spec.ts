import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { CAKE_CHAT_SESSION_ID } from "../../src/contracts/cake-chats/cake-chat-identity";
import { seedCakeChatHistory } from "./durable-chat-fixture";

const repositoryRoot = resolve(import.meta.dirname, "../..");
type Element = {
  id: string;
  type: string;
  text?: string;
  originalText?: string;
  containerId?: string;
  boundElements?: { id: string }[];
  [key: string]: unknown;
};
type State = {
  version: number;
  value: { elements: Element[]; skeleton?: unknown; [key: string]: unknown };
};

test("a portable skill and added library create independent native drawings with no prior artifact and retain editing across reopen", async () => {
  test.setTimeout(180_000);
  // Keep esbuild's package-ancestor traversal out of the crowded OS temp directory.
  const fixtures = join(repositoryRoot, ".visual-captures/widget-fixtures");
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(join(fixtures, "skill-template-"));
  const cakeHome = join(root, "cake-home");
  const project = join(root, "project");
  const userData = join(root, "user-data");
  const skillDirectory = join(project, ".agents/skills/excalidraw-artifacts");
  await Promise.all([
    mkdir(join(cakeHome, "state"), { recursive: true }),
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
  ]);
  await cp(join(repositoryRoot, ".agents/skills/excalidraw-artifacts"), skillDirectory, {
    recursive: true,
  });
  await writeFile(
    join(cakeHome, "state/application.json"),
    JSON.stringify({ schemaVersion: 1, projects: [], trustedProjectPaths: [] }),
  );
  await seedCakeChatHistory(cakeHome, "Create a Hello World diagram in Excalidraw.");
  let app: ElectronApplication | undefined;
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
  const invoke = async <T>(command: string, input: Record<string, unknown>): Promise<T> => {
    const response = await app!.evaluate(
      async (_electron, request) => {
        const invoke = Reflect.get(globalThis, "cakeSmokeInvokeArtifact") as (
          input: typeof request,
        ) => Promise<{ details: { result: T } }>;
        return invoke(request);
      },
      { sessionId: CAKE_CHAT_SESSION_ID, workingDirectory: project, command, input },
    );
    return response.details.result;
  };
  const packages = async (operation: "list" | "install" | "remove", value?: string) =>
    app!.evaluate(
      async (_electron, input) => {
        const manage = Reflect.get(globalThis, "cakeSmokeWidgetPackage") as (
          input: typeof request,
        ) => Promise<{ packages: unknown[] }>;
        const request = input;
        return manage(request);
      },
      { operation, value },
    );
  try {
    app = await launch();
    let page = await app.firstWindow();
    await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
    expect(await invoke("artifacts.list", {})).toMatchObject({ total: 0 });
    expect((await packages("list")).packages).toEqual([]);
    // Explicit fixture setup models the user's one-time library addition, NOT an agent request step.
    await packages("install", "@excalidraw/excalidraw@0.18.1");
    const preparationStarted = performance.now();
    await app.evaluate(
      async (_electron, input) => {
        const prepare = Reflect.get(globalThis, "cakeSmokePrepareWidgetTemplates") as (
          input: typeof request,
        ) => Promise<unknown>;
        const request = input;
        return prepare(request);
      },
      {
        sessionId: CAKE_CHAT_SESSION_ID,
        workingDirectory: project,
        skills: [{ name: "excalidraw-artifacts", baseDir: skillDirectory }],
      },
    );
    const preparationMs = performance.now() - preparationStarted;
    const calls: string[] = [];
    const requestStarted = performance.now();
    calls.push("read SKILL.md");
    const skill = await readFile(join(skillDirectory, "SKILL.md"), "utf8");
    const examples = [...skill.matchAll(/```json\n([^`]+)```/g)]
      .slice(0, 2)
      .map((match) => JSON.parse(match[1]!));
    calls.push("widgets.instantiate");
    const hello = await invoke<{
      artifactId: string;
      execution: { compiled: boolean; generated: boolean };
    }>(examples[0].command, examples[0].input);
    const requestMs = performance.now() - requestStarted;
    expect(hello.execution).toMatchObject({ compiled: false, generated: false });
    expect(calls).toEqual(["read SKILL.md", "widgets.instantiate"]);
    const secondStarted = performance.now();
    const flow = await invoke<{ artifactId: string }>(examples[1].command, examples[1].input);
    const secondCreationMs = performance.now() - secondStarted;
    expect(flow.artifactId).not.toBe(hello.artifactId);
    const open = async (title: string, id: string) => {
      await page.getByRole("button", { name: "2 artifacts", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Artifacts", exact: true })
        .getByRole("button", { name: new RegExp(title) })
        .click();
      return page
        .getByRole("complementary", { name: "Artifact", exact: true })
        .locator(`[data-artifact-id="${id}"] iframe`)
        .first();
    };
    const scope = { lineageId: hello.artifactId };
    let iframe = await open("Hello World", hello.artifactId);
    let drawing = iframe.contentFrame();
    await expect(drawing.locator(".excalidraw canvas").first()).toBeVisible();
    await expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-downloads");
    await expect
      .poll(async () =>
        (await invoke<State>("artifacts.state.read", scope)).value.elements?.some(
          (e) => e.type === "text" && e.originalText === "Hello World",
        ),
      )
      .toBe(true);
    let initialized = await invoke<State>("artifacts.state.read", scope);
    expect(initialized.value.skeleton).toBeUndefined();
    const label = initialized.value.elements.find((e) => e.type === "text")!;
    expect(label.containerId).toBe("hello");
    expect(initialized.value.elements.find((e) => e.id === "hello")!.boundElements).toContainEqual({
      type: "text",
      id: label.id,
    });
    // Genuine native canvas input, not a test-side state replacement.
    await drawing
      .getByTitle(/Rectangle/)
      .first()
      .click();
    const canvas = drawing.locator("canvas.interactive");
    const bounds = await canvas.boundingBox();
    if (!bounds) throw new Error("Native interactive canvas is unavailable");
    await page.mouse.move(bounds.x + 360, bounds.y + 250);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 450, bounds.y + 320, { steps: 8 });
    await page.mouse.up();
    await drawing.getByRole("button", { name: "Save drawing", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await invoke<State>("artifacts.state.read", scope)).value.elements.filter(
            (e) => e.type === "rectangle",
          ).length,
      )
      .toBe(2);
    const manual = (await invoke<State>("artifacts.state.read", scope)).value.elements.find(
      (e) => e.type === "rectangle" && e.id !== "hello",
    )!;
    // The second diagram uses the same renderer, not this drawing's mutable state.
    const secondIframe = await open("Client and API", flow.artifactId);
    await expect(secondIframe.contentFrame().locator(".excalidraw canvas").first()).toBeVisible();
    await expect
      .poll(async () =>
        (
          await invoke<State>("artifacts.state.read", { lineageId: flow.artifactId })
        ).value.elements?.some((e) => e.id === "request" && e.type === "arrow"),
      )
      .toBe(true);
    const secondState = await invoke<State>("artifacts.state.read", { lineageId: flow.artifactId });
    expect(
      secondState.value.elements
        .filter((e) => e.type === "text")
        .map((e) => e.originalText)
        .sort(),
    ).toEqual(["API", "Client", "Request"]);
    expect(secondState.value.elements.some((e) => e.id === manual.id)).toBe(false);
    const flowBefore = structuredClone(secondState.value.elements);
    // Data-only follow-up preserves the native manually drawn object and the other document.
    initialized = await invoke<State>("artifacts.state.read", scope);
    const index = initialized.value.elements.findIndex((e) => e.id === label.id);
    await invoke("artifacts.state.update", {
      ...scope,
      expectedVersion: initialized.version,
      edits: [
        { op: "set", path: `/elements/${index}/text`, value: "Hello Universe" },
        { op: "set", path: `/elements/${index}/originalText`, value: "Hello Universe" },
      ],
    });
    iframe = await open("Hello World", hello.artifactId);
    drawing = iframe.contentFrame();
    await expect(drawing.locator(".excalidraw canvas").first()).toBeVisible();
    await expect
      .poll(
        async () =>
          (await invoke<State>("artifacts.state.read", scope)).value.elements.find(
            (e) => e.id === label.id,
          )?.originalText,
      )
      .toBe("Hello Universe");
    expect(
      (await invoke<State>("artifacts.state.read", scope)).value.elements.find(
        (e) => e.id === manual.id,
      ),
    ).toEqual(manual);
    expect(
      (await invoke<State>("artifacts.state.read", { lineageId: flow.artifactId })).value.elements,
    ).toEqual(flowBefore);
    // Retained output must reopen without the package or even the originating skill.
    await packages("remove", "@excalidraw/excalidraw");
    await rm(skillDirectory, { recursive: true, force: true });
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
    iframe = await open("Hello World", hello.artifactId);
    await expect(iframe.contentFrame().locator(".excalidraw canvas").first()).toBeVisible();
    expect((await invoke<State>("artifacts.state.read", scope)).value.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: manual.id }),
        expect.objectContaining({ id: label.id, originalText: "Hello Universe" }),
      ]),
    );
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((w) => !w.isVisible() && !w.isFocused()),
      ),
    ).toBe(true);
    await test.info().attach("request-path", {
      body: JSON.stringify(
        {
          startupPreparationMs: preparationMs,
          requestMs,
          calls,
          secondCreationMs,
          verification:
            "deterministic operation + real hidden Electron native editing/save/reopen; no live model routing test; inline pointer emission covered separately",
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  } finally {
    await app?.close();
    await promisify(execFile)("chmod", ["-R", "u+w", root]);
    await rm(root, { recursive: true, force: true });
  }
});

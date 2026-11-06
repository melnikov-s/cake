import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { WorkflowProgram } from "../../src/contracts/workflows/workflow-data";

const program = (body: string, args: WorkflowProgram["args"]): WorkflowProgram => ({
  meta: { name: "test-run", description: "Sandbox integration" },
  source: `export const meta = { name: "test-run", description: "Sandbox integration" };\n${body}`,
  sourcePath: "/test/workflow.js",
  args,
});

test("resolves worker and WebAssembly assets from the compiled Electron backend", async () => {
  const root = await mkdtemp(join(process.cwd(), ".workflow-electron-test-"));
  const app = await electron.launch({
    args: [process.cwd()],
    cwd: process.cwd(),
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: join(root, "user-data"),
      CAKE_HOME: join(root, "home"),
      PI_CODING_AGENT_DIR: join(root, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });
  try {
    // The backend hook is ready before renderer hydration. Wait for the
    // renderer's save responder too, so ordinary app.close can flush state.
    const page = await app.firstWindow();
    await page.getByRole("heading", { name: "What should we build?" }).waitFor();
    const result = await app.evaluate(
      async (_electron, input) => {
        // The compiled main's test-only hook executes the production backend Service.
        const hooks = globalThis as typeof globalThis & {
          cakeSmokeWorkflowSandbox: (value: WorkflowProgram) => Promise<unknown>;
        };
        return await hooks.cakeSmokeWorkflowSandbox(input);
      },
      program("return { answer: await agent(args.message), process: typeof process };", {
        message: "compiled-electron-ok",
      }),
    );
    expect(result).toEqual({ answer: "compiled-electron-ok", process: "undefined" });
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
      ),
    ).toBe(true);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

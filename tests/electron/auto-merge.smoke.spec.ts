import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test, type Page } from "@playwright/test";
import type { ElectronRpcTransport } from "../../src/ipc/transport/ElectronRpcTransport";
import type { WorktreeOperationCatalogUpdate } from "../../src/contracts/worktrees/worktree-operation-data";

const repositoryRoot = resolve(import.meta.dirname, "../..");

/** Exercise the supported preload RPC, not a test-only preference writer or a renderer mock. */
async function request(page: Page, tag: string, payload: object | null = {}, stream = false) {
  return page.evaluate(
    ({ tag, payload, stream }) =>
      new Promise<unknown>((resolveRequest, reject) => {
        const rpc = (window as unknown as { cake: { rpc: ElectronRpcTransport } }).cake.rpc;
        const id = String(Date.now() * 1000 + Math.floor(Math.random() * 1000));
        const unsubscribe = rpc.subscribe((input) => {
          const message = input as {
            _tag: string;
            requestId?: string;
            values?: unknown[];
            exit?: { _tag: string; value?: unknown };
          };
          if (String(message.requestId) !== id) return;
          if (stream && message._tag === "Chunk") {
            rpc.send({ _tag: "Interrupt", requestId: id });
            unsubscribe();
            resolveRequest(message.values?.[0]);
          } else if (message._tag === "Exit") {
            unsubscribe();
            if (message.exit?._tag === "Success") resolveRequest(message.exit.value);
            else reject(new Error(JSON.stringify(message.exit)));
          }
        });
        rpc.send({ _tag: "Request", id, tag, payload, headers: [] });
      }),
    { tag, payload, stream },
  );
}

const preference = async (page: Page, projectPath: string) => {
  const update = (await request(
    page,
    "managedWorktrees.observeOperations",
    null,
    true,
  )) as WorktreeOperationCatalogUpdate;
  return (
    update.autoMergeProjects?.find((project) => project.projectPath === projectPath)?.enabled ??
    false
  );
};

test("project Auto-merge persists through supported storage and two isolated Electron relaunches", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), "cake-auto-merge-")));
  const userData = join(root, "user-data");
  const projectA = join(root, "project-a");
  const projectB = join(root, "project-b");
  const cakeHome = join(root, "cake-home");
  await Promise.all([mkdir(userData), mkdir(projectA), mkdir(projectB)]);
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
  const evidence: object[] = [];
  try {
    for (const phase of ["initial", "enabled-relaunch", "disabled-relaunch"] as const) {
      const app = await launch();
      try {
        const page = await app.firstWindow();
        await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible({
          timeout: 20_000,
        });
        if (phase === "initial") {
          for (const path of [projectA, projectB]) {
            // Replace only the OS dialog, retaining canonicalization and approval.
            await app.evaluate(({ dialog }, selected) => {
              dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
            }, path);
            expect(await request(page, "electron.choose-project")).toEqual({ path });
            await request(page, "workspaces.register-project", {
              path,
              name: path === projectA ? "Project A" : "Project B",
            });
          }
          expect(await preference(page, projectA)).toBe(false);
          await request(page, "managedWorktrees.setAutoMerge", {
            projectPath: projectA,
            enabled: true,
          });
        }
        const enabled = phase !== "disabled-relaunch";
        expect(await preference(page, projectA)).toBe(enabled);
        expect(await preference(page, projectB)).toBe(false);
        const document = JSON.parse(
          await readFile(join(cakeHome, "state", "application.json"), "utf8"),
        );
        expect(
          document.data.projects.find((project: { path: string }) => project.path === projectA)
            .autoMergeEnabled,
        ).toBe(enabled);
        evidence.push({ phase, projectA: enabled, projectB: false, storedProjectA: enabled });
        if (phase === "enabled-relaunch")
          await request(page, "managedWorktrees.setAutoMerge", {
            projectPath: projectA,
            enabled: false,
          });
        // These fresh projects have no sessions/readiness, so no Git merge can run.
      } finally {
        await app.close();
      }
    }
    await testInfo.attach("auto-merge-restart-evidence", {
      body: JSON.stringify(evidence, null, 2),
      contentType: "application/json",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

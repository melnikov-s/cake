import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { CAKE_CHAT_SESSION_ID } from "../../src/contracts/cake-chats/cake-chat-identity";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { WINDOW_STATE_DOCUMENT_VERSION } from "../../src/services/storage/WindowStateStorage";
import { store } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const originalInput = "Recover this unsent composer input";
const localDraft = "Recover this legacy localDraft too";
const savedId = "00000000-0000-4000-8000-000000000001";

function snapshot(project: string) {
  return store(
    {},
    {
      cakeChatCollectionStore: store(
        {},
        {
          registry: store(
            { targets: [CAKE_CHAT_SESSION_ID] },
            {
              sessions: [
                {
                  key: CAKE_CHAT_SESSION_ID,
                  ...store(
                    {},
                    {
                      conversationSessionStore: store(
                        {},
                        {
                          chatStore: store({ localDraft }),
                          composerStore: store(
                            {},
                            {
                              draftStore: store({
                                text: originalInput,
                                attachments: [],
                                annotations: [],
                              }),
                            },
                          ),
                        },
                      ),
                    },
                  ),
                },
              ],
            },
          ),
        },
      ),
      // A valid legacy saved record would trigger a migration write before renderer decode
      // in the regression. It must not be imported/stripped from a malformed snapshot.
      sessionRegistry: store(
        { targets: [{ sessionId: savedId, workspacePath: project }] },
        {
          pendingSessions: store(
            { conversationIds: [savedId], temporarySessionIds: [savedId] },
            {
              conversations: [
                {
                  key: savedId,
                  ...store({ name: "Saved", draftPrompt: { text: "Saved task", attachments: [] } }),
                },
              ],
            },
          ),
        },
      ),
    },
  );
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cake-window-hydration-"));
  const userData = join(directory, "user-data");
  const cakeHome = join(directory, "cake-home");
  const project = join(directory, "project");
  await Promise.all(
    [userData, project, join(cakeHome, "state")].map((path) => mkdir(path, { recursive: true })),
  );
  const timestamp = new Date(0).toISOString();
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      version: 7,
      data: {
        ...defaultApplicationState(),
        projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp }],
      },
    }),
  );
  const document = join(userData, "window-state.json");
  const launch = () =>
    electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        // A Cake-hosted agent inherits the running dev server URL. Test this worktree's build.
        ELECTRON_RENDERER_URL: "",
        CAKE_ELECTRON_USER_DATA: userData,
        CAKE_HOME: cakeHome,
        PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
  return { directory, document, cakeHome, launch };
}

for (const failure of ["malformed JSON", "unsupported version", "invalid snapshot"] as const) {
  test(`preserves the original unsent input after ${failure}, UI edits, and shutdown flush`, async () => {
    const f = await fixture();
    const data = snapshot(join(f.directory, "project"));
    const original =
      failure === "malformed JSON"
        ? JSON.stringify({ version: WINDOW_STATE_DOCUMENT_VERSION, data }).slice(0, -1)
        : JSON.stringify({
            version: failure === "unsupported version" ? -1 : WINDOW_STATE_DOCUMENT_VERSION,
            data:
              failure === "invalid snapshot"
                ? { ...data, children: { ...data.children, invalidChild: 42 } }
                : data,
          });
    await writeFile(f.document, original);
    const application = await f.launch();
    let closed = false;
    try {
      const page = await application.firstWindow();
      await expect(
        page.getByText("Window state could not be restored", { exact: true }),
      ).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText(/Window-state saving is disabled for this window/)).toBeVisible();
      const composer = page.getByRole("combobox", { name: "Message Cake Chat", exact: true });
      await composer.fill("New input after failed hydration");
      await expect(composer).toHaveValue("New input after failed hydration");
      // Exercise the ordinary debounced save, then the native shutdown flush separately.
      await page.waitForTimeout(500);
      expect(await readFile(f.document, "utf8")).toBe(original);
      await application.close();
      closed = true;
      expect(await readFile(f.document, "utf8")).toBe(original);
      await expect(
        readFile(join(f.cakeHome, "state", "saved-drafts.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(original).toContain(originalInput);
      expect(original).toContain(localDraft);
    } finally {
      if (!closed) await application.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });
}

for (const existing of [false, true]) {
  test(`${existing ? "successfully hydrated" : "missing"} window document persists unsent input and restores it on restart`, async () => {
    test.setTimeout(60_000);
    const f = await fixture();
    if (existing)
      await writeFile(
        f.document,
        JSON.stringify({
          version: WINDOW_STATE_DOCUMENT_VERSION,
          data: snapshot(join(f.directory, "project")),
        }),
      );
    let application = await f.launch();
    try {
      let page = await application.firstWindow();
      let composer = page.getByRole("combobox", { name: "Message Cake Chat", exact: true });
      await expect(composer).toHaveValue(existing ? originalInput : "", { timeout: 20_000 });
      await expect(
        page.getByRole("status").filter({ hasText: "Window state could not be restored" }),
      ).toHaveCount(0);
      await composer.fill("Persist this new unsent input");
      await expect
        .poll(async () =>
          readFile(f.document, "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return "";
            throw error;
          }),
        )
        .toContain("Persist this new unsent input");
      await application.close();
      application = await f.launch();
      page = await application.firstWindow();
      composer = page.getByRole("combobox", { name: "Message Cake Chat", exact: true });
      await expect(composer).toHaveValue("Persist this new unsent input", { timeout: 20_000 });
      await expect(
        page.getByText("Window state could not be restored", { exact: true }),
      ).toHaveCount(0);
    } finally {
      await application.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });
}

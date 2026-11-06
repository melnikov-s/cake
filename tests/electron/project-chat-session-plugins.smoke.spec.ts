import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { sessionPluginsScenario } from "../../scripts/visual-capture/scenarios";
import {
  defaultApplicationState,
  type ApplicationState,
} from "../../src/contracts/application/application-data";
import { CAKE_CHAT_SESSION_ID } from "../../src/contracts/cake-chats/cake-chat-identity";
import { emptyProjectTodos } from "../../src/contracts/projects/project-todos";
import { callRpcHarness, openRpcHarness } from "./rpc-harness";

const repository = resolve(import.meta.dirname, "../..");

// Scripted model output, not a product component or a snapshot of real user data.
// The real private builder writes this file, compiles it, captures it and reviews it.
const paginatorSource = `import { useEffect, useState } from "react";
import { useCake, usePluginState } from "@cake/plugin-sdk";
export default function Paginator() {
  const cake = useCake();
  const [state, setState] = usePluginState({ page: 0 });
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setData(null);
    cake.call("todos.list", { state: "open", limit: 5, offset: state.page * 5 }).then(({ result }) => {
      if (!active) return;
      const last = Math.max(0, Math.ceil(result.total / 5) - 1);
      if (state.page > last) setState({ page: last });
      else setData(result);
    }).catch((failure) => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [state.page]);
  if (error) return <p role="alert">{error}</p>;
  if (!data) return <p>Loading open to-dos</p>;
  const pages = Math.ceil(data.total / 5);
  return <section aria-label="Open to-do navigator">
    <ul style={{ margin: 0, paddingLeft: "1.2em" }}>{data.items.map(item => <li key={item.id}>
      <span>{item.title}</span>
      {item.needsAttention && <span style={{ color: "var(--attention)" }}> — Needs attention: {item.attentionReason}</span>}
    </li>)}</ul>
    {!data.total && <p>No open to-dos</p>}
    <nav aria-label="To-do pages">
      <button disabled={!state.page} onClick={() => setState({ page: state.page - 1 })}>Previous</button>
      <output aria-live="polite">Page {pages ? state.page + 1 : 0} / {pages}</output>
      <button disabled={data.nextOffset === null} onClick={() => setState({ page: state.page + 1 })}>Next</button>
    </nav>
  </section>;
}`;

test("Project Chat generates a live read-only Session Plugin paginator with durable pages and scoped operations", async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "cake-project-chat-plugins-"));
  const paths = {
    project: join(root, "project"),
    cakeHome: join(root, "cake-home"),
    userData: join(root, "user-data"),
  };
  await sessionPluginsScenario.seed(paths, "dark");
  await mkdir(join(root, "home"));
  const sessionId = `project-chat:${createHash("sha256").update(paths.project).digest("hex")}`;
  const timestamp = new Date(0).toISOString();
  const todos = {
    ...emptyProjectTodos(),
    items: Array.from({ length: 12 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      title: `Fixture task ${index + 1}`,
      description: "Isolated test data",
      status: "Open",
      state: index === 11 ? ("done" as const) : ("open" as const),
      revision: 0,
      createdAt: new Date(index * 1000).toISOString(),
      associations: [],
      ...(index === 0 ? { needsAttention: true, attentionReason: "Choose the next step" } : {}),
    })),
  };
  const generatedRequests: string[] = [];
  let screenshotReviews = 0;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const messages = JSON.parse(body).messages as Array<{ role: string; content: unknown }>;
    const latest = messages.at(-1);
    const review = JSON.stringify(latest?.content).includes(
      "Cake rendered the current widget files",
    );
    if (review) screenshotReviews += 1;
    const ordinary = JSON.stringify(latest?.content).includes("Explain fixture");
    const writing = latest?.role !== "tool" && !review && !ordinary;
    if (writing) generatedRequests.push(body);
    const delta = writing
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "write-plugin",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({ path: "widget/widget.tsx", content: paginatorSource }),
              },
            },
          ],
        }
      : {
          role: "assistant",
          content: ordinary ? "Ordinary chat reply." : review ? "ACCEPT_CURRENT" : "Plugin ready.",
        };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [value, finish_reason] of [
      [delta, null],
      [{}, writing ? "tool_calls" : "stop"],
    ])
      response.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "vision", choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`,
      );
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Model fixture unavailable");
  const presetId = "00000000-0000-4000-8000-000000000001";
  await writeFile(
    join(paths.cakeHome, "pi", "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "fixture",
          api: "openai-completions",
          models: [
            {
              id: "vision",
              name: "Fixture vision",
              reasoning: false,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200_000,
              maxTokens: 8192,
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    join(paths.cakeHome, "state", "application.json"),
    JSON.stringify({
      version: 9,
      data: {
        ...defaultApplicationState(),
        projects: [
          {
            path: paths.project,
            name: "Plugin fixture",
            addedAt: timestamp,
            lastOpenedAt: timestamp,
            todos,
          },
        ],
        modelPresets: [
          {
            id: presetId,
            name: "Fixture",
            provider: "fixture",
            modelId: "vision",
            thinkingLevel: "off",
            fastMode: false,
          },
        ],
        defaultModelPresetId: presetId,
      },
    }),
  );
  const app = await electron.launch({
    args: [repository],
    cwd: repository,
    env: {
      ...process.env,
      HOME: join(root, "home"),
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: paths.userData,
      CAKE_HOME: paths.cakeHome,
      PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
    await page
      .getByRole("button", { name: /^Open Project Chat for / })
      .first()
      .click();
    await expect(page.getByRole("combobox", { name: "Message Project Chat" })).toBeVisible();
    const harness = await openRpcHarness(app, "project-chat-plugins");
    const call = (owner: string, command: string, input = {}) =>
      callRpcHarness(harness, "callCakeChatOperation", { sessionId: owner, command, input });
    const readState = () => callRpcHarness<ApplicationState>(harness, "getApplicationState");
    await call(sessionId, "plugins.present", {
      plugin: {
        id: "open-todos",
        title: "Open to-dos",
        brief:
          "Read-only live to-do paginator: five open items per page, Previous/Next, page count and labeled needs-attention accent. Use todos.list via useCake and durable usePluginState. No edit or completion actions or links.",
        initialState: { page: 0 },
      },
    });
    expect(generatedRequests).toHaveLength(1);
    expect(screenshotReviews).toBe(1);
    const frame = () => page.frameLocator('iframe[title="Open to-dos"]');
    await expect(frame().getByText("Page 1 / 3")).toBeVisible();
    await expect(frame().locator("li")).toHaveCount(5);
    await expect(frame().getByRole("button", { name: "Previous" })).toBeDisabled();
    await expect(
      frame().getByText("Needs attention: Choose the next step", { exact: false }),
    ).toBeVisible();
    await expect(frame().getByRole("button")).toHaveCount(2);
    const before = (await readState()).projects[0]!.todos!.items;
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await expect(frame().locator("html")).toHaveAttribute("data-theme", theme);
      const tokens = await page.evaluate(() => {
        const probe = document.createElement("div");
        document.body.append(probe);
        const values = Object.fromEntries(
          ["card", "attention"].map((name) => {
            probe.style.color = `var(--${name})`;
            return [name, getComputedStyle(probe).color];
          }),
        );
        probe.remove();
        return values;
      });
      await expect(frame().locator("body")).toHaveCSS("background-color", tokens.card!);
      await expect(frame().getByText("Needs attention:", { exact: false })).toHaveCSS(
        "color",
        tokens.attention!,
      );
    }
    await mkdir(join(repository, ".visual-captures"), { recursive: true });
    await page
      .locator('[data-session-plugin-slot="composer.above"]')
      .screenshot({ path: join(repository, ".visual-captures/project-chat-todo-plugin.png") });
    await frame().getByRole("button", { name: "Next" }).click();
    await expect(frame().getByText("Page 2 / 3")).toBeVisible();
    await expect(frame().locator("li")).toHaveCount(5);
    await page.reload();
    await expect(frame().getByText("Page 2 / 3")).toBeVisible();
    const disk = JSON.parse(
      await readFile(join(paths.cakeHome, "state", "application.json"), "utf8"),
    );
    expect(
      disk.data.sessionPlugins.find(
        (plugin: { sessionId: string }) => plugin.sessionId === sessionId,
      ).state,
    ).toEqual({ page: 1 });
    await frame().getByRole("button", { name: "Next" }).click();
    await expect(frame().getByText("Page 3 / 3")).toBeVisible();
    await expect(frame().locator("li")).toHaveCount(1);
    await expect(frame().getByRole("button", { name: "Next" })).toBeDisabled();
    expect((await readState()).projects[0]!.todos!.items).toEqual(before);
    // A real backend change appears on the next page read, not a captured title list.
    await call(sessionId, "todos.create", { title: "Added live", description: "Fixture update" });
    await frame().getByRole("button", { name: "Previous" }).click();
    await expect(frame().getByText("Page 2 / 3")).toBeVisible();
    await frame().getByRole("button", { name: "Next" }).click();
    await expect(frame().getByText("Added live", { exact: true })).toBeVisible();
    await expect(frame().locator("li")).toHaveCount(2);
    await page.getByRole("button", { name: "Hide Open to-dos", exact: true }).click();
    await page.reload();
    await expect(page.getByRole("button", { name: "Show Open to-dos", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Show Open to-dos", exact: true }).click();
    await expect(frame().getByText("Added live", { exact: true })).toBeVisible();
    // The identical generated plugin in global Cake Chat reads its empty list, never the Project's.
    await call(CAKE_CHAT_SESSION_ID, "plugins.present", {
      plugin: {
        id: "open-todos",
        title: "Open to-dos",
        brief: "Read-only five-open-to-do paginator",
        initialState: { page: 0 },
      },
    });
    await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
    await expect(frame().getByText("No open to-dos", { exact: true })).toBeVisible();
    await expect(frame().getByText("Page 0 / 0")).toBeVisible();
    await expect(frame().getByRole("button", { name: "Previous" })).toBeDisabled();
    await expect(frame().getByRole("button", { name: "Next" })).toBeDisabled();
    expect(generatedRequests).toHaveLength(2);
    expect(screenshotReviews).toBe(2);
    for (const owner of [CAKE_CHAT_SESSION_ID, sessionId]) {
      if (owner === sessionId)
        await page
          .getByRole("button", { name: /^Open Project Chat for / })
          .first()
          .click();
      const composer = page.getByRole("combobox", {
        name: owner === sessionId ? "Message Project Chat" : "Message Cake Chat",
        exact: true,
      });
      await composer.click();
      await expect(composer).toBeFocused();
      await composer.pressSequentially("Ordinary typing remains available");
      await expect(composer).toHaveValue("Ordinary typing remains available");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await composer.fill("");
      // Preset actions also use the owning permanent chat, not Project Session preparation.
      await call(owner, "plugins.present", {
        plugin: {
          id: "guide",
          title: "Guide",
          preset: "action-bar",
          initialState: {
            label: "Fixture prompt",
            actions: [{ id: "explain", label: "Explain fixture", message: "Explain fixture" }],
          },
        },
      });
      await page.getByRole("button", { name: "Explain fixture", exact: true }).click();
      await expect(
        page
          .locator('[data-slot="message-content"]')
          .filter({ hasText: "Ordinary chat reply." })
          .last(),
      ).toBeVisible();
      await call(owner, "plugins.delete", { id: "guide" });
    }
  } finally {
    await app.close();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    await rm(root, { recursive: true, force: true });
  }
});

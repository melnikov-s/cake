import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { widgetAttachmentsScenario } from "../../scripts/visual-capture/scenarios";
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
import { useCake, useArtifactState, useCurrentSession } from "@cake/artifact-sdk";
export default function Paginator() {
  const cake = useCake();
  const session = useCurrentSession();
  const state = useArtifactState({ page: 0 });
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const page = state.value.page;
  useEffect(() => {
    if (!state.hydrated) return;
    let active = true;
    cake.tools.call("todos.list", { state: "open", limit: 5, offset: page * 5 }).then((result) => {
      if (!active) return;
      const last = Math.max(0, Math.ceil(result.total / 5) - 1);
      if (page > last) state.save({ page: last });
      else setData(result);
    }).catch((failure) => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [page, state.hydrated]);
  if (error) return <p role="alert">{error}</p>;
  if (!data) return <p>Loading open to-dos</p>;
  const pages = Math.ceil(data.total / 5);
  return <section aria-label="Open to-do navigator">
    <ul>{data.items.map(item => <li key={item.id}>{item.title}{item.needsAttention && <span style={{ color: "var(--attention)" }}> — Needs attention: {item.attentionReason}</span>}</li>)}</ul>
    {!data.total && <p>No open to-dos</p>}
    <nav><button disabled={!page} onClick={() => state.save({ page: page - 1 })}>Previous</button>
      <output>Page {pages ? page + 1 : 0} / {pages}</output>
      <button disabled={data.nextOffset === null} onClick={() => state.save({ page: page + 1 })}>Next</button>
      <button onClick={() => cake.tools.call("chat.prompt", { sessionId: session.sessionId, text: "Explain fixture" })}>Explain fixture</button>
    </nav>
  </section>;
}`;

test("Project Chat generates a unified widget paginator with durable pages, explicit duplication and scoped JSON tools", async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "cake-project-chat-widgets-"));
  const paths = {
    project: join(root, "project"),
    cakeHome: join(root, "cake-home"),
    userData: join(root, "user-data"),
  };
  await widgetAttachmentsScenario.seed(paths, "dark");
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
    const source = JSON.stringify(latest?.content).includes("Mark the widget as repaired")
      ? paginatorSource.replace(
          'aria-label="Open to-do navigator"',
          'aria-label="Repaired to-do navigator"',
        )
      : paginatorSource;
    const delta = writing
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "write-widget",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({ path: "widget/widget.tsx", content: source }),
              },
            },
          ],
        }
      : {
          role: "assistant",
          content: ordinary ? "Ordinary chat reply." : review ? "ACCEPT_CURRENT" : "Widget ready.",
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
    await page.getByRole("button", { name: "Open Cake Chat", exact: true }).click();
    await page
      .getByRole("button", { name: /^Open Project Chat for / })
      .first()
      .click();
    await expect(page.getByRole("combobox", { name: "Message Project Chat" })).toBeVisible();
    const harness = await openRpcHarness(app, "project-chat-widgets");
    const call = (owner: string, command: string, input = {}) =>
      callRpcHarness(harness, "callCakeChatOperation", { sessionId: owner, command, input });
    const readState = () => callRpcHarness<ApplicationState>(harness, "getApplicationState");
    await call(sessionId, "widgets.present", {
      widget: {
        id: "open-todos",
        title: "Open to-dos",
        brief:
          "Read-only live five-open-to-do paginator using the Cake SDK and durable artifact state.",
        initialState: { page: 0 },
        fallback: { markdown: "Open to-dos" },
      },
    });
    await call(sessionId, "widgets.attach", {
      id: "open-todos",
      lineageId: "open-todos",
      target: { kind: "session", sessionId },
      slot: "right",
    });
    expect(generatedRequests).toHaveLength(1);
    expect(screenshotReviews).toBe(1);
    const frame = () => page.locator('[data-widget-attachment="open-todos"] iframe').contentFrame();
    await expect(frame().getByText("Page 1 / 3")).toBeVisible();
    await expect(frame().locator("li")).toHaveCount(5);
    await expect(frame().getByRole("button", { name: "Previous" })).toBeDisabled();
    const before = (await readState()).projects[0]!.todos!.items;
    await frame().getByRole("button", { name: "Next", exact: true }).click();
    await expect(frame().getByText("Page 2 / 3")).toBeVisible();
    await page.reload();
    await page
      .getByRole("button", { name: /^Open Project Chat for / })
      .first()
      .click();
    await expect(frame().getByText("Page 2 / 3")).toBeVisible();
    const saved = await call(sessionId, "artifacts.state.read", { lineageId: "open-todos" });
    expect(saved).toMatchObject({ value: { page: 1 } });
    await frame().getByRole("button", { name: "Next", exact: true }).click();
    await expect(frame().getByText("Page 3 / 3")).toBeVisible();
    await expect(frame().locator("li")).toHaveCount(1);
    expect((await readState()).projects[0]!.todos!.items).toEqual(before);
    await call(sessionId, "todos.create", { title: "Added live", description: "Fixture update" });
    await frame().getByRole("button", { name: "Previous" }).click();
    await expect(frame().getByText("Page 2 / 3")).toBeVisible();
    await frame().getByRole("button", { name: "Next", exact: true }).click();
    await expect(frame().getByText("Added live", { exact: true })).toBeVisible();
    const attachment = page.locator('[data-widget-attachment="open-todos"]');
    await attachment.getByRole("button", { name: "Hide", exact: true }).click();
    await expect(attachment.locator("iframe")).toHaveCount(0);
    await page.reload();
    await page
      .getByRole("button", { name: /^Open Project Chat for / })
      .first()
      .click();
    await attachment.getByRole("button", { name: "Show", exact: true }).click();
    await expect(frame().getByText("Page 3 / 3")).toBeVisible();
    // Explicit duplication reuses the definition but creates independent saved state.
    await call(CAKE_CHAT_SESSION_ID, "artifacts.link", {
      reference: "cake://artifact/open-todos@r1",
    });
    await call(CAKE_CHAT_SESSION_ID, "widgets.instantiate", {
      id: "global-todos",
      title: "Global to-dos",
      reference: "cake://artifact/open-todos@r1",
      initialState: { page: 0 },
      fallback: { markdown: "Global to-dos" },
    });
    await call(CAKE_CHAT_SESSION_ID, "widgets.attach", {
      id: "global-todos",
      lineageId: "global-todos",
      target: { kind: "session", sessionId: CAKE_CHAT_SESSION_ID },
      slot: "right",
    });
    await page.getByRole("button", { name: "Open Cake Chat", exact: true }).click();
    const globalFrame = page
      .locator('[data-widget-attachment="global-todos"] iframe')
      .contentFrame();
    await expect(globalFrame.getByText("No open to-dos")).toBeVisible();
    await expect(globalFrame.getByText("Page 0 / 0")).toBeVisible();
    expect(generatedRequests).toHaveLength(1);
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
      const scoped = page
        .locator(
          `[data-widget-attachment="${owner === sessionId ? "open-todos" : "global-todos"}"] iframe`,
        )
        .contentFrame();
      await scoped.getByRole("button", { name: "Explain fixture", exact: true }).click();
      await expect(
        page
          .locator('[data-slot="message-content"]')
          .filter({ hasText: "Ordinary chat reply." })
          .last(),
      ).toBeVisible();
    }
    const beforeRepair = await call(CAKE_CHAT_SESSION_ID, "artifacts.state.read", {
      lineageId: "global-todos",
    });
    const repaired = await call(CAKE_CHAT_SESSION_ID, "artifacts.replace", {
      lineageId: "global-todos",
      expectedRevision: 1,
      instructions:
        "Mark the widget as repaired by naming its region Repaired to-do navigator. Preserve saved state.",
    });
    expect(repaired).toMatchObject({ lineageId: "global-todos", selectedRevision: 2 });
    expect(
      await call(CAKE_CHAT_SESSION_ID, "artifacts.state.read", { lineageId: "global-todos" }),
    ).toEqual(beforeRepair);
    await page.getByRole("button", { name: "Open Cake Chat", exact: true }).click();
    await expect(
      globalFrame.getByRole("region", { name: "Repaired to-do navigator" }),
    ).toBeVisible();
    expect(generatedRequests).toHaveLength(2);
    expect(screenshotReviews).toBe(2);
    await page.screenshot({ path: test.info().outputPath("widgets-repaired-global-chat.png") });
  } finally {
    await app.close();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    await promisify(execFile)("chmod", ["-R", "u+w", root]);
    await rm(root, { recursive: true, force: true });
  }
});

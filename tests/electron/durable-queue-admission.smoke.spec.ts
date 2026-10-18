import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { defaultApplicationState } from "../../src/contracts/application/application-data";

const repository = resolve(import.meta.dirname, "../..");
for (const scope of ["global", "project"] as const) {
  test(`${scope} permanent Chat keeps attachment admission queued once and appends explicit steering`, async () => {
    test.setTimeout(90_000);
    const directory = await mkdtemp(join(tmpdir(), "cake-durable-queue-"));
    const project = join(directory, "project");
    const cakeHome = join(directory, "cake");
    const userData = join(directory, "user-data");
    const requests: string[] = [];
    const responses: ServerResponse[] = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      responses.push(response);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture address");
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
      await Promise.all([
        mkdir(project),
        mkdir(userData),
        mkdir(join(cakeHome, "state"), { recursive: true }),
        mkdir(join(cakeHome, "pi"), { recursive: true }),
      ]);
      await writeFile(
        join(cakeHome, "pi", "models.json"),
        JSON.stringify({
          providers: {
            fixture: {
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              apiKey: "fixture",
              api: "openai-completions",
              models: [
                {
                  id: "fixture",
                  name: "Fixture",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 200_000,
                  maxTokens: 1024,
                },
              ],
            },
          },
        }),
      );
      const preset = {
        id: "00000000-0000-4000-8000-000000000001",
        name: "Fixture",
        provider: "fixture",
        modelId: "fixture",
        thinkingLevel: "off",
        fastMode: false,
      };
      const timestamp = new Date(0).toISOString();
      await writeFile(
        join(cakeHome, "state", "application.json"),
        JSON.stringify({
          version: 7,
          data: {
            ...defaultApplicationState(),
            projects: [
              { path: project, name: "Project", addedAt: timestamp, lastOpenedAt: timestamp },
            ],
            trustedProjectPaths: [project],
            modelPresets: [preset],
            defaultModelPresetId: preset.id,
          },
        }),
      );
      app = await electron.launch({
        args: [repository],
        cwd: repository,
        env: {
          ...process.env,
          CAKE_ELECTRON_SMOKE: "1",
          CAKE_HOME: cakeHome,
          CAKE_ELECTRON_USER_DATA: userData,
          PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
          PI_CODING_AGENT_SESSION_DIR: "",
        },
      });
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1280, height: 900 });
      if (scope === "global")
        await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
      else {
        const id = `project-chat:${createHash("sha256").update(project).digest("hex")}`;
        await page
          .locator(
            `[data-slot="project-header"][data-session-id="${id}"] [data-slot="project-label"]`,
          )
          .click();
      }
      const input = page.getByRole("combobox", {
        name: scope === "global" ? "Message Cake Chat" : "Message Project Chat",
      });
      const send = async (text: string) => {
        await input.click();
        await expect(input).toBeFocused();
        await input.pressSequentially(text);
        await expect(input).toHaveValue(text);
        await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
        await input.press("Enter");
        await expect(input).toHaveValue("");
      };
      await send("A held response");
      await expect.poll(() => responses.length).toBe(1);
      await send("B queued text");
      const queue = page.getByRole("list", { name: "Queued prompts" });
      await expect(queue.getByRole("listitem")).toHaveCount(1);
      await expect(
        queue.getByRole("button", { name: "Send now as steering: B queued text" }),
      ).toBeEnabled();
      const log = "PRIVATE_QUEUE_LOG\n" + "details\n".repeat(50);
      const image =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XkAAAAASUVORK5CYII=";
      await input.evaluate(
        (element, { log, image }) => {
          const read = FileReader.prototype.readAsDataURL;
          const reads: Array<() => void> = [];
          FileReader.prototype.readAsDataURL = function (blob) {
            reads.push(() => read.call(this, blob));
          };
          Reflect.set(window, "releaseQueueImageRead", () => {
            FileReader.prototype.readAsDataURL = read;
            reads.forEach((release) => release());
          });
          const text = new DataTransfer();
          text.setData("text/plain", log);
          element.dispatchEvent(
            new ClipboardEvent("paste", { clipboardData: text, bubbles: true, cancelable: true }),
          );
          const pixels = new DataTransfer();
          pixels.items.add(
            new File(
              [Uint8Array.from(atob(image), (character) => character.charCodeAt(0))],
              "queued.png",
              { type: "image/png" },
            ),
          );
          element.dispatchEvent(
            new ClipboardEvent("paste", { clipboardData: pixels, bubbles: true, cancelable: true }),
          );
        },
        { log, image },
      );
      // Hold the actual native read across Enter, with an older queue item present.
      await input.click();
      await input.press("Enter");
      await input.pressSequentially("C queued attachments");
      await input.press("Enter");
      await expect(input).toHaveValue("C queued attachments");
      await expect(queue.getByRole("listitem")).toHaveCount(1);
      await expect(
        queue.getByRole("button", { name: "Send now as steering: B queued text" }),
      ).toBeEnabled();
      expect(requests).toHaveLength(1);
      await page.evaluate(() => Reflect.get(window, "releaseQueueImageRead")());
      await expect(page.getByRole("button", { name: "View queued.png enlarged" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await input.press("Enter");
      await expect(input).toHaveValue("");
      await expect(queue.getByRole("listitem")).toHaveCount(2);
      await expect(
        queue.getByRole("button", {
          name: "Send now as steering: C queued attachments",
          exact: true,
        }),
      ).toBeEnabled();
      await send("D queued text");
      const labels = () =>
        queue.getByRole("button", { name: /^View queued message:/ }).allTextContents();
      await expect.poll(labels).toEqual(["B queued text", "C queued attachments", "D queued text"]);
      await expect(queue.getByRole("group", { name: "Steering" })).toHaveCount(0);
      expect(requests).toHaveLength(1);
      await expect(
        page
          .getByLabel("Conversation", { exact: true })
          .getByText("C queued attachments", { exact: true }),
      ).toHaveCount(0);
      for (const text of ["C queued attachments", "D queued text", "B queued text"]) {
        await queue
          .getByRole("button", { name: `Send now as steering: ${text}`, exact: true })
          .click();
      }
      await expect.poll(labels).toEqual(["C queued attachments", "D queued text", "B queued text"]);
      await send("E remains queued");
      await expect
        .poll(labels)
        .toEqual(["C queued attachments", "D queued text", "B queued text", "E remains queued"]);
      const queued = queue.getByRole("group", { name: "Queued", exact: true });
      await expect(queued.getByText("Queued", { exact: true })).toBeVisible();
      await expect(
        queue.getByRole("group", { name: "Steering" }).getByText("Steering", { exact: true }),
      ).toBeVisible();
      for (const theme of ["light", "dark"]) {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        await expect(queued).toHaveCSS("border-top-width", "1px");
      }
      await page.setViewportSize({ width: 640, height: 760 });
      expect(await queue.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      const finish = (index: number) => {
        const chunk = (delta: object, finish_reason: string | null = null) =>
          `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        responses[index]!.end(
          chunk({ role: "assistant", content: `Reply ${index}` }) +
            chunk({}, "stop") +
            "data: [DONE]\n\n",
        );
      };
      // Drive real provider boundaries until every accepted input has been consumed.
      for (let index = 0; index < 4; index++) {
        finish(index);
        await expect.poll(() => responses.length).toBe(index + 2);
        if ((await queue.count()) === 0) break;
      }
      await expect(queue).toHaveCount(0);
      const payload: { messages: Array<{ role: string; content: unknown }> } = JSON.parse(
        requests.at(-1)!,
      );
      const users = payload.messages
        .filter((message) => message.role === "user")
        .map((message) => JSON.stringify(message.content))
        .join("\n");
      const expected = [
        "C queued attachments",
        "D queued text",
        "B queued text",
        "E remains queued",
      ];
      // Durable may consume one input from each lane at a final boundary.
      // Assert FIFO within steering, not a new cross-lane scheduling policy.
      const positions = expected.slice(0, 3).map((text) => users.indexOf(text));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      for (const text of expected) expect(users.split(text)).toHaveLength(2);
      expect(users).toContain("queued.png");
      expect(users).not.toContain("PRIVATE_QUEUE_LOG");
      expect(users).not.toContain(image);
    } finally {
      await app?.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(directory, { recursive: true, force: true });
    }
  });
}

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

const interviewArguments = {
  command: "interview.open",
  input: {
    request: {
      protocol: "cake.request/v1",
      id: "fixture-interview",
      title: "Fixture interview",
      responseSchema: {
        type: "object",
        properties: { region: { type: "string" }, name: { type: "string" } },
      },
      view: {
        type: "form",
        fields: [
          {
            id: "region",
            label: "Region",
            type: "select",
            options: [
              { value: "us", label: "US" },
              { value: "eu", label: "EU" },
            ],
          },
          { id: "name", label: "Project name", type: "text" },
        ],
      },
      fallback: { markdown: "Choose a region and name." },
    },
  },
};

function streamChunks(response: ServerResponse, chunks: unknown[]) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

const chunk = (delta: unknown, finishReason: string | null = null) => ({
  id: "fixture",
  object: "chat.completion.chunk",
  created: 0,
  model: "fixture-model",
  choices: [{ index: 0, delta, finish_reason: finishReason }],
});

for (const dictationEnabled of [false, true]) {
  test(`interview.open ${dictationEnabled ? "dictates custom answers" : "renders its stepped form"} and resolves the tool call`, async () => {
    test.skip(
      dictationEnabled && (process.platform !== "darwin" || process.arch !== "arm64"),
      "Local recognition targets Apple Silicon",
    );
    test.setTimeout(120_000);
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-interview-open-smoke-"));
    const userData = join(temporaryRoot, "user-data");
    const project = join(temporaryRoot, "project");
    const cakeHome = join(temporaryRoot, "cake-home");
    await mkdir(userData, { recursive: true });
    await mkdir(project, { recursive: true });
    const model = join(userData, "dictation", "model");
    const control = join(model, "control.json");
    const helper = join(temporaryRoot, "cake-dictation");
    const configureSpeech = (text: string, finalText = text) =>
      writeFile(control, JSON.stringify({ text, finalText }));
    if (dictationEnabled) {
      await mkdir(model, { recursive: true });
      await configureSpeech("");
      await writeFile(
        join(userData, "dictation", "settings.json"),
        JSON.stringify({ modelPath: model }),
      );
      // Fake only the external recognizer; use the real microphone worklet, Service, RPC and Store.
      await writeFile(
        helper,
        `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path'); const readline = require('node:readline');
const control = path.join(process.argv[2], 'control.json');
const reply = value => process.stdout.write(JSON.stringify(value) + '\\n');
reply({ ready: true });
(async () => {
  for await (const line of readline.createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    if (request.operation === 'detectSpeech') { reply({ speech: true }); continue; }
    const value = JSON.parse(fs.readFileSync(control, 'utf8'));
    if (request.final) fs.writeFileSync(control, JSON.stringify({ text: '', finalText: '' }));
    reply({ text: request.final ? value.finalText : value.text });
  }
})();
`,
      );
      await chmod(helper, 0o755);
    }

    const requestArguments = dictationEnabled
      ? {
          ...interviewArguments,
          input: {
            request: {
              ...interviewArguments.input.request,
              responseSchema: {
                type: "object",
                properties: {
                  ...interviewArguments.input.request.responseSchema.properties,
                  notes: { type: "string" },
                  count: { type: "number" },
                },
              },
              view: {
                type: "form",
                fields: [
                  ...interviewArguments.input.request.view.fields,
                  { id: "notes", label: "Notes", type: "textarea" },
                  { id: "count", label: "Count", type: "number" },
                ],
              },
            },
          },
        }
      : interviewArguments;
    const toolResults: string[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (data: Buffer) => (body += data.toString()));
      request.on("end", () => {
        const messages = (
          JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> }
        ).messages;
        const toolMessage = messages.findLast((message) => message.role === "tool");
        if (!toolMessage)
          return streamChunks(response, [
            ...(!dictationEnabled
              ? [
                  chunk({
                    role: "assistant",
                    content: Array.from(
                      { length: 120 },
                      (_, index) => `Context paragraph ${index + 1}.`,
                    ).join("\n\n"),
                  }),
                ]
              : []),
            chunk({
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_interview",
                  type: "function",
                  function: { name: "cake", arguments: JSON.stringify(requestArguments) },
                },
              ],
            }),
            chunk({}, "tool_calls"),
          ]);
        toolResults.push(
          typeof toolMessage.content === "string"
            ? toolMessage.content
            : JSON.stringify(toolMessage.content),
        );
        streamChunks(response, [
          chunk({ role: "assistant", content: "Interview received." }),
          chunk({}, "stop"),
        ]);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;

    // Pi's models.json registers the provider for every session, including drafts.
    await mkdir(join(cakeHome, "pi"), { recursive: true });
    await writeFile(
      join(cakeHome, "pi", "models.json"),
      JSON.stringify({
        providers: {
          "fixture-provider": {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKey: "fixture",
            api: "openai-completions",
            models: [
              {
                id: "fixture-model",
                name: "Fixture model",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32_000,
                maxTokens: 1_024,
              },
            ],
          },
        },
      }),
    );
    await writeFile(join(userData, "window-state.json"), windowState({ project }));
    await mkdir(join(cakeHome, "state"), { recursive: true });
    await writeFile(
      join(cakeHome, "state", "application.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          {
            path: project,
            name: "project",
            addedAt: new Date(0).toISOString(),
            lastOpenedAt: new Date(0).toISOString(),
          },
        ],
        trustedProjectPaths: [],
      }),
    );

    const application = await electron.launch({
      args: [
        repositoryRoot,
        ...(dictationEnabled
          ? ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]
          : []),
      ],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: userData,
        CAKE_HOME: cakeHome,
        PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
        ...(dictationEnabled ? { CAKE_SMOKE_DICTATION_HELPER: helper } : {}),
      },
    });

    try {
      const page = await application.firstWindow();
      await expect(page.getByLabel("Message")).toBeVisible({ timeout: 20_000 });
      if (dictationEnabled) {
        await page.getByRole("button", { name: "Open settings", exact: true }).click();
        await page.getByRole("button", { name: /Voice & Dictation/ }).click();
        await page.getByLabel("Text processing", { exact: true }).selectOption("raw");
        await page.getByRole("switch", { name: "Dictation mode" }).click();
        await page.getByRole("button", { name: "Back to chat" }).click();
      }

      await page.getByRole("button", { name: "Model configuration" }).click();
      // Without a configured default the picker opens directly on model search.
      const search = page.getByLabel("Search presets and models");
      const changeModel = page.getByRole("button", { name: /Change model/ });
      await expect(search.or(changeModel)).toBeVisible();
      if (await changeModel.isVisible()) await changeModel.click();
      await search.fill("Fixture model");
      await page
        .getByRole("button", { name: /Fixture model/ })
        .first()
        .click();
      await page.getByRole("button", { name: "Apply" }).click();
      await expect(page.getByLabel("Search presets and models")).toBeHidden();

      // Record transient previews too: the interview replaces the erroneous
      // artifact surface before a final-state-only assertion can see it.
      const interviewArtifactPreviews: string[] = [];
      await page.exposeFunction("recordInterviewArtifactPreview", (reference: string) => {
        interviewArtifactPreviews.push(reference);
      });
      await page.evaluate(() => {
        const selector = '[data-artifact-reference="cake://artifact/fixture-interview"]';
        const record = (element: Element) => {
          if (element.matches(selector))
            void (
              window as Window & {
                recordInterviewArtifactPreview(reference: string): Promise<void>;
              }
            ).recordInterviewArtifactPreview(element.getAttribute("data-artifact-reference")!);
          element.querySelectorAll(selector).forEach(record);
        };
        new MutationObserver((mutations) => {
          for (const mutation of mutations)
            for (const node of mutation.addedNodes) if (node instanceof Element) record(node);
        }).observe(document.body, { childList: true, subtree: true });
      });

      const composer = page.getByLabel("Message");
      await composer.fill("Interview me");
      await composer.press("Enter");

      const form = page.locator('[data-interview-id="call_interview"]');
      const scrollAwayAndBack = async () => {
        const transcript = page.locator(
          '.transcript:not([data-slot="content-transition-outgoing"] *)',
        );
        await transcript.hover();
        await page.mouse.wheel(0, -10_000);
        await transcript.evaluate((element) => {
          element.scrollTop = 0;
        });
        // Prove virtualization actually unmounted the interview, not merely hid it.
        await expect(form).toHaveCount(0);
        await transcript.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await expect(form).toBeVisible();
      };
      await expect(form).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('.transcript [data-interview-id="call_interview"]')).toBeVisible();
      await expect(form).toContainText(`Question 1 of ${dictationEnabled ? 4 : 2}`);
      expect(interviewArtifactPreviews).toEqual([]);
      if (dictationEnabled) {
        await form.getByRole("radio", { name: "Other", exact: true }).check();
        const custom = form.getByRole("textbox", { name: "Region other option" });
        await expect(custom).toBeFocused();
        await expect(form.getByRole("button", { name: "Mute dictation" })).toBeVisible();
        await custom.pressSequentially("Custom: ");
        await expect(custom).toHaveValue("Custom: ");
        await configureSpeech("Pacific", "Pacific coast");
        await expect(custom).toHaveValue("Custom: Pacific");
        await expect(custom).toBeFocused();
        await custom.press("Enter");
        await expect(form).toContainText("Question 2 of 4");
      } else {
        await form.getByText("EU", { exact: true }).click();
        await form.getByRole("button", { name: "Next" }).click();
      }
      await expect(form).toContainText(`Question 2 of ${dictationEnabled ? 4 : 2}`);
      const name = form.getByRole("textbox", { name: "Project name" });
      await expect(name).toBeFocused();
      await name.pressSequentially("Cake");
      await expect(name).toHaveValue("Cake");
      if (dictationEnabled) {
        await expect(form.getByRole("button", { name: "Mute dictation" })).toBeVisible();
        await configureSpeech("project", "project final");
        await expect(name).toHaveValue("Cake project");
      }
      if (!dictationEnabled) {
        await scrollAwayAndBack();
        await expect(form).toContainText("Question 2 of 2");
        await expect(name).toHaveValue("Cake");
      }
      await name.press("Enter");
      if (dictationEnabled) {
        await expect(form).toContainText("Question 3 of 4");
        const notes = form.getByRole("textbox", { name: "Notes", exact: true });
        await expect(notes).toBeFocused();
        await expect(form.getByRole("button", { name: "Mute dictation" })).toBeVisible();
        await notes.pressSequentially("Typed note. ");
        await configureSpeech("Spoken note.");
        await expect(notes).toHaveValue("Typed note. Spoken note.");
        await expect(notes).toBeFocused();
        await form.getByRole("button", { name: "Next" }).click();
        const count = form.getByRole("spinbutton", { name: "Count", exact: true });
        await expect(count).toBeFocused();
        await expect(form.locator('[data-slot="dictation-indicator"]')).toHaveCount(0);
        await count.pressSequentially("7");
        await count.press("Enter");
      }
      await expect(form).toContainText("Review answers");
      if (dictationEnabled) {
        await expect(form).toContainText("Custom: Pacific coast");
        await expect(form).toContainText("Cake project final");
      }
      if (!dictationEnabled) {
        await scrollAwayAndBack();
        await expect(form).toContainText("Review answers");
        await expect(form).toContainText("EU");
        await expect(form).toContainText("Cake");
      }
      expect(toolResults).toHaveLength(0);
      await form.getByRole("button", { name: "Submit" }).click();

      await expect(form).toContainText("Submitted");
      await expect(page.getByText("Interview received.")).toBeVisible({ timeout: 30_000 });
      expect(toolResults).toHaveLength(1);
      expect(JSON.parse(toolResults[0]!)).toEqual({
        interviewId: "call_interview",
        cancelled: false,
        value: dictationEnabled
          ? {
              region: "Custom: Pacific coast",
              name: "Cake project final",
              notes: "Typed note. Spoken note.",
              count: 7,
            }
          : { region: "eu", name: "Cake" },
      });
    } finally {
      await application.close();
      server.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
}

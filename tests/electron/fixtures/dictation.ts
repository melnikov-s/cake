import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../../scripts/queued-electron.mjs";
import { cakeWorkspaceSessionDirectory } from "../../../src/services/pi/runtime/session-discovery";
import { store, windowStateChildren, windowStateDocument } from "../../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

/** Isolated profile with fake native dictation assets and a scriptable external recognizer. */
export async function dictationFixture(
  options: {
    dictationEnabled?: boolean;
    preventAutomaticRefocus?: boolean;
    modelReferences?: boolean;
    providerUrl?: string;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "cake-dictation-smoke-"));
  const userData = join(root, "user-data"),
    project = join(root, "project"),
    cakeHome = join(root, "cake-home");
  const sessionId = "dictation-session";
  const sessions = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const dictation = join(userData, "dictation"),
    model = join(dictation, "model");
  await Promise.all([
    mkdir(sessions, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
    mkdir(model, { recursive: true }),
    mkdir(join(dictation, "ctc"), { recursive: true }),
  ]);
  if (options.providerUrl)
    await writeFile(
      join(cakeHome, "pi", "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: options.providerUrl,
            apiKey: "fixture",
            api: "openai-completions",
            models: [
              {
                id: "fixture",
                name: "Fixture",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
  // Fake native assets only. Never download speech models in an Electron workflow test.
  await writeFile(
    join(dictation, "ctc", "installed.json"),
    JSON.stringify({ revision: "fixture" }),
  );
  const control = join(model, "control.json");
  const configure = (value: {
    ready: boolean;
    hold?: boolean;
    holdDetection?: boolean;
    speech?: boolean;
    text?: string;
    finalText?: string;
    error?: string;
  }) => writeFile(control, JSON.stringify(value));
  await configure({ ready: false, hold: true });
  await writeFile(join(dictation, "settings.json"), JSON.stringify({ modelPath: model }));
  const helper = join(root, "cake-dictation");
  // Fake only the external native process. Real Service, RPC, Store, audio worklet and React input.
  await writeFile(
    helper,
    `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path'); const readline = require('node:readline');
const directory = process.argv[2]; const control = path.join(directory, 'control.json');
const config = () => JSON.parse(fs.readFileSync(control, 'utf8'));
const wait = (predicate) => new Promise(resolve => { const check = () => { try { if (predicate(config())) { watcher.close(); resolve(); } } catch {} }; const watcher = fs.watch(directory, check); check(); });
const reply = value => process.stdout.write(JSON.stringify(value) + '\\n');
(async () => {
  fs.appendFileSync(path.join(directory, 'starts.jsonl'), JSON.stringify({ pid: process.pid }) + '\\n');
  await wait(value => value.ready); reply({ ready: true });
  const requestPath = path.join(directory, 'request.json');
  let count = fs.existsSync(requestPath) ? JSON.parse(fs.readFileSync(requestPath, 'utf8')).count : 0;
  let finals = 0;
  for await (const line of readline.createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    if (request.operation === 'prepareVocabulary') { reply({ prepared: true }); continue; }
    if (request.operation === 'detectSpeech') {
      if (config().holdDetection) fs.writeFileSync(path.join(directory, 'detection.json'), JSON.stringify({ held: true }));
      await wait(value => !value.holdDetection);
      const data = Buffer.from(request.pcm, 'base64'); let energy = 0; for (let i = 0; i < data.length; i += 4) energy += data.readFloatLE(i) ** 2;
      reply({ speech: config().speech ?? (data.length > 0 && Math.sqrt(energy / (data.length / 4)) > 0.003) }); continue;
    }
    fs.writeFileSync(path.join(directory, 'request.json'), JSON.stringify({ count: ++count, finals: request.final ? ++finals : finals, final: request.final, id: request.utteranceId, vocabulary: request.vocabulary }));
    await wait(value => !value.hold); const value = config(); reply(value.error ? { error: value.error } : { text: request.final ? (value.finalText ?? value.text ?? '') : (value.text ?? '') });
    fs.writeFileSync(path.join(directory, 'response.json'), JSON.stringify({ count }));
  }
})();
`,
  );
  await chmod(helper, 0o755);
  const timestamp = new Date(0).toISOString();
  await writeFile(
    join(userData, "window-state.json"),
    windowStateDocument({
      ...windowStateChildren({ project, sessionId, theme: "dark" }),
      ...(options.dictationEnabled
        ? {
            dictationStore: store({
              enabled: true,
              preventAutomaticRefocus: options.preventAutomaticRefocus ?? true,
            }),
          }
        : {}),
    }),
  );
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp }],
      ...(options.modelReferences
        ? {
            modelPresets: [
              {
                id: "00000000-0000-4000-8000-000000000001",
                name: "Reference fixture",
                provider: "anthropic",
                modelId: "fixture",
                thinkingLevel: "off",
                fastMode: false,
              },
            ],
          }
        : {}),
    }),
  );
  await writeFile(
    join(sessions, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
    [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
      ...(options.providerUrl
        ? [
            {
              type: "model_change",
              id: "model",
              parentId: null,
              timestamp,
              provider: "fixture",
              modelId: "fixture",
            },
          ]
        : []),
      {
        type: "message",
        id: "user-1",
        parentId: options.providerUrl ? "model" : null,
        timestamp,
        message: { role: "user", content: [{ type: "text", text: "Explain this" }], timestamp: 0 },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Inspect this implementation before changing it." }],
          api: options.providerUrl ? "openai-completions" : "anthropic-messages",
          provider: options.providerUrl ? "fixture" : "anthropic",
          model: "fixture",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1,
        },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n",
  );
  const launch = () =>
    electron.launch({
      args: [
        repositoryRoot,
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
      ],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_SMOKE_DICTATION_HELPER: helper,
        CAKE_ELECTRON_USER_DATA: userData,
        CAKE_HOME: cakeHome,
        PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
  return { root, userData, cakeHome, sessionId, dictation, model, configure, launch };
}

import type { JsonObject } from "@earendil-works/pi-durable-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  defineExtension,
  type Conversation,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  getCurrentSystemMessage,
  getCurrentTools,
} from "@earendil-works/pi-durable-ai/utils/transcript";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../../src/contracts/cake-chats/cake-chat-identity";
import { createCakeChatLocalTools } from "../../../../src/services/pi-durable/cake-chat-local-tools";
import { coordinatorSystemPrompt } from "../../../../src/services/pi-durable/coordinator-system-prompt";
import { readDurableOriginalPage } from "../../../../src/services/pi-durable/durable-chat-history";
import {
  SideSessionDoc,
  sideSessionExecutionEnv,
} from "../../../../src/services/pi-durable/durable-side-session";
import { durableAnswer, durableModels } from "../../../fixtures/durable-chat";

it("runs native read/edit/write on explicitly requested non-project files without project registration", async () => {
  // Only disposable fixture files, never a user's actual configuration.
  const directory = await mkdtemp(join(tmpdir(), "cake-nonproject-"));
  const path = join(directory, "example.conf");
  const note = join(directory, "result.txt");
  await writeFile(path, "enabled=false\nkeep=unchanged\n");
  const calls: Array<{ name: string; arguments: JsonObject }> = [
    { name: "read", arguments: { path } },
    {
      name: "edit",
      arguments: { path, edits: [{ oldText: "enabled=false", newText: "enabled=true" }] },
    },
    { name: "write", arguments: { path: note, content: "Changed only the requested option.\n" } },
    { name: "read", arguments: { path } },
  ];
  const { models, requests } = durableModels((_request, index) => {
    const call = calls[index - 1];
    return call
      ? durableAnswer("", [{ type: "toolCall", id: `call-${index}`, ...call }])
      : durableAnswer("Verified the requested files.");
  });
  const { active, inactive } = createCakeChatLocalTools(CAKE_CHAT_SESSION_ID);
  const registry = createRegistry();
  registry.install(defineExtension({ name: "local", tools: [...active, ...inactive] }));
  const context = BACKGROUND_CONTEXT;
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      env: () => new NodeExecutionEnv({ cwd: directory }),
    },
    context,
  );
  try {
    const root = await harness.root(context, {
      agent: {
        model: { provider: "fixture", modelId: "fixture" },
        tools: active,
        instructions: coordinatorSystemPrompt("", "/docs", false, "", true),
      },
    });
    const result = await (
      await root.submit(
        {
          type: "input",
          content: `Set enabled=true in ${path}, preserve keep=unchanged, and write a receipt to ${note}.`,
        },
        context,
      )
    ).wait(context);
    expect(result.status).toBe("done");
    expect(await readFile(path, "utf8")).toBe("enabled=true\nkeep=unchanged\n");
    expect(await readFile(note, "utf8")).toBe("Changed only the requested option.\n");
    expect(requests).toHaveLength(5);
    expect(getCurrentTools(requests[0]!.messages).map((tool) => tool.name)).toEqual([
      "read",
      "bash",
      "edit",
      "write",
    ]);
    expect(getCurrentSystemMessage(requests[0]!.messages)?.sections?.instructions).toContain(
      "No project registration required",
    );
    const history = await readDurableOriginalPage(root);
    const tools = history.parts.filter((part) => part.kind === "tool");
    expect(tools.map((part) => part.name)).toEqual(["read", "edit", "write", "read"]);
    expect(tools.every((part) => part.state === "success")).toBe(true);
    expect(tools.at(-1)?.output).toContain("enabled=true");
  } finally {
    await harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

/** Real SQLite, native file tools and execution bindings; only the provider is scripted. */
async function mutationLifecycle(name: "edit" | "write") {
  const directory = await mkdtemp(join(tmpdir(), "cake-mutation-lifecycle-"));
  const path = join(directory, "example.conf");
  const initial = "enabled=false\nkeep=unchanged\n";
  const changed = "enabled=true\nkeep=unchanged\n";
  await writeFile(path, initial);
  let before = initial;
  let after = changed;
  return {
    directory,
    path,
    changed,
    attemptChange() {
      // If the guard disappeared, either native operation would successfully change these bytes.
      before = changed;
      after = "enabled=UNEXPECTED\nkeep=unchanged\n";
    },
    async open(sessionId = CAKE_CHAT_SESSION_ID, create = false) {
      const { models, requests } = durableModels((_request, index) =>
        index % 2 === 1
          ? durableAnswer("", [
              {
                type: "toolCall",
                id: `mutation-${index}`,
                name,
                arguments:
                  name === "edit"
                    ? { path, edits: [{ oldText: before, newText: after }] }
                    : { path, content: after },
              },
            ])
          : durableAnswer("Mutation attempt finished."),
      );
      const local = createCakeChatLocalTools(sessionId);
      const registry = createRegistry();
      registry.install(
        defineExtension({ name: "local", tools: [...local.active, ...local.inactive] }),
      );
      const storage = await openNodeSqliteStorage(join(directory, "chat.sqlite"));
      const harness = await Harness.open(
        storage,
        {
          models,
          registry,
          env: sideSessionExecutionEnv(directory),
        },
        BACKGROUND_CONTEXT,
      );
      const root = create
        ? await harness.root(BACKGROUND_CONTEXT, {
            agent: {
              model: { provider: "fixture", modelId: "fixture" },
              tools: local.active,
            },
          })
        : await harness.root(BACKGROUND_CONTEXT);
      return { harness, root, local, requests };
    },
    async attempt(root: Conversation) {
      const result = await (
        await root.submit(
          { type: "input", content: `Attempt ${name} on ${path}.` },
          BACKGROUND_CONTEXT,
        )
      ).wait(BACKGROUND_CONTEXT);
      expect(result.status).toBe("done");
      const history = await readDurableOriginalPage(root);
      const last = history.parts.filter((part) => part.kind === "tool").at(-1);
      expect(last?.name).toBe(name);
      return last;
    },
  };
}

it.each(["edit", "write"] as const)(
  "denies native %s after a writable Global conversation gains an investigation binding",
  async (name) => {
    const fixture = await mutationLifecycle(name);
    const { harness, root } = await fixture.open(CAKE_CHAT_SESSION_ID, true);
    try {
      expect((await fixture.attempt(root))?.state).toBe("success");
      const beforeDenial = await readFile(fixture.path);
      expect(beforeDenial).toEqual(Buffer.from(fixture.changed));
      fixture.attemptChange();
      await root.commit(async (tx) => {
        (await tx.doc(SideSessionDoc, root.id)).workingDirectory = fixture.directory;
      }, BACKGROUND_CONTEXT);
      // Declarations have not changed: execution must check the new live binding.
      expect((await root.agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name)).toContain(name);
      const denied = await fixture.attempt(root);
      expect(denied?.state).toBe("error");
      expect(denied?.output).toContain("Investigation forks remain read-only");
      expect(await readFile(fixture.path)).toEqual(beforeDenial);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      await rm(fixture.directory, { recursive: true, force: true });
    }
  },
);

it.each([
  { name: "edit", sessionId: CAKE_CHAT_SESSION_ID },
  { name: "write", sessionId: CAKE_CHAT_SESSION_ID },
  { name: "edit", sessionId: `project-chat:${"a".repeat(64)}` },
  { name: "write", sessionId: `project-chat:${"a".repeat(64)}` },
] as const)(
  "denies native $name with saved writable declarations after SQLite reopen and reload as $sessionId",
  async ({ name, sessionId }) => {
    const fixture = await mutationLifecycle(name);
    let current = await fixture.open(CAKE_CHAT_SESSION_ID, true);
    try {
      expect((await fixture.attempt(current.root))?.state).toBe("success");
      const beforeDenial = await readFile(fixture.path);
      expect(beforeDenial).toEqual(Buffer.from(fixture.changed));
      fixture.attemptChange();
      await current.root.commit(async (tx) => {
        (await tx.doc(SideSessionDoc, current.root.id)).workingDirectory = fixture.directory;
      }, BACKGROUND_CONTEXT);
      await current.harness.close(BACKGROUND_CONTEXT);
      // A new storage connection, registry and model runtime load the saved agent unchanged.
      current = await fixture.open(sessionId);
      expect(
        (await current.root.agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name),
      ).toContain(name);
      expect(
        await current.harness.snapshot(SideSessionDoc, current.root.id, BACKGROUND_CONTEXT),
      ).toEqual({ workingDirectory: fixture.directory });
      const reopened = await fixture.attempt(current.root);
      expect(reopened?.state).toBe("error");
      expect(reopened?.output).toContain(
        sessionId === CAKE_CHAT_SESSION_ID
          ? "Investigation forks remain read-only"
          : "Project Chat cannot edit files",
      );
      expect(await readFile(fixture.path)).toEqual(beforeDenial);

      // Match the coordinator's code-owned tool refresh on reload/reopen.
      await current.root.configure({ tools: current.local.active }, BACKGROUND_CONTEXT);
      const declared = (await current.root.agent(BACKGROUND_CONTEXT)).tools.map(
        (tool) => tool.name,
      );
      if (sessionId === CAKE_CHAT_SESSION_ID) expect(declared).toContain(name);
      else expect(declared).not.toContain(name);
      const reloaded = await fixture.attempt(current.root);
      expect(reloaded?.state).toBe("error");
      expect(reloaded?.output).toContain(
        sessionId === CAKE_CHAT_SESSION_ID
          ? "Investigation forks remain read-only"
          : `Tool ${name} is not available`,
      );
      expect(await readFile(fixture.path)).toEqual(beforeDenial);
      expect(current.requests).toHaveLength(4);
    } finally {
      await current.harness.close(BACKGROUND_CONTEXT);
      await rm(fixture.directory, { recursive: true, force: true });
    }
  },
);

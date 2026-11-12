import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  runInlineWidgetGeneration,
  runInlineWidgetRepair,
} from "../../src/services/pi/runtime/sidecar-runtime";
import type { WidgetCandidate } from "../../src/contracts/widgets/widget-candidate";
import { widgetFilesFromSource } from "../../src/services/widgets/widget-files";
import { call, text, widgetSideChatFixture, type ScriptedReply } from "./fixtures/widget-side-chat";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

it.each(["react", "html"] as const)(
  "revises %s widget files and state in the accepted build session, rejecting escapes and invalid JSON without partial writes",
  async (language) => {
    const path = language === "html" ? "widget/widget.html" : "widget/widget.tsx";
    const source =
      language === "html"
        ? "<!doctype html><html><head></head><body><button>Initial</button></body></html>"
        : "export default function Chart(){return <div>Initial</div>}";
    const replies: ScriptedReply[] = [];
    const fixture = await widgetSideChatFixture((request) => replies[request - 1]!);
    disposers.push(fixture.dispose);
    await symlink(join(fixture.cwd, "secret.txt"), join(fixture.skillDir, "escape.txt"));
    replies.push(
      { content: [call("initial", "write", { path, content: source })] },
      text("Done"),
      {
        content: [
          call("symlink", "read", { path: join(fixture.skillDir, "escape.txt") }),
          call("source", "edit", { path, edits: [{ oldText: "Initial", newText: "Revised" }] }),
          call("invalid", "edit", {
            path: "widget/state.json",
            edits: [{ oldText: '"latest"', newText: "invalid-json" }],
          }),
          call("inspect", "read", { path: "widget/state.json" }),
          call("list", "read", { path: "widget" }),
          call("state", "edit", {
            path: "widget/state.json",
            edits: [{ oldText: '"latest"', newText: '"edited"' }],
          }),
        ],
      },
      text("Revised"),
    );
    const generated = await runInlineWidgetGeneration({
      ...fixture.options,
      candidate: { files: {}, state: null },
      allowState: true,
      conversation: { type: "parent", origin: fixture.origin },
      language,
      brief: "Chart",
      fallback: "Chart",
    });
    const accepted = SessionManager.open(generated.sessionFile!);
    const acceptedLeaf = accepted.getLeafId();

    const candidate: WidgetCandidate = {
      files: widgetFilesFromSource(source, language),
      state: { scene: "latest" },
    };
    const revised = await runInlineWidgetRepair({
      ...fixture.options,
      candidate,
      allowState: true,
      conversation: { type: "revision", sessionId: generated.sessionId },
      language,
      capability: "artifact",
      context: "Update the current scene",
      diagnostic: "Requested durable revision: say Revised",
    });

    expect(revised.changed).toBe(true);
    expect(revised.sessionId).toBe(generated.sessionId);
    expect(
      SessionManager.open(generated.sessionFile!)
        .getBranch()
        .some((entry) => entry.id === acceptedLeaf),
    ).toBe(true);
    expect(candidate.files[path]).toContain("Revised");
    expect(candidate.state).toEqual({ scene: "edited" });
    const results = fixture.requests
      .at(-1)!
      .messages.filter((message) => message.role === "toolResult");
    expect(results.filter((result) => result.isError).map((result) => result.toolCallId)).toEqual([
      "symlink",
      "invalid",
    ]);
    expect(JSON.stringify(results.find((result) => result.toolCallId === "inspect"))).toContain(
      "latest",
    );
    expect(JSON.stringify(results.find((result) => result.toolCallId === "list"))).toContain(path);
    expect(JSON.stringify(results)).not.toContain("private-secret");
  },
);

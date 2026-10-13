import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { WidgetBrowserOutputs } from "../../../../src/services/widgets/WidgetBrowserOutputs";
import { makeWidgetBrowserOutputsLive } from "../../../../src/services/widgets/WidgetBrowserOutputsLive";
import {
  inlineWidgetResource,
  publishInlineWidget,
  revokeInlineWidget,
} from "../../../../src/services/widgets/inline-widget-document-registry";

const roots: string[] = [];
const runtimes: Array<ManagedRuntime.ManagedRuntime<WidgetBrowserOutputs, never>> = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-browser-outputs-"));
  roots.push(root);
  const runtime = ManagedRuntime.make(makeWidgetBrowserOutputsLive(root));
  runtimes.push(runtime);
  const outputs = await runtime.runPromise(WidgetBrowserOutputs);
  return { root, runtime, outputs };
};
const candidate = () => {
  const token = randomUUID();
  return {
    token,
    document: `<script>const token = "${token}";</script>`,
    assets: [
      { path: "assets/0/font.woff2", contentType: "font/woff2", data: Buffer.from("font") },
    ] as const,
  };
};

describe("durable widget browser outputs", () => {
  it("deduplicates immutable builds independent of transient token and rebinds each open", async () => {
    const { outputs, root } = await fixture();
    const first = candidate();
    const browser = await Effect.runPromise(outputs.retain(first));
    expect(await Effect.runPromise(outputs.retain(candidate()))).toEqual(browser);
    expect(await readFile(join(root, browser.digest, "document.html"), "utf8")).not.toContain(
      first.token,
    );
    const restarted = ManagedRuntime.make(makeWidgetBrowserOutputsLive(root));
    runtimes.push(restarted);
    const reopened = await restarted.runPromise(
      Effect.flatMap(WidgetBrowserOutputs, (service) => service.open(browser)),
    );
    const second = await Effect.runPromise(outputs.open(browser));
    expect(reopened.token).not.toBe(first.token);
    expect(reopened.token).not.toBe(second.token);
    expect(reopened.document).toContain(reopened.token);
    const frame = publishInlineWidget(reopened);
    const other = publishInlineWidget(second);
    try {
      expect(inlineWidgetResource(frame.token, "assets/0/font.woff2")?.data).toEqual(
        first.assets[0].data,
      );
      expect(inlineWidgetResource(frame.token, "assets/0/../../manifest.json")).toBeUndefined();
      revokeInlineWidget(frame.token);
      expect(inlineWidgetResource(frame.token, "")).toBeUndefined();
      expect(inlineWidgetResource(other.token, "")).toBeDefined();
    } finally {
      revokeInlineWidget(frame.token);
      revokeInlineWidget(other.token);
    }
  });

  it("rejects corrupted resources and does not substitute a newly compiled bundle", async () => {
    const { outputs, root } = await fixture();
    const browser = await Effect.runPromise(outputs.retain(candidate()));
    await writeFile(join(root, browser.digest, "assets/0/font.woff2"), "changed");
    await expect(Effect.runPromise(outputs.open(browser))).rejects.toThrow(
      "resource failed integrity",
    );
  });

  it("rejects browser paths and malformed asset metadata at the service boundary", async () => {
    const { outputs } = await fixture();
    await expect(Effect.runPromise(outputs.open({ digest: "../../host" }))).rejects.toThrow();
    const value = candidate();
    await expect(
      Effect.runPromise(
        outputs.retain({
          ...value,
          assets: [{ ...value.assets[0], path: "assets/0/../../outside" }],
        }),
      ),
    ).rejects.toThrow();
  });
});

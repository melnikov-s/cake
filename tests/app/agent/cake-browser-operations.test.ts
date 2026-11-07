import { describe, expect, it, vi } from "vitest";
import type { JsonValue } from "../../../src/contracts/serialization/json-contract";
import type { BrowserActionResult } from "../../../src/contracts/browser/browser-action-result";
import { createCakeBrowserOperations } from "../../../src/domain/browser/cake-browser-operations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";

function harness() {
  const enter = vi.fn(async () => undefined);
  const cdp = vi.fn(async (): Promise<BrowserActionResult<JsonValue>> => ({
    status: "completed",
    value: { result: { value: "Local app" } },
  }));
  const events = vi.fn(async (): Promise<BrowserActionResult<JsonValue>> => ({
    status: "completed",
    value: [{ method: "Runtime.consoleAPICalled", params: { type: "log" } }],
  }));
  return {
    cdp,
    enter,
    events,
    registry: new CakeOperationRegistry(createCakeBrowserOperations({ enter, cdp, events })),
  };
}

const context = {
  signal: new AbortController().signal,
  toolCallId: "tool-browser",
  runtime: {},
};

describe("Cake browser operations", () => {
  it("passes arbitrary CDP methods and parameters without narrowing them", async () => {
    const { cdp, registry } = harness();
    const params = {
      expression: "document.querySelector('main').textContent",
      returnByValue: true,
      awaitPromise: true,
    };

    const result = await registry.invoke(
      { command: "browser.cdp", input: { method: "Runtime.evaluate", params } },
      context,
    );

    expect(cdp).toHaveBeenCalledWith(
      "Runtime.evaluate",
      params,
      expect.any(AbortSignal),
      undefined,
    );
    expect(result.details).toMatchObject({
      command: "browser.cdp",
      result: { result: { value: "Local app" } },
    });
  });

  it.each([10, 120_000, 600_000])(
    "passes an explicit finite CDP budget (%i ms)",
    async (timeoutMs) => {
      const { cdp, registry } = harness();
      await registry.invoke(
        { command: "browser.cdp", input: { method: "Runtime.evaluate", timeoutMs } },
        context,
      );
      expect(cdp).toHaveBeenCalledWith("Runtime.evaluate", {}, context.signal, timeoutMs);
    },
  );

  it.each([0, -1, 600_001, Infinity])("rejects invalid CDP budgets (%s)", async (timeoutMs) => {
    const { cdp, registry } = harness();
    await expect(
      registry.invoke(
        { command: "browser.cdp", input: { method: "Runtime.evaluate", timeoutMs } },
        context,
      ),
    ).rejects.toThrow();
    expect(cdp).not.toHaveBeenCalled();
  });

  it("exposes Browser Mode and buffered CDP events through progressive help", async () => {
    const { events, registry } = harness();
    expect(registry.help()).toContain("browser —");
    expect(registry.topicHelp("browser")).toContain("Browser and CDP");

    await registry.invoke(
      {
        command: "browser.events",
        input: { methods: ["Runtime.consoleAPICalled"], limit: 20, clear: false },
      },
      context,
    );

    expect(events).toHaveBeenCalledWith(
      ["Runtime.consoleAPICalled"],
      20,
      false,
      expect.any(AbortSignal),
    );
  });
});

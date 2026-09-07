// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SyntaxHighlightRequest,
  SyntaxHighlightResponse,
} from "../../../src/renderer/lib/syntax-highlighter-contract";

class FakeWorker {
  static instances: FakeWorker[] = [];

  readonly messages: SyntaxHighlightRequest[] = [];
  private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();

  constructor() {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  postMessage(message: SyntaxHighlightRequest) {
    this.messages.push(message);
  }

  respond(message: SyntaxHighlightResponse) {
    for (const listener of this.listeners.get("message") ?? [])
      listener({ data: message } as MessageEvent);
  }

  terminate() {}
}

describe("syntaxHighlighter", () => {
  beforeEach(() => {
    vi.resetModules();
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("coalesces worker requests and reuses the bounded renderer cache", async () => {
    const { syntaxHighlighter } = await import("../../../src/renderer/lib/syntax-highlighter");
    const options = {
      code: "const value = true;",
      language: "typescript" as const,
      themes: ["github-light-high-contrast", "github-dark"] as [
        "github-light-high-contrast",
        "github-dark",
      ],
    };
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();

    expect(syntaxHighlighter.highlight(options, firstCallback)).toBeNull();
    expect(syntaxHighlighter.highlight(options, secondCallback)).toBeNull();
    const worker = FakeWorker.instances[0]!;
    expect(worker.messages).toHaveLength(1);

    const result = {
      tokens: [[{ content: options.code, offset: 0, htmlStyle: { color: "#123456" } }]],
    };
    worker.respond({ id: worker.messages[0]!.id, result });

    expect(firstCallback).toHaveBeenCalledWith(result);
    expect(secondCallback).toHaveBeenCalledWith(result);
    expect(syntaxHighlighter.highlight(options)).toBe(result);
    expect(worker.messages).toHaveLength(1);
  });

  it("retains a virtualized transcript-sized working set", async () => {
    const { syntaxHighlighter } = await import("../../../src/renderer/lib/syntax-highlighter");
    const workerOptions = Array.from({ length: 256 }, (_, index) => ({
      code: `const value${index} = true;`,
      language: "typescript" as const,
      themes: ["github-light-high-contrast", "github-dark"] as [
        "github-light-high-contrast",
        "github-dark",
      ],
    }));

    for (const options of workerOptions) {
      expect(syntaxHighlighter.highlight(options)).toBeNull();
    }
    const worker = FakeWorker.instances[0]!;
    for (const message of worker.messages) {
      worker.respond({
        id: message.id,
        result: { tokens: [[{ content: message.code, offset: 0 }]] },
      });
    }

    const first = syntaxHighlighter.highlight(workerOptions[0]!);
    expect(first?.tokens[0]?.[0]?.content).toBe(workerOptions[0]!.code);
    expect(worker.messages).toHaveLength(workerOptions.length);
  });

  it("renders oversized input as plain tokens without sending it to Shiki", async () => {
    const { maxHighlightCharacters } =
      await import("../../../src/renderer/lib/syntax-highlighter-contract");
    const { syntaxHighlighter } = await import("../../../src/renderer/lib/syntax-highlighter");
    const code = "x".repeat(maxHighlightCharacters + 1);

    const result = syntaxHighlighter.highlight({
      code,
      language: "typescript",
      themes: ["github-light-high-contrast", "github-dark"],
    });

    expect(result?.tokens[0]?.[0]?.content).toBe(code);
    expect(FakeWorker.instances).toHaveLength(0);
  });
});

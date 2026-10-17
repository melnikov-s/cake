// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SyntaxHighlightRequest,
  SyntaxHighlightResponse,
} from "../../../src/renderer/lib/syntax-highlighter-contract";

// Focused transport integration: request coalescing, cache capacity and worker
// failure cannot be inferred reliably from visible code text. The production
// renderer highlighter is real; only the browser Worker boundary is controlled.
class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = [];

  readonly messages: SyntaxHighlightRequest[] = [];
  terminated = false;

  constructor() {
    super();
    FakeWorker.instances.push(this);
  }

  postMessage(message: SyntaxHighlightRequest) {
    this.messages.push(message);
  }

  respond(message: SyntaxHighlightResponse) {
    this.dispatchEvent(new MessageEvent("message", { data: message }));
  }

  terminate() {
    this.terminated = true;
  }
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
      themes: ["github-light-high-contrast", "github-dark"] satisfies [
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
      themes: ["github-light-high-contrast", "github-dark"] satisfies [
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

  it("drains pending requests on worker failure and preserves readable future code", async () => {
    const { syntaxHighlighter } = await import("../../../src/renderer/lib/syntax-highlighter");
    const callback = vi.fn();
    const options = {
      code: "const first = 1;\n\nconst last = 2;",
      language: "typescript" as const,
      themes: ["github-light-high-contrast", "github-dark"] satisfies [
        "github-light-high-contrast",
        "github-dark",
      ],
    };
    expect(syntaxHighlighter.highlight(options, callback)).toBeNull();
    const worker = FakeWorker.instances[0]!;
    worker.dispatchEvent(new Event("messageerror"));
    const plain = {
      tokens: [
        [{ content: "const first = 1;", offset: 0 }],
        [],
        [{ content: "const last = 2;", offset: 18 }],
      ],
    };
    expect(callback).toHaveBeenCalledExactlyOnceWith(plain);
    expect(worker.terminated).toBe(true);
    expect(syntaxHighlighter.highlight(options)).toEqual(plain);
    expect(syntaxHighlighter.highlight({ ...options, code: "next source" })?.tokens).toEqual([
      [{ content: "next source", offset: 0 }],
    ]);
    expect(worker.messages).toHaveLength(1);
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it("uses readable fallback for a failed request without breaking subsequent requests", async () => {
    const { syntaxHighlighter } = await import("../../../src/renderer/lib/syntax-highlighter");
    const options = {
      code: "const failed = true;",
      language: "typescript" as const,
      themes: ["github-light-high-contrast", "github-dark"] satisfies [
        "github-light-high-contrast",
        "github-dark",
      ],
    };
    const callback = vi.fn();
    syntaxHighlighter.highlight(options, callback);
    const worker = FakeWorker.instances[0]!;
    worker.respond({ id: worker.messages[0]!.id, error: "Unable to tokenize" });
    expect(callback).toHaveBeenCalledExactlyOnceWith({
      tokens: [[{ content: options.code, offset: 0 }]],
    });
    expect(worker.terminated).toBe(false);
    expect(syntaxHighlighter.highlight({ ...options, code: "const recovered = true;" })).toBeNull();
    expect(worker.messages).toHaveLength(2);
    worker.respond({
      id: worker.messages[1]!.id,
      result: { tokens: [[{ content: "const recovered = true;", offset: 0 }]] },
    });
    expect(
      syntaxHighlighter.highlight({ ...options, code: "const recovered = true;" })?.tokens[0]?.[0]
        ?.content,
    ).toBe("const recovered = true;");
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

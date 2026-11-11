import { Effect } from "effect";
import type { CakeArtifactV1 } from "../../../../src/contracts/artifacts/artifact-contract";
import { createCakeArtifactOperations } from "../../../../src/domain/artifacts/cake-artifact-operations";
import { CakeOperationRegistry } from "../../../../src/services/pi/runtime/cake-operation-registry";
import { describe, expect, it, vi } from "vitest";
import { generateReviewedWidget } from "../../../../src/domain/widgets/widgetGenerationReview";
import { ProjectSessionIntegrationHost } from "../../../../src/layers/ProjectSessionIntegrationHost";
import type { WidgetCandidate } from "../../../../src/contracts/widgets/widget-candidate";
import type { InlineWidgetGenerationRequest } from "../../../../src/contracts/widgets/widget-generation";
import { RenderedWidgetCaptureError } from "../../../../src/contracts/widgets/rendered-widget-capture-errors";
import { inlineWidgetDocument } from "../../../../src/services/widgets/inline-widget-document-registry";
import { readPrototypeSource } from "../../../../src/services/widgets/prototype-source";

const source = (name: string) => `export default function ${name}(){ return <div>${name}</div> }`;

const htmlSource = (name: string) =>
  `<!doctype html><html><head><style>button{font:inherit}</style></head><body><button id="count">Count 0</button><script>function ${name}() { let count = 0; document.querySelector("button").onclick = () => document.querySelector("button").textContent = "Count " + ++count; } ${name}();</script></body></html>`;

/** Writes one widget file the way the side chat's write tool does. */
const write = (
  candidate: WidgetCandidate,
  language: "html" | "react" | undefined,
  text: string,
) => {
  candidate.files[language === "html" ? "widget/widget.html" : "widget/widget.tsx"] = text;
};

function host(options: {
  generation?: string;
  language?: "html" | "react";
  /** Each review either accepts or writes a replacement component with this name. */
  reviews: string[];
  compileFailures?: Set<string>;
  signal?: AbortSignal;
  visualReview?: (signal: AbortSignal | undefined) => Promise<string>;
  captureError?: RenderedWidgetCaptureError;
  retainError?: string;
  stageState?: (candidate: WidgetCandidate) => void;
}) {
  const calls: string[] = [];
  const compileLanguages: string[] = [];
  const generationInputs: unknown[] = [];
  const captureStates: unknown[] = [];
  const capturedTokens: string[] = [];
  const reviewContexts: string[] = [];
  const repairInputs: unknown[] = [];
  const reviewInputs: unknown[] = [];
  let token = 0;
  const hostOptions: ConstructorParameters<typeof ProjectSessionIntegrationHost>[0] = {
    workspacePath: "/workspace",
    runReviewedWidget: generateReviewedWidget,
    execute: (effect, signal) => Effect.runPromise(effect, signal ? { signal } : undefined),
    agentDir: "/agent",
    sessionDir: "/sessions",
    emit: vi.fn(),
    requestUi: vi.fn(),
    requestInterview: vi.fn(),
    requestApplicationControl: vi.fn(),
    requireVisionModel: async (model) => {
      calls.push(`vision:${model?.id}`);
    },
    runWidgetGeneration: async (input) => {
      generationInputs.push(input);
      calls.push("generate");
      write(
        input.candidate,
        input.language,
        options.generation ??
          (options.language === "html" ? htmlSource("Initial") : source("Initial")),
      );
      return { sessionId: "generation-session", response: "Done", changed: true };
    },
    openWidgetBrowser: async () => {
      calls.push("open-retained");
      token += 1;
      return {
        token: `00000000-0000-4000-8000-${String(token).padStart(12, "0")}`,
        document: "<html>Retained</html>",
      };
    },
    retainWidgetBrowser: async (compiled) => {
      calls.push(`retain:${compiled.token.slice(-1)}`);
      if (options.retainError) throw new Error(options.retainError);
      return { digest: "a".repeat(64) };
    },
    compileWidget: async (language, candidate) => {
      compileLanguages.push(language);
      const name = candidate.match(/function (\w+)/)?.[1] ?? "unknown";
      calls.push(`compile:${name}`);
      if (options.compileFailures?.has(name)) throw new Error(`bad ${name}`);
      token += 1;
      return {
        token: `00000000-0000-4000-8000-${String(token).padStart(12, "0")}`,
        document: `<html>${name}</html>`,
      };
    },
    captureWidget: async (_sessionId, widget, _signal, initialState) => {
      captureStates.push(initialState);
      capturedTokens.push(widget.token);
      expect(inlineWidgetDocument(widget.token)).toMatch(/^<html>\w+<\/html>$/);
      calls.push(`capture:${widget.token.slice(-1)}`);
      if (options.captureError) throw options.captureError;
      return {
        pngBase64: Buffer.from(`png-${token}`).toString("base64"),
        diagnostics: ["widget=560x480"],
      };
    },
    runWidgetRepair: async (input) => {
      repairInputs.push(input);
      options.stageState?.(input.candidate);
      calls.push(`repair:${input.diagnostic?.split(":")[0]}`);
      write(
        input.candidate,
        input.language,
        input.language === "html" ? htmlSource("Repaired") : source("Repaired"),
      );
      return { sessionId: "repair", response: "Done", changed: true };
    },
    runWidgetVisualReview: async (input) => {
      reviewInputs.push(input);
      const { signal, context } = input;
      reviewContexts.push(context);
      calls.push("review");
      const decision = options.visualReview
        ? await options.visualReview(signal)
        : (options.reviews.shift() ?? "ACCEPT_CURRENT");
      if (decision === "ACCEPT_CURRENT" || decision === "UNCHANGED")
        return { sessionId: "review", response: decision, changed: false };
      write(
        input.candidate,
        options.language,
        options.language === "html" ? htmlSource(decision) : source(decision),
      );
      return { sessionId: "review", response: "Fixed", changed: true };
    },
  };
  const integration = new ProjectSessionIntegrationHost(hostOptions);
  return {
    integration,
    hostOptions,
    calls,
    compileLanguages,
    generationInputs,
    repairInputs,
    reviewInputs,
    captureStates,
    capturedTokens,
    reviewContexts,
  };
}

const request = (signal?: AbortSignal): InlineWidgetGenerationRequest => ({
  sessionId: "project-session",
  parentConversation: {
    sessionId: "project-session",
    sessionFile: "/sessions/source.jsonl",
    entryId: "source-entry",
  },
  brief: "Show the flow",
  fallback: "Readable fallback",
  model: { provider: "fixture", id: "vision" },
  signal,
});

const generate = (
  integration: ProjectSessionIntegrationHost,
  input: ReturnType<typeof request>,
) => {
  const operation = integration.runtimeIntegrations("project-session").generateInlineWidget;
  if (!operation) throw new Error("Missing widget generation integration");
  return operation(input);
};

describe("ProjectSessionIntegrationHost widget rendered review", () => {
  it("captures retained browser bytes with independent candidate state and no generation, compilation, or review", async () => {
    const fixture = host({ reviews: [] });
    const capture =
      fixture.integration.runtimeIntegrations("project-session").captureWidgetInstance!;
    const state = { title: "Independent document", nodes: [] };
    const preview = await capture({
      sessionId: "project-session",
      browser: { digest: "a".repeat(64) },
      initialState: state,
      signal: new AbortController().signal,
    });
    expect(preview).toEqual({
      mimeType: "image/png",
      data: Buffer.from("png-1").toString("base64"),
    });
    expect(fixture.captureStates).toEqual([state]);
    expect(fixture.calls).toEqual(["open-retained", "capture:1"]);
    expect(fixture.capturedTokens.every((token) => inlineWidgetDocument(token) === undefined)).toBe(
      true,
    );
  });

  it("revokes a retained-output capture token after capture failure", async () => {
    const fixture = host({
      reviews: [],
      captureError: new RenderedWidgetCaptureError({
        kind: "infrastructure",
        message: "Capture failed",
      }),
    });
    const capture =
      fixture.integration.runtimeIntegrations("project-session").captureWidgetInstance!;
    await expect(
      capture({
        sessionId: "project-session",
        browser: { digest: "a".repeat(64) },
        initialState: null,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Capture failed");
    expect(fixture.calls).toEqual(["open-retained", "capture:1"]);
    expect(fixture.capturedTokens.every((token) => inlineWidgetDocument(token) === undefined)).toBe(
      true,
    );
  });

  it.each([undefined, "html"] as const)(
    "publishes explicit %s through the authoring operation and real review policy",
    async (language) => {
      const fixture = host({ language, reviews: ["ACCEPT_CURRENT"] });
      const onUpdate = vi.fn();
      const persistArtifact = vi.fn(async (artifact: CakeArtifactV1) => ({
        artifact,
        workspacePath: "/workspace",
        digest: "a".repeat(64),
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }));
      const appendEntry = vi.fn();
      const registry = new CakeOperationRegistry(
        createCakeArtifactOperations(
          { appendEntry },
          {
            persistArtifact,
            generateInlineWidget:
              fixture.integration.runtimeIntegrations("project-session").generateInlineWidget,
          },
        ),
      );
      const result = await registry.invoke(
        {
          command: "widgets.present",
          input: {
            widget: {
              id: "counter",
              title: "Counter",
              brief: "Interactive count",
              ...(language ? { language } : {}),
              initialState: { count: 0 },
              fallback: { markdown: "A count" },
            },
          },
        },
        {
          signal: new AbortController().signal,
          toolCallId: "widget-1",
          onUpdate,
          runtime: {
            ...request().parentConversation,
            model: request().model,
          },
        },
      );
      expect(fixture.compileLanguages).toEqual([language ?? "react"]);
      expect(persistArtifact).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "widget",
          revision: 1,
          payload: expect.objectContaining({ language: language ?? "react" }),
          fallback: { markdown: "A count" },
        }),
        { expectedVersion: 0, value: { count: 0 } },
      );
      expect(result.content[1]).toEqual({
        type: "image",
        mimeType: "image/png",
        data: Buffer.from("png-1").toString("base64"),
      });
      expect(appendEntry).toHaveBeenCalledOnce();
      expect(onUpdate).toHaveBeenCalledWith({
        widgetGeneration: {
          phase: "rendering",
          files: [language === "html" ? "widget/widget.html" : "widget/widget.tsx"],
          characters: expect.any(Number),
        },
      });
    },
  );

  it("does not publish rejected HTML through the authoring operation", async () => {
    const fixture = host({
      language: "html",
      reviews: ["Second", "Third", "Rejected"],
    });
    const persistArtifact = vi.fn();
    const appendEntry = vi.fn();
    const registry = new CakeOperationRegistry(
      createCakeArtifactOperations(
        { appendEntry },
        {
          persistArtifact,
          generateInlineWidget:
            fixture.integration.runtimeIntegrations("project-session").generateInlineWidget,
        },
      ),
    );
    await expect(
      registry.invoke(
        {
          command: "widgets.present",
          input: {
            widget: {
              id: "counter",
              title: "Counter",
              brief: "Count",
              language: "html",
              fallback: { markdown: "Count" },
            },
          },
        },
        {
          signal: new AbortController().signal,
          toolCallId: "rejected",
          runtime: {
            ...request().parentConversation,
            model: request().model,
          },
        },
      ),
    ).rejects.toThrow("third replacement");
    expect(persistArtifact).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();
    expect(fixture.calls.some((call) => call.startsWith("retain"))).toBe(false);
  });

  it("preserves HTML and stages state when revising the accepted generation branch", async () => {
    const fixture = host({
      reviews: ["ACCEPT_CURRENT"],
      stageState: (candidate) => {
        candidate.state = { count: 2 };
      },
    });
    const revise = fixture.integration.runtimeIntegrations("project-session").reviseInlineWidget;
    if (!revise) throw new Error("Missing revision integration");
    const result = await revise({
      sessionId: "project-session",
      generationSessionId: "accepted-html",
      language: "html",
      source: htmlSource("Initial"),
      brief: "Count",
      fallback: "Count",
      instructions: "Clarify count",
      initialState: { count: 1 },
      initialStateVersion: 4,
      model: request().model,
    });
    expect(result.language).toBe("html");
    expect(result.state).toEqual({ count: 2 });
    expect(fixture.captureStates).toEqual([{ count: 2 }]);
    expect(fixture.compileLanguages).toEqual(["html"]);
    expect(fixture.repairInputs[0]).toMatchObject({
      language: "html",
      conversation: { type: "revision", sessionId: "accepted-html" },
    });
    expect(fixture.reviewInputs[0]).toMatchObject({
      conversation: { type: "continue", sessionId: "repair" },
      candidate: { files: { "widget/widget.html": expect.stringContaining("function Repaired") } },
    });
  });

  it("threads explicit HTML through repair, repeated visual review and accepted browser retention", async () => {
    const fixture = host({
      language: "html",
      compileFailures: new Set(["Initial"]),
      reviews: ["Second", "ACCEPT_CURRENT"],
    });
    const result = await generate(fixture.integration, { ...request(), language: "html" });
    expect(result.language).toBe("html");
    expect(result.source).toContain("function Second");
    expect(fixture.compileLanguages).toEqual(["html", "html", "html"]);
    expect(fixture.generationInputs[0]).toMatchObject({ language: "html" });
    expect(fixture.repairInputs[0]).toMatchObject({ language: "html" });
    expect(fixture.reviewInputs).toHaveLength(2);
    expect(fixture.calls.filter((call) => call.startsWith("retain"))).toEqual(["retain:2"]);
    expect(result.preview.data).toBe(Buffer.from("png-2").toString("base64"));
  });

  it.each([
    "prose",
    "<p>Not a document</p>",
    source("WrongMode"),
    htmlSource("Valid") + "\nTrailing",
  ])(
    "sends an invalid HTML document back to the side chat before compiling it: %s",
    async (generation) => {
      const fixture = host({ language: "html", generation, reviews: ["ACCEPT_CURRENT"] });
      const result = await generate(fixture.integration, { ...request(), language: "html" });
      expect(fixture.repairInputs).toEqual([
        expect.objectContaining({
          diagnostic: expect.stringContaining("one complete <!doctype html>"),
        }),
      ]);
      expect(fixture.compileLanguages).toEqual(["html"]);
      expect(result.source).toContain("function Repaired");
    },
  );

  it("never retains HTML after visual rejection exhausts the replacement budget", async () => {
    const fixture = host({
      language: "html",
      reviews: ["Second", "Third", "Rejected"],
    });
    await expect(generate(fixture.integration, { ...request(), language: "html" })).rejects.toThrow(
      "third replacement",
    );
    expect(fixture.compileLanguages).toEqual(["html", "html", "html"]);
    expect(fixture.calls.some((call) => call.startsWith("retain"))).toBe(false);
    for (const token of fixture.capturedTokens) expect(inlineWidgetDocument(token)).toBeUndefined();
  });

  it("compiles and retains built-in diagnostic browser output without generation or visual review", async () => {
    const fixture = host({ reviews: [] });
    const compile =
      fixture.integration.runtimeIntegrations("project-session").compileArtifactBrowser;
    if (!compile) throw new Error("Missing diagnostic browser integration");
    await expect(compile("html", "<strong>Diagnostic</strong>")).resolves.toEqual({
      digest: "a".repeat(64),
    });
    expect(fixture.calls).toEqual(["compile:unknown", "retain:1"]);
    expect(fixture.generationInputs).toEqual([]);
    expect(fixture.reviewInputs).toEqual([]);
    expect(fixture.captureStates).toEqual([]);
  });

  it("does not publish a diagnostic browser reference when retention fails", async () => {
    const fixture = host({ reviews: [], retainError: "disk full" });
    const compile =
      fixture.integration.runtimeIntegrations("project-session").compileArtifactBrowser;
    if (!compile) throw new Error("Missing diagnostic browser integration");
    await expect(compile("html", "<strong>Diagnostic</strong>")).rejects.toThrow("disk full");
    expect(fixture.calls).toEqual(["compile:unknown", "retain:1"]);
  });
  it("reviews absent storage with SDK defaults rather than persisted null", async () => {
    const created = host({ reviews: ["ACCEPT_CURRENT"] });
    await generate(created.integration, request());
    expect(created.captureStates).toEqual([undefined]);
    const revised = host({ reviews: ["ACCEPT_CURRENT"] });
    const revise = revised.integration.runtimeIntegrations("project-session").reviseInlineWidget!;
    await revise({
      sessionId: "project-session",
      generationSessionId: "existing",
      language: "react",
      source: "existing",
      brief: "defaults",
      fallback: "defaults",
      instructions: "contrast",
      initialState: null,
      initialStateVersion: 0,
      model: request().model,
    });
    expect(revised.captureStates).toEqual([undefined]);
  });

  it("reviews explicitly saved null without substituting SDK defaults", async () => {
    const fixture = host({ reviews: ["ACCEPT_CURRENT"] });
    await generate(fixture.integration, { ...request(), initialState: null });
    expect(fixture.captureStates).toEqual([null]);
    const revise = fixture.integration.runtimeIntegrations("project-session").reviseInlineWidget!;
    await revise({
      sessionId: "project-session",
      generationSessionId: "existing",
      language: "react",
      source: "existing",
      brief: "null",
      fallback: "null",
      instructions: "contrast",
      initialState: null,
      initialStateVersion: 1,
      model: request().model,
    });
    expect(fixture.captureStates).toEqual([null, null]);
  });

  it("generates, captures and reviews widgets with their actual durable state", async () => {
    const fixture = host({ reviews: ["ACCEPT_CURRENT"] });
    const initialState = { topic: "Cake and Pi", step: 1 };
    await generate(fixture.integration, { ...request(), initialState });
    expect(fixture.generationInputs).toEqual([
      expect.objectContaining({
        initialState,
        conversation: { type: "parent", origin: request().parentConversation },
        sessionRoots: ["/sessions", "/widget-sessions"],
      }),
    ]);
    expect(fixture.reviewInputs).toEqual([
      expect.objectContaining({
        conversation: { type: "continue", sessionId: "generation-session" },
      }),
    ]);
    expect(fixture.captureStates).toEqual([initialState]);
    const [brief, staged] = fixture.reviewContexts[0]!.split(
      "\n\nCurrent staged artifact state (authoritative for this preview):\n",
    );
    expect(JSON.parse(brief!)).toMatchObject({ initialState });
    expect(JSON.parse(staged!)).toEqual(initialState);
  });
  it("starts a durable revision from the existing source and reviews the replacement", async () => {
    const fixture = host({ reviews: ["ACCEPT_CURRENT"] });
    const revise = fixture.integration.runtimeIntegrations("project-session").reviseInlineWidget;
    if (!revise) throw new Error("Missing widget revision integration");

    const result = await revise({
      sessionId: "project-session",
      generationSessionId: "existing-generation",
      language: "react",
      source: "export default function Existing(){ return <div>Existing</div> }",
      brief: "Show the flow",
      fallback: "Readable fallback",
      instructions: "Increase contrast",
      initialStateVersion: 0,
      model: { provider: "fixture", id: "vision" },
    });

    expect(result.source).toContain("function Repaired");
    expect(fixture.repairInputs).toEqual([
      expect.objectContaining({
        conversation: { type: "revision", sessionId: "existing-generation" },
      }),
    ]);
    expect(fixture.reviewInputs).toEqual([
      expect.objectContaining({ conversation: { type: "continue", sessionId: "repair" } }),
    ]);
    expect(fixture.calls).toEqual([
      "vision:vision",
      "repair:Requested durable revision",
      "compile:Repaired",
      "capture:1",
      "review",
      "retain:1",
    ]);
  });

  it("captures and reviews every rendered candidate before accepting a replacement", async () => {
    const fixture = host({ reviews: ["Second", "ACCEPT_CURRENT"] });
    const result = await generate(fixture.integration, request());
    expect(result.source).toContain("function Second");
    expect(result.preview).toEqual({
      mimeType: "image/png",
      data: Buffer.from("png-2").toString("base64"),
    });
    expect(fixture.reviewInputs).toEqual([
      expect.objectContaining({ pngBase64: Buffer.from("png-1").toString("base64") }),
      expect.objectContaining({ pngBase64: result.preview.data }),
    ]);
    expect(fixture.capturedTokens).toHaveLength(2);
    for (const token of fixture.capturedTokens) expect(inlineWidgetDocument(token)).toBeUndefined();
    expect(fixture.calls).toEqual([
      "vision:vision",
      "generate",
      "compile:Initial",
      "capture:1",
      "review",
      "compile:Second",
      "capture:2",
      "review",
      "retain:2",
    ]);
    expect(result.browser).toEqual({ digest: "a".repeat(64) });
  });

  it("shares the two-replacement budget across compiler repair and visual review", async () => {
    const fixture = host({
      generation: source("Broken"),
      compileFailures: new Set(["Broken"]),
      reviews: ["Third", "Forbidden"],
    });
    await expect(generate(fixture.integration, request())).rejects.toThrow("third replacement");
    expect(fixture.calls.filter((call) => call.startsWith("capture"))).toHaveLength(2);
    expect(fixture.calls).toContain("repair:Compilation failed");
    expect(fixture.repairInputs).toEqual([
      expect.objectContaining({
        conversation: { type: "continue", sessionId: "generation-session" },
      }),
    ]);
    for (const input of fixture.reviewInputs)
      expect(input).toMatchObject({
        conversation: { type: "continue", sessionId: "generation-session" },
      });
  });

  it("does not spend a candidate repair on renderer infrastructure failure", async () => {
    const fixture = host({
      reviews: [],
      captureError: new RenderedWidgetCaptureError({
        kind: "infrastructure",
        message: "renderer disconnected",
      }),
    });
    await expect(generate(fixture.integration, request())).rejects.toThrow("renderer disconnected");
    expect(fixture.calls.some((call) => call.startsWith("repair"))).toBe(false);
    expect(fixture.calls).not.toContain("review");
    expect(fixture.capturedTokens).toHaveLength(1);
    for (const token of fixture.capturedTokens) expect(inlineWidgetDocument(token)).toBeUndefined();
  });

  it("returns no publishable candidate when retaining accepted browser output fails", async () => {
    const fixture = host({ reviews: ["ACCEPT_CURRENT"], retainError: "disk full" });
    await expect(generate(fixture.integration, request())).rejects.toThrow("disk full");
    expect(fixture.calls.filter((call) => call.startsWith("repair"))).toEqual([]);
    expect(fixture.calls.filter((call) => call.startsWith("retain"))).toEqual(["retain:1"]);
    for (const token of fixture.capturedTokens) expect(inlineWidgetDocument(token)).toBeUndefined();
  });

  it("aborts active specialist review and never returns publishable source", async () => {
    const controller = new AbortController();
    const fixture = host({
      reviews: [],
      visualReview: (signal) =>
        new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("specialist aborted")), {
            once: true,
          });
        }),
    });
    const pending = generate(fixture.integration, request(controller.signal));
    await vi.waitFor(() => expect(fixture.calls).toContain("review"));
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(fixture.calls.filter((call) => call.startsWith("capture"))).toHaveLength(1);
  });

  it("reviews staged state and returns it only after acceptance without changing the input", async () => {
    const initialState = { scene: "latest-live-scene" };
    const fixture = host({
      reviews: ["ACCEPT_CURRENT"],
      stageState: (candidate) => {
        expect(candidate.state).toEqual(initialState);
        candidate.state = { scene: "revised-scene" };
      },
    });
    const revise = fixture.integration.runtimeIntegrations("project-session").reviseInlineWidget;
    if (!revise) throw new Error("Missing revision integration");
    const accepted = await revise({
      sessionId: "project-session",
      generationSessionId: "existing",
      language: "react",
      source: "existing",
      brief: "scene",
      fallback: "scene",
      instructions: "edit scene",
      initialState,
      initialStateVersion: 7,
      model: request().model,
    });
    expect(accepted.state).toEqual({ scene: "revised-scene" });
    expect(fixture.captureStates).toEqual([{ scene: "revised-scene" }]);
    expect(initialState).toEqual({ scene: "latest-live-scene" });
  });

  it("fails preflight before generation when vision review is unavailable", async () => {
    const fixture = host({ reviews: [] });
    await expect(generate(fixture.integration, { ...request(), model: undefined })).rejects.toThrow(
      "vision-capable model",
    );
    expect(fixture.calls).toEqual(["vision:undefined"]);
  });

  it("fails clearly when visual review neither accepts nor changes the widget", async () => {
    const fixture = host({ reviews: ["UNCHANGED"] });
    await expect(generate(fixture.integration, request())).rejects.toThrow(
      "neither accepted the widget nor changed its files",
    );
    expect(fixture.calls.some((call) => call.startsWith("retain"))).toBe(false);
  });

  it("reports building, compiling and rendering progress to the caller", async () => {
    const fixture = host({ reviews: ["ACCEPT_CURRENT"] });
    const progress: unknown[] = [];
    await generate(fixture.integration, {
      ...request(),
      onProgress: (update) => progress.push(update),
    });
    expect(fixture.generationInputs[0]).toMatchObject({ onProgress: expect.any(Function) });
    expect(progress).toEqual([
      { phase: "compiling", files: ["widget/widget.tsx"], characters: source("Initial").length },
      { phase: "rendering", files: ["widget/widget.tsx"], characters: source("Initial").length },
    ]);
  });

  it("assembles prototype files into the published module manifest", async () => {
    const ids = ["dense", "split", "cards", "timeline", "minimal"];
    const fixture = host({ reviews: ["ACCEPT_CURRENT"] });
    const compiled: string[] = [];
    const integration = new ProjectSessionIntegrationHost({
      ...fixture.hostOptions,
      runWidgetGeneration: async (input) => {
        input.candidate.files["widget/shared/tokens.tsx"] = "export const gap = 8;";
        for (const id of ids)
          input.candidate.files[`widget/options/${id}.tsx`] =
            `import { gap } from "cake:prototype/tokens"; export default function Option(){ return <div style={{ gap }}>${id}</div> }`;
        input.candidate.files["widget/chooser.tsx"] = [
          'import { useArtifactState } from "@cake/artifact-sdk";',
          ...ids.map((id, index) => `import O${index} from "cake:prototype/${id}";`),
          "export default function Chooser(){ useArtifactState(null); return <><O0 /><O1 /><O2 /><O3 /><O4 /></>; }",
        ].join("\n");
        return { sessionId: "generation-session", response: "Done", changed: true };
      },
      compileWidget: async (_language, source) => {
        compiled.push(source);
        return { token: "00000000-0000-4000-8000-000000000001", document: "<html>Chooser</html>" };
      },
    });
    const result = await generate(integration, request());
    const manifest = readPrototypeSource(result.source)!;
    expect(compiled).toEqual([result.source]);
    expect(manifest.options.map((option) => option.id)).toEqual(ids);
    expect(manifest.chooser.dependencies).toEqual([
      "@cake/artifact-sdk",
      ...ids.map((id) => `cake:prototype/${id}`),
    ]);
    expect(manifest.options[0]!.dependencies).toEqual(["cake:prototype/tokens"]);
    expect(manifest.shared.map((module) => module.id)).toEqual(["tokens"]);
  });
});

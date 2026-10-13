import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { generateReviewedWidget } from "../../../../src/domain/widgets/widgetGenerationReview";
import { ProjectSessionIntegrationHost } from "../../../../src/layers/ProjectSessionIntegrationHost";
import type { WidgetCandidate } from "../../../../src/contracts/widgets/widget-candidate";
import type { InlineWidgetGenerationRequest } from "../../../../src/contracts/widgets/widget-generation";
import { RenderedWidgetCaptureError } from "../../../../src/contracts/widgets/rendered-widget-capture-errors";
import { inlineWidgetDocument } from "../../../../src/services/widgets/inline-widget-document-registry";

const source = (name: string) =>
  `\`\`\`cake-react\nexport default function ${name}(){ return <div>${name}</div> }\n\`\`\``;

function host(options: {
  generation?: string;
  reviews: string[];
  compileFailures?: Set<string>;
  signal?: AbortSignal;
  visualReview?: (signal: AbortSignal | undefined) => Promise<string>;
  captureError?: RenderedWidgetCaptureError;
  retainError?: string;
  stageState?: (candidate: WidgetCandidate) => void;
}) {
  const calls: string[] = [];
  const generationInputs: unknown[] = [];
  const captureStates: unknown[] = [];
  const capturedTokens: string[] = [];
  const reviewContexts: string[] = [];
  const repairInputs: unknown[] = [];
  const reviewInputs: unknown[] = [];
  let token = 0;
  const integration = new ProjectSessionIntegrationHost({
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
      return { sessionId: "generation-session", response: options.generation ?? source("Initial") };
    },
    retainWidgetBrowser: async (compiled) => {
      calls.push(`retain:${compiled.token.slice(-1)}`);
      if (options.retainError) throw new Error(options.retainError);
      return { digest: "a".repeat(64) };
    },
    compileWidget: async (_language, candidate) => {
      const name = candidate.match(/function (\w+)/)?.[1] ?? "unknown";
      calls.push(`compile:${name}`);
      if (options.compileFailures?.has(name)) throw new Error(`bad ${name}`);
      token += 1;
      return {
        token: `00000000-0000-4000-8000-${String(token).padStart(12, "0")}`,
        document: `<html>${name}</html>`,
      };
    },
    captureWidget: async (_sessionId, widget, _signal, pluginState) => {
      captureStates.push(pluginState);
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
      if (input.candidate) options.stageState?.(input.candidate);
      calls.push(`repair:${input.diagnostic?.split(":")[0]}`);
      return { sessionId: "repair", response: source("Repaired") };
    },
    runWidgetVisualReview: async (input) => {
      reviewInputs.push(input);
      const { signal, context } = input;
      reviewContexts.push(context);
      calls.push("review");
      return {
        sessionId: "review",
        response: options.visualReview
          ? await options.visualReview(signal)
          : (options.reviews.shift() ?? "ACCEPT_CURRENT"),
      };
    },
  });
  return {
    integration,
    calls,
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

  it("generates, captures and reviews plugins with their actual durable state", async () => {
    const fixture = host({ reviews: ["ACCEPT_CURRENT"] });
    const initialState = { topic: "Cake and Pi", step: 1 };
    await generate(fixture.integration, { ...request(), surface: "session-plugin", initialState });
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
    expect(JSON.parse(fixture.reviewContexts[0]!)).toMatchObject({ initialState });
  });
  it("starts a durable revision from the existing source and reviews the replacement", async () => {
    const fixture = host({ reviews: ["ACCEPT_CURRENT"] });
    const revise = fixture.integration.runtimeIntegrations("project-session").reviseInlineWidget;
    if (!revise) throw new Error("Missing widget revision integration");

    const result = await revise({
      sessionId: "project-session",
      generationSessionId: "existing-generation",
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
    const fixture = host({ reviews: [source("Second"), "ACCEPT_CURRENT"] });
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
      reviews: [source("Third"), source("Forbidden")],
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
});

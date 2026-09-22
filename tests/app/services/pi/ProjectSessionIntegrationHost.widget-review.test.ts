import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { generateReviewedWidget } from "../../../../src/domain/widgets/widgetGenerationReview";
import { ProjectSessionIntegrationHost } from "../../../../src/services/pi/ProjectSessionIntegrationHost";
import type { InlineWidgetGenerationRequest } from "../../../../src/domain/widgets/widgetGenerationReview";
import { RenderedWidgetCaptureError } from "../../../../src/services/widgets/RenderedWidgetCapture";

const source = (name: string) =>
  `\`\`\`cake-react\nexport default function ${name}(){ return <div>${name}</div> }\n\`\`\``;

function host(options: {
  generation?: string;
  reviews: string[];
  compileFailures?: Set<string>;
  signal?: AbortSignal;
  visualReview?: (signal: AbortSignal | undefined) => Promise<string>;
  captureError?: RenderedWidgetCaptureError;
}) {
  const calls: string[] = [];
  const generationInputs: unknown[] = [];
  const captureStates: unknown[] = [];
  const reviewContexts: string[] = [];
  let token = 0;
  const integration = new ProjectSessionIntegrationHost({
    workspacePath: "/workspace",
    runReviewedWidget: generateReviewedWidget,
    execute: (effect, signal) => Effect.runPromise(effect, signal ? { signal } : undefined),
    agentDir: "/agent",
    sessionDir: "/sessions",
    emit: vi.fn(),
    requestUi: vi.fn(),
    requestArtifact: vi.fn(),
    requestApplicationControl: vi.fn(),
    requireVisionModel: async (model) => {
      calls.push(`vision:${model?.id}`);
    },
    runWidgetGeneration: async (input) => {
      generationInputs.push(input);
      calls.push("generate");
      return { sessionId: "generation-session", response: options.generation ?? source("Initial") };
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
      calls.push(`capture:${widget.token.slice(-1)}`);
      if (options.captureError) throw options.captureError;
      return { pngBase64: "cG5n", diagnostics: ["widget=560x480"] };
    },
    runWidgetRepair: async ({ diagnostic }) => {
      calls.push(`repair:${diagnostic?.split(":")[0]}`);
      return { sessionId: "repair", response: source("Repaired") };
    },
    runWidgetVisualReview: async ({ signal, context }) => {
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
  return { integration, calls, generationInputs, captureStates, reviewContexts };
}

const request = (signal?: AbortSignal): InlineWidgetGenerationRequest => ({
  sessionId: "project-session",
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
  it("generates, captures and reviews plugins with their actual durable state", async () => {
    const fixture = host({ reviews: ["ACCEPT_CURRENT"] });
    const initialState = { topic: "Cake and Pi", step: 1 };
    await generate(fixture.integration, { ...request(), surface: "session-plugin", initialState });
    expect(fixture.generationInputs).toEqual([expect.objectContaining({ initialState })]);
    expect(fixture.captureStates).toEqual([initialState]);
    expect(JSON.parse(fixture.reviewContexts[0]!)).toMatchObject({ initialState });
  });
  it("starts a durable revision from the existing source and reviews the replacement", async () => {
    const fixture = host({ reviews: ["ACCEPT_CURRENT"] });
    const revise = fixture.integration.runtimeIntegrations("project-session").reviseInlineWidget;
    if (!revise) throw new Error("Missing widget revision integration");

    const result = await revise({
      sessionId: "project-session",
      source: "export default function Existing(){ return <div>Existing</div> }",
      brief: "Show the flow",
      fallback: "Readable fallback",
      instructions: "Increase contrast",
      model: { provider: "fixture", id: "vision" },
    });

    expect(result.source).toContain("function Repaired");
    expect(fixture.calls).toEqual([
      "vision:vision",
      "repair:Requested durable revision",
      "compile:Repaired",
      "capture:1",
      "review",
    ]);
  });

  it("captures and reviews every rendered candidate before accepting a replacement", async () => {
    const fixture = host({ reviews: [source("Second"), "ACCEPT_CURRENT"] });
    const result = await generate(fixture.integration, request());
    expect(result.source).toContain("function Second");
    expect(fixture.calls).toEqual([
      "vision:vision",
      "generate",
      "compile:Initial",
      "capture:1",
      "review",
      "compile:Second",
      "capture:2",
      "review",
    ]);
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

  it("fails preflight before generation when vision review is unavailable", async () => {
    const fixture = host({ reviews: [] });
    await expect(generate(fixture.integration, { ...request(), model: undefined })).rejects.toThrow(
      "vision-capable model",
    );
    expect(fixture.calls).toEqual(["vision:undefined"]);
  });
});

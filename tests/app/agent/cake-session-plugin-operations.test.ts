import { describe, expect, it, vi } from "vitest";
import { createCakeSessionPluginOperations } from "../../../src/services/pi/runtime/cake-session-plugin-operations";

const context = {
  signal: new AbortController().signal,
  toolCallId: "tool-1",
  runtime: { model: { provider: "openai", id: "builder" } },
};

describe("Cake Session Plugin operations", () => {
  it("delegates source generation and durably presents the resulting plugin", async () => {
    const generate = vi.fn(async () => ({
      source: "export default function Plugin(){ return <div>Tour</div> }",
      generationSessionId: "builder-session",
    }));
    const present = vi.fn(async () => undefined);
    const operations = createCakeSessionPluginOperations({
      sessionId: "session-1",
      generate,
      present,
      setState: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    });
    const operation = operations.find((candidate) => candidate.command === "plugins.present")!;

    await operation.execute(
      {
        plugin: {
          id: "change-tour",
          title: "Change tour",
          brief: "Previous and Next buttons send visible session messages.",
          initialState: { current: 1, total: 4 },
        },
      },
      context,
    );

    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        surface: "session-plugin",
        initialState: { current: 1, total: 4 },
        model: { provider: "openai", id: "builder" },
      }),
    );
    expect(present).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        id: "change-tour",
        slot: "composer.above",
        state: { current: 1, total: 4 },
        generationSessionId: "builder-session",
      }),
    );
  });

  it("mounts the prebuilt action bar without invoking generation", async () => {
    const generate = vi.fn();
    const present = vi.fn(async () => undefined);
    const operations = createCakeSessionPluginOperations({
      sessionId: "session-1",
      generate,
      present,
      setState: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    });

    await operations
      .find((candidate) => candidate.command === "plugins.present")!
      .execute(
        {
          plugin: {
            id: "draw-guide",
            title: "Draw guide",
            preset: "action-bar",
            initialState: {
              label: "Current topic",
              progress: { current: 2, total: 4 },
              actions: [
                {
                  id: "next",
                  label: "Next",
                  message: "Explain the next step, then update the guide.",
                  primary: true,
                },
              ],
            },
          },
        },
        context,
      );

    expect(generate).not.toHaveBeenCalled();
    expect(present).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        id: "draw-guide",
        preset: "action-bar",
        state: {
          label: "Current topic",
          progress: { current: 2, total: 4 },
          actions: [
            {
              id: "next",
              label: "Next",
              message: "Explain the next step, then update the guide.",
              primary: true,
            },
          ],
        },
      }),
    );
  });

  it("updates state and deletes without regenerating source", async () => {
    const setState = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    const operations = createCakeSessionPluginOperations({
      sessionId: "session-1",
      generate: vi.fn(),
      present: vi.fn(),
      setState,
      delete: remove,
    });

    await operations
      .find((candidate) => candidate.command === "plugins.update")!
      .execute({ id: "tour", state: { current: 2 } }, context);
    await operations
      .find((candidate) => candidate.command === "plugins.delete")!
      .execute({ id: "tour" }, context);

    expect(setState).toHaveBeenCalledWith("tour", { current: 2 });
    expect(remove).toHaveBeenCalledWith("tour");
  });
});

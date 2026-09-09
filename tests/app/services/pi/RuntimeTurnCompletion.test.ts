import { describe, expect, it } from "vitest";
import { RuntimeTurnCompletion } from "../../../../src/services/pi/runtime/RuntimeTurnCompletion";

describe("RuntimeTurnCompletion", () => {
  it("handles Pi-expanded input and commands that do not start a run", async () => {
    const turns = new RuntimeTurnCompletion();
    const expanded = turns.track("template", "/review", true);
    turns.consume("Review this code using the project template.");
    expect(turns.executingIds()).toEqual(["template"]);
    turns.settle();
    await expanded;
    const handled = turns.track("command", "/extension-command", true);
    turns.finishHandledInput("command");
    await handled;
    expect(turns.executingIds()).toEqual([]);
  });

  it("does not settle queued input until it has been consumed", async () => {
    const turns = new RuntimeTurnCompletion();
    let completed = false;
    const pending = turns.track("queued", "next assignment").then(() => {
      completed = true;
    });
    turns.settle();
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(turns.executingIds()).toEqual([]);
    turns.consume("next assignment");
    expect(turns.executingIds()).toEqual(["queued"]);
    turns.settle();
    await pending;
    expect(completed).toBe(true);
  });

  it("correlates repeated identical input by consumption order", async () => {
    const turns = new RuntimeTurnCompletion();
    const first = turns.track("first", "continue");
    const second = turns.track("second", "continue");
    turns.consume("continue");
    expect(turns.executingIds()).toEqual(["first"]);
    turns.settle();
    await first;
    turns.consume("continue");
    expect(turns.executingIds()).toEqual(["second"]);
    turns.settle();
    await second;
  });

  it("rejects a handled input that could not be dispatched", async () => {
    const turns = new RuntimeTurnCompletion();
    const pending = turns.track("failed", "implement");
    turns.failHandledInput("failed", new Error("delivery failed"));
    await expect(pending).rejects.toThrow("delivery failed");
    expect(turns.executingIds()).toEqual([]);
  });

  it("cancels pending input without completing it successfully", async () => {
    const turns = new RuntimeTurnCompletion();
    const running = turns.track("running", "implement");
    turns.consume("implement");
    const queued = turns.track("queued", "review");
    turns.cancel(true);
    await expect(queued).rejects.toThrow("Queued input was canceled");
    expect(turns.executingIds()).toEqual(["running"]);
    turns.cancel();
    await expect(running).rejects.toThrow("Session was aborted");
    turns.settle();
    expect(turns.executingIds()).toEqual([]);
  });
});

/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreePromptConfirmation } from "../../../src/renderer/components/worktree-prompt-confirmation";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function fixture() {
  const actions = {
    confirmingPrompt: false,
    confirmAgentPrompt: vi.fn(async (_decision: "run" | "cancel" | "tool-prune") => true),
  };
  const view = render(
    <>
      <input aria-label="Unrelated composer" />
      <WorktreePromptConfirmation
        confirmation={{ id: "one", estimatedTokens: 50_001 }}
        actions={actions}
      />
    </>,
  );
  return { actions, ...view };
}

describe("worktree prompt countdown", () => {
  it("shows a circular, nonnumeric countdown and defaults to Run after ten seconds", async () => {
    const { actions } = fixture();
    expect(
      screen.getByRole("img", { name: "Runs automatically when countdown completes" }),
    ).toBeTruthy();
    await act(async () => vi.advanceTimersByTime(9999));
    expect(actions.confirmAgentPrompt).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1));
    expect(actions.confirmAgentPrompt).toHaveBeenCalledExactlyOnceWith("run");
  });

  it.each(["Run", "Cancel", "Tool prune and run"])(
    "choosing %s cancels the timer",
    async (label) => {
      const { actions } = fixture();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: label })));
      await act(async () => vi.advanceTimersByTime(10_000));
      expect(actions.confirmAgentPrompt).toHaveBeenCalledTimes(1);
      expect(actions.confirmAgentPrompt).toHaveBeenCalledWith(
        label === "Run" ? "run" : label === "Cancel" ? "cancel" : "tool-prune",
      );
    },
  );

  it("scopes Enter to the confirmation, leaves composer Enter alone and deduplicates click/Enter/timeout", async () => {
    const { actions } = fixture();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Unrelated composer" }), {
      key: "Enter",
    });
    expect(actions.confirmAgentPrompt).not.toHaveBeenCalled();
    await act(async () => {
      const confirmation = screen.getByRole("group", { name: "Agent request confirmation" });
      fireEvent.keyDown(confirmation, { key: "Enter", isComposing: true });
      expect(actions.confirmAgentPrompt).not.toHaveBeenCalled();
      fireEvent.keyDown(confirmation, { key: "Enter" });
      fireEvent.click(screen.getByRole("button", { name: "Run" }));
      vi.advanceTimersByTime(10_000);
    });
    expect(actions.confirmAgentPrompt).toHaveBeenCalledExactlyOnceWith("run");
  });

  it("cleans up on navigation/unmount and starts a fresh timer for a replacement prompt", async () => {
    const { actions, rerender, unmount } = fixture();
    await act(async () => vi.advanceTimersByTime(9000));
    rerender(
      <WorktreePromptConfirmation
        confirmation={{ id: "two", estimatedTokens: 50_001 }}
        actions={actions}
      />,
    );
    await act(async () => vi.advanceTimersByTime(1000));
    expect(actions.confirmAgentPrompt).not.toHaveBeenCalled();
    unmount();
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(actions.confirmAgentPrompt).not.toHaveBeenCalled();
  });

  it("allows an explicit retry after a failed RPC without rearming automatic Run", async () => {
    const { actions } = fixture();
    actions.confirmAgentPrompt.mockResolvedValueOnce(false);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(actions.confirmAgentPrompt).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
    expect(actions.confirmAgentPrompt).toHaveBeenCalledTimes(2);
  });
});

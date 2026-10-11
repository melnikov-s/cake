/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnId, type ConversationSnapshot } from "../../../src/ipc/conversation-data";
import type { ModelOption, ModelPreset } from "../../../src/ipc/session-contract";
import type { Client } from "../../../src/renderer/client/Client";
import {
  configurationModel,
  configurationSnapshot,
  renderChatConfiguration,
} from "./chat-configuration-workflow-fixture";

const gpt = configurationModel();
const opus = configurationModel({
  provider: "anthropic",
  providerName: "Anthropic",
  id: "claude-opus",
  name: "Claude Opus",
  availableThinkingLevels: ["low", "high", "xhigh", "max"],
  fastMode: true,
});
const locked = configurationModel({
  provider: "anthropic",
  providerName: "Anthropic",
  id: "locked",
  name: "Disconnected model",
  availableThinkingLevels: ["off"],
  authenticated: false,
});
const preset: ModelPreset = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Deep review",
  provider: opus.provider,
  modelId: opus.id,
  thinkingLevel: "max",
  fastMode: true,
};
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
const picker = () => screen.getByRole("button", { name: "Model configuration" });
async function submit(user: ReturnType<typeof renderChatConfiguration>["user"], text: string) {
  await user.type(screen.getByRole("combobox", { name: "Message" }), text);
  await user.click(screen.getByRole("button", { name: "Send" }));
}

afterEach(cleanup);

describe("Chat configuration workflow", () => {
  // In-process tests prove rendered availability and payloads, not native popover/focus behavior.
  it("offers authenticated models with per-conversation capabilities and follows authoritative replacements", async () => {
    const list = vi.fn<Client["models"]["list"]>(async () => []);
    const limitedOpus = {
      ...opus,
      availableThinkingLevels: ["low", "high"] as const,
      fastMode: false,
    };
    using fixture = renderChatConfiguration({
      client: { models: { list } },
      models: [gpt, opus, locked],
      secondaryModels: [limitedOpus],
    });
    const first = within(screen.getByRole("region", { name: "First conversation" }));
    const second = within(screen.getByRole("region", { name: "Second conversation" }));
    const firstPicker = first.getByRole("button", { name: "Model configuration" });
    const secondPicker = second.getByRole("button", { name: "Model configuration" });
    expect(firstPicker.textContent).toContain("GPT-5");
    expect(secondPicker.textContent).toContain("Claude Opus");
    expect(secondPicker.textContent).toContain("High");
    expect(list).not.toHaveBeenCalled();

    await fixture.user.click(firstPicker);
    await fixture.user.click(screen.getByRole("button", { name: "Change model" }));
    expect(screen.getByRole("button", { name: "GPT-5 gpt-5" })).toBeDefined();
    expect(screen.queryByRole("button", { name: /Disconnected model/ })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Claude Opus claude-opus" }));
    expect(screen.getByRole("button", { name: "Max" })).toBeDefined();
    expect(screen.getByRole("switch", { name: "Fast mode" })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Cancel" }));

    await fixture.user.click(secondPicker);
    expect(screen.getByRole("button", { name: "Low" })).toBeDefined();
    expect(screen.getByRole("button", { name: "High" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Max" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Fast mode" })).toBeNull();
    await fixture.user.click(secondPicker);

    await fixture.user.click(firstPicker);
    await fixture.user.click(screen.getByRole("button", { name: "Change model" }));
    fixture.publish(
      configurationSnapshot("first", [
        { ...gpt, name: "Refreshed current model" },
        limitedOpus,
        { ...locked, name: "Newly connected model", authenticated: true },
      ]),
    );
    expect(firstPicker.textContent).toContain("Refreshed current model");
    expect(screen.getByRole("button", { name: "Newly connected model locked" })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Claude Opus claude-opus" }));
    expect(screen.getByRole("button", { name: "High" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Max" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Fast mode" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Cancel" }));
    await fixture.user.click(firstPicker);
    await fixture.user.click(screen.getByRole("button", { name: "Change model" }));
    fixture.publish(
      configurationSnapshot("first", [
        gpt,
        { ...limitedOpus, authenticated: false },
        { ...locked, name: "Newly connected model", authenticated: true },
      ]),
    );
    expect(screen.queryByRole("button", { name: "Claude Opus claude-opus" })).toBeNull();
    expect(screen.getByRole("button", { name: "Newly connected model locked" })).toBeDefined();
    expect(list).not.toHaveBeenCalled();
  });

  it("applies reasoning, model capabilities and named presets to the active runtime", async () => {
    const catalog = [gpt, opus, locked];
    let snapshot: ConversationSnapshot = {
      ...configurationSnapshot("first", catalog),
      thinkingLevel: "medium",
    };
    const list = vi.fn<Client["models"]["list"]>(async () => catalog);
    const setThinkingLevel = vi.fn<Client["sessionChats"]["setThinkingLevel"]>(
      async ({ level }) => {
        snapshot = { ...snapshot, thinkingLevel: level };
        fixture.publish(snapshot);
      },
    );
    const applyConfiguration = vi.fn<Client["sessionChats"]["applyConfiguration"]>(
      async ({ configuration }) => {
        const model = catalog.find(
          (candidate) =>
            candidate.provider === configuration.provider && candidate.id === configuration.modelId,
        );
        if (!model) throw new Error("Requested a model outside the fake runtime catalog");
        snapshot = {
          ...configurationSnapshot("first", [
            model,
            ...catalog.filter((candidate) => candidate !== model),
          ]),
          thinkingLevel: configuration.thinkingLevel,
          fastMode: configuration.fastMode,
        };
        fixture.publish(snapshot);
      },
    );
    using fixture = renderChatConfiguration({
      models: catalog,
      presets: [preset],
      client: { models: { list }, sessionChats: { setThinkingLevel, applyConfiguration } },
    });
    fixture.publish(snapshot);
    expect(picker().textContent).toContain("Medium");

    await fixture.user.click(picker());
    await fixture.user.click(screen.getByRole("button", { name: "High" }));
    await waitFor(() => expect(setThinkingLevel).toHaveBeenCalledOnce());
    expect(setThinkingLevel).toHaveBeenCalledWith(
      { sessionId: "first", level: "high" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(picker().textContent).toContain("High");
    expect(screen.queryByRole("dialog")).toBeNull();

    await fixture.user.click(picker());
    await fixture.user.click(screen.getByRole("button", { name: "Change model" }));
    await fixture.user.click(screen.getByRole("button", { name: "Claude Opus claude-opus" }));
    expect(screen.queryByRole("button", { name: "Medium" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Xhigh" }));
    await fixture.user.click(screen.getByRole("switch", { name: "Fast mode" }));
    expect(applyConfiguration).not.toHaveBeenCalled();
    expect(picker().textContent).toContain("GPT-5");
    await fixture.user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(applyConfiguration).toHaveBeenCalledOnce());
    expect(applyConfiguration).toHaveBeenCalledWith(
      {
        sessionId: "first",
        configuration: {
          provider: "anthropic",
          modelId: "claude-opus",
          thinkingLevel: "xhigh",
          fastMode: true,
        },
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(picker().textContent).toContain("Claude Opus");
    expect(picker().textContent).toContain("Xhigh");
    expect(picker().textContent).toContain("Fast");

    await fixture.user.click(picker());
    await fixture.user.click(screen.getByRole("button", { name: "Change model" }));
    await fixture.user.click(
      screen.getByRole("button", { name: "Deep review anthropic/claude-opus" }),
    );
    await waitFor(() => expect(applyConfiguration).toHaveBeenCalledTimes(2));
    expect(applyConfiguration).toHaveBeenLastCalledWith(
      {
        sessionId: "first",
        configuration: expect.objectContaining({
          provider: "anthropic",
          modelId: "claude-opus",
          thinkingLevel: "max",
          fastMode: true,
        }),
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(picker().textContent).toContain("Deep review");
    expect(picker().textContent).toContain("Max");
    expect(picker().textContent).toContain("Fast");
    await fixture.user.click(picker());
    await fixture.user.click(screen.getByRole("button", { name: "Change model" }));
    expect(
      screen
        .getByRole("button", { name: "Deep review anthropic/claude-opus" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(list).not.toHaveBeenCalled();
  });

  it("loads deferred catalogs only when opened, ignores stale responses, and removes old fallback labels", async () => {
    const older = deferred<readonly ModelOption[]>();
    const newer = deferred<readonly ModelOption[]>();
    const list = vi
      .fn<Client["models"]["list"]>()
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise)
      .mockResolvedValueOnce([]);
    using fixture = renderChatConfiguration({ deferred: true, client: { models: { list } } });

    await submit(fixture.user, "/model openai/gpt-5");
    expect(picker().textContent).toContain("gpt-5");
    expect(list).not.toHaveBeenCalled();
    await fixture.user.click(picker());
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await fixture.user.click(picker());
    await fixture.user.click(picker());
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await act(async () => newer.resolve([{ ...gpt, name: "Newest name" }, locked]));
    expect(picker().textContent).toContain("Newest name");
    await act(async () => older.resolve([{ ...gpt, name: "Stale name" }]));
    expect(picker().textContent).toContain("Newest name");
    await fixture.user.click(screen.getByRole("button", { name: "Change model" }));
    expect(screen.getByRole("button", { name: "Newest name gpt-5" })).toBeDefined();
    expect(screen.queryByRole("button", { name: /Stale name|Disconnected model/ })).toBeNull();

    await fixture.user.click(picker());
    await fixture.user.click(picker());
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(picker().textContent).not.toContain("Newest name"));
    expect(picker().textContent).toContain("gpt-5");
    await fixture.user.click(screen.getByRole("button", { name: "Change model" }));
    expect(screen.getByText("No matching models")).toBeDefined();
  });

  it("carries edited preset choices through a local model command and catalog removal into the first prompt", async () => {
    const list = vi.fn<Client["models"]["list"]>(async () => [gpt, opus, locked]);
    const start = vi.fn<Client["projectSessions"]["start"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000001"),
    );
    const applyConfiguration = vi.fn<Client["sessionChats"]["applyConfiguration"]>(
      async () => undefined,
    );
    using fixture = renderChatConfiguration({
      deferred: true,
      presets: [preset],
      client: {
        models: { list },
        projectSessions: { start },
        sessionChats: { applyConfiguration },
      },
    });

    await fixture.user.click(picker());
    await fixture.user.click(
      screen.getByRole("button", { name: "Deep review anthropic/claude-opus" }),
    );
    expect(picker().textContent).toContain("Deep review");
    expect(picker().textContent).toContain("Max");
    expect(picker().textContent).toContain("Fast");
    expect(list).toHaveBeenCalledOnce();
    await fixture.user.click(picker());
    await fixture.user.click(await screen.findByRole("button", { name: "High" }));
    expect(list).toHaveBeenCalledTimes(2);
    await fixture.user.click(picker());
    await fixture.user.click(screen.getByRole("switch", { name: "Fast mode" }));
    expect(screen.getByRole("switch", { name: "Fast mode" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    await fixture.user.click(picker());
    expect(list).toHaveBeenCalledTimes(3);
    await submit(fixture.user, "/model openai/gpt-5");
    expect(picker().textContent).toContain("GPT-5");
    expect(picker().textContent).toContain("High");
    expect(start).not.toHaveBeenCalled();
    expect(applyConfiguration).not.toHaveBeenCalled();

    list.mockResolvedValueOnce([]);
    await fixture.user.click(picker());
    await waitFor(() => expect(picker().textContent).toContain("gpt-5"));
    expect(picker().textContent).toContain("High");
    await fixture.user.click(picker());
    await submit(fixture.user, "Implement the API");
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "first",
        workingDirectory: "/project",
        text: "Implement the API",
        configuration: {
          provider: "openai",
          modelId: "gpt-5",
          thinkingLevel: "high",
          fastMode: false,
        },
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(applyConfiguration).not.toHaveBeenCalled();
  });
});

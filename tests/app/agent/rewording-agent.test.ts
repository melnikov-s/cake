import { beforeEach, describe, expect, it, vi } from "vitest";
import { rewordSelectionWithProjectContext } from "../../../src/services/pi/runtime/rewording-agent";
import { runIsolatedSession } from "../../../src/services/pi/runtime/isolated-session-runner";
import {
  dictationRewordingGuidance,
  REWORD_CHARACTER_LIMIT,
} from "../../../src/domain/utility-work/utilityWork";
import type { IsolatedSessionResult } from "../../../src/services/pi/runtime/isolated-session-runner";

vi.mock("../../../src/services/pi/runtime/isolated-session-runner", () => ({
  runIsolatedSession: vi.fn(),
}));

const runIsolatedSessionMock = vi.mocked(runIsolatedSession);
const rewordingPolicy = {
  systemGuidance: dictationRewordingGuidance,
  characterLimit: REWORD_CHARACTER_LIMIT,
};

function isolatedResult(overrides: Partial<IsolatedSessionResult>): IsolatedSessionResult {
  return { sessionId: "utility-session", sessionFile: undefined, response: "", ...overrides };
}

describe("rewording agent", () => {
  beforeEach(() => {
    runIsolatedSessionMock.mockReset();
  });

  it("runs one ephemeral read-only session with project context and dictation guidance", async () => {
    runIsolatedSessionMock.mockResolvedValue(isolatedResult({ response: "Use the Git skills." }));
    const text = await rewordSelectionWithProjectContext({
      ...rewordingPolicy,
      workspacePath: "/project",
      agentDir: "/agent-dir",
      utilityModel: { provider: "openai", modelId: "gpt-5-mini", thinkingLevel: "low" },
      selection: "Use the get skills with the sub Asians",
      guidance: " Keep it short. ",
    });

    expect(text).toBe("Use the Git skills.");
    expect(runIsolatedSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/project",
        agentDir: "/agent-dir",
        projectTrusted: true,
        ephemeral: true,
        includeSkills: true,
        includeContextFiles: true,
        resourceRoot: "/project",
        tools: ["read", "ls"],
        customTools: expect.arrayContaining([
          expect.objectContaining({ name: "read" }),
          expect.objectContaining({ name: "ls" }),
        ]),
        model: { provider: "openai", id: "gpt-5-mini" },
        thinkingLevel: "low",
        modelPurpose: "utility",
        signal: undefined,
      }),
    );
    const options = runIsolatedSessionMock.mock.calls[0]![0];
    expect(JSON.parse(options.prompt)).toEqual({
      selection: "Use the get skills with the sub Asians",
      guidance: "Keep it short.",
    });
  });

  it("omits blank guidance and passes thinking level off through to the session", async () => {
    runIsolatedSessionMock.mockResolvedValue(isolatedResult({ response: "Clear text" }));
    await rewordSelectionWithProjectContext({
      ...rewordingPolicy,
      workspacePath: "/project",
      agentDir: "/agent-dir",
      utilityModel: { provider: "openai", modelId: "gpt-5-mini", thinkingLevel: "off" },
      selection: "Clear text",
    });

    const options = runIsolatedSessionMock.mock.calls[0]![0];
    expect(options.thinkingLevel).toBe("off");
    expect(JSON.parse(options.prompt)).toEqual({ selection: "Clear text", guidance: undefined });
  });

  it("propagates the isolated session error", async () => {
    runIsolatedSessionMock.mockResolvedValue(
      isolatedResult({ error: "Unknown utility model openai/gpt-5-mini" }),
    );
    await expect(
      rewordSelectionWithProjectContext({
        ...rewordingPolicy,
        workspacePath: "/project",
        agentDir: "/agent-dir",
        utilityModel: { provider: "openai", modelId: "gpt-5-mini", thinkingLevel: "off" },
        selection: "text",
      }),
    ).rejects.toThrow("Unknown utility model openai/gpt-5-mini");
  });

  it("rejects an empty rewrite and truncates oversized rewrites", async () => {
    runIsolatedSessionMock.mockResolvedValue(isolatedResult({ response: "   " }));
    await expect(
      rewordSelectionWithProjectContext({
        ...rewordingPolicy,
        workspacePath: "/project",
        agentDir: "/agent-dir",
        utilityModel: { provider: "openai", modelId: "gpt-5-mini", thinkingLevel: "off" },
        selection: "text",
      }),
    ).rejects.toThrow("empty rewrite");

    const oversized = "x".repeat(REWORD_CHARACTER_LIMIT + 1);
    runIsolatedSessionMock.mockResolvedValue(isolatedResult({ response: oversized }));
    await expect(
      rewordSelectionWithProjectContext({
        ...rewordingPolicy,
        workspacePath: "/project",
        agentDir: "/agent-dir",
        utilityModel: { provider: "openai", modelId: "gpt-5-mini", thinkingLevel: "off" },
        selection: "text",
      }),
    ).resolves.toHaveLength(REWORD_CHARACTER_LIMIT);
  });
});

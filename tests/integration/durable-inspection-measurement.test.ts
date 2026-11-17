import { mkdtemp, readFile, rm } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createProjectSessionRuntime } from "../../src/layers/CakeOperations";
import { durableAnswer } from "../fixtures/durable-chat";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

it("reads cold regular-session history without provider calls or transcript writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-cold-inspection-"));
  const sessionDir = join(directory, "sessions");
  const session = SessionManager.create(directory, sessionDir);
  session.appendMessage({ role: "user", content: "Recorded input", timestamp: 1 });
  session.appendMessage(durableAnswer("Recorded answer"));
  const sessionFile = session.getSessionFile();
  if (!sessionFile) throw new Error("Fixture session was not persisted");
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("No provider calls allowed"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(directory, "agent"));
  try {
    const runtime = await createProjectSessionRuntime({
      cwd: directory,
      agentDir: join(directory, "agent"),
      sessionDir,
      directSessionDir: true,
      sessionFile,
      newSession: false,
      onEvent: () => {},
      requestUi: async () => undefined,
    });
    const afterAcquisition = await readFile(sessionFile, "utf8");
    try {
      const history = await runtime.inspectSession({
        kind: "history",
        roles: ["user", "assistant"],
      });
      const compactions = await runtime.inspectSession({ kind: "compactions" });
      await runtime.inspectSession({ kind: "tree" });
      expect(history).toMatchObject({
        total: 2,
        entries: [
          { role: "user", text: "Recorded input", active: true },
          { role: "assistant", text: "Recorded answer", active: true },
        ],
      });
      expect(compactions).toMatchObject({ entries: [] });
      expect(fetch).not.toHaveBeenCalled();
      expect(await readFile(sessionFile, "utf8")).toBe(afterAcquisition);
    } finally {
      await runtime.dispose();
    }
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorktreeRecord } from "../../../src/contracts/worktrees/managed-worktree-data";
import type { Client } from "../../../src/renderer/client/Client";
import { QuakeTerminal } from "../../../src/renderer/components/quake-terminal";
import { WorktreePill } from "../../../src/renderer/components/worktree-pill";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => (resolve = complete));
  return { promise, resolve };
}

function renderRetirement(
  workingDirectoryStatus: Client["terminals"]["workingDirectoryStatus"] = async () => ({
    runningProgramCount: 1,
  }),
) {
  const inspect = vi.fn(workingDirectoryStatus);
  const close = vi.fn<Client["terminals"]["closeWorkingDirectory"]>(async () => undefined);
  const resolve = vi.fn<Client["projectSessions"]["resolveWorkingDirectory"]>(
    async ({ workingDirectory }) => ({
      projectPath: "/project",
      workingDirectory,
      resolvedSessionIds: [workingDirectory === "/one" ? "session-one" : "session-two"],
      failures: [],
    }),
  );
  const fixture = createRendererStoreFixture({
    client: {
      terminals: { workingDirectoryStatus: inspect, closeWorkingDirectory: close },
      projectSessions: { resolveWorkingDirectory: resolve },
    },
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: ["one", "two"].map((name) =>
      sessionSummary({
        sessionId: `session-${name}`,
        projectPath: "/project",
        projectName: "Project",
        workingDirectory: `/${name}`,
      }),
    ),
  });
  const sessions = ["one", "two"].map((name) => {
    const session = fixture.root.sessionRegistry.load(`session-${name}`, `/${name}`);
    const record: WorktreeRecord = {
      projectPath: "/project",
      worktreePath: `/${name}`,
      branch: `agent/${name}`,
      baseBranch: "main",
      createdAt: new Date(0).toISOString(),
      state: "landed",
    };
    return { name, session, record };
  });
  const view = render(
    <>
      {sessions.map(({ name, session, record }) => (
        <section key={name} aria-label={`Worktree ${name}`}>
          <WorktreePill
            creation={fixture.root.projectWorkbenchStore.sessionCreationStore.worktrees}
            actions={session.worktreeStore}
            record={record}
            sessionId={`session-${name}`}
            projectPath="/project"
            onConfigured={() => {}}
          />
        </section>
      ))}
      <QuakeTerminal
        store={fixture.root.terminalStore}
        retirement={fixture.root.workingDirectoryRetirementStore}
      />
    </>,
  );
  return {
    user: userEvent.setup(),
    inspect,
    close,
    resolve,
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

function resolveButton(name = "one") {
  return within(screen.getByRole("region", { name: `Worktree ${name}` })).getByRole("button", {
    name: "Resolve",
  });
}

afterEach(cleanup);

describe("Working Directory retirement workflow", () => {
  it("closes idle terminals before resolving the worktree without a confirmation", async () => {
    using fixture = renderRetirement(async () => ({ runningProgramCount: 0 }));
    await fixture.user.click(resolveButton());
    await waitFor(() => expect(fixture.resolve).toHaveBeenCalled());
    expect(fixture.close).toHaveBeenCalledWith(
      "/one",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fixture.close.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.resolve.mock.invocationCallOrder[0]!,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("warns about running programs, cancels without closing them, and permits confirmation on retry", async () => {
    using fixture = renderRetirement(async () => ({ runningProgramCount: 3 }));
    await fixture.user.click(resolveButton());
    expect(
      await screen.findByRole("dialog", { name: "Retire and stop running programs?" }),
    ).toBeDefined();
    expect(screen.getByText(/have 3 running terminal programs across Cake windows/)).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fixture.close).not.toHaveBeenCalled();
    expect(fixture.resolve).not.toHaveBeenCalled();

    await fixture.user.click(resolveButton());
    await fixture.user.click(await screen.findByRole("button", { name: "Continue and stop" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fixture.close).toHaveBeenCalledTimes(1);
    expect(fixture.resolve).toHaveBeenCalledWith(
      { workingDirectory: "/one" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("shows an inspection failure rather than resolving a directory with unknown terminal status", async () => {
    using fixture = renderRetirement(async () => {
      throw new Error("Inspection failed");
    });
    await fixture.user.click(resolveButton());
    expect(await screen.findByText("Inspection failed")).toBeDefined();
    expect(fixture.close).not.toHaveBeenCalled();
    expect(fixture.resolve).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not start another retirement while the first directory is being inspected", async () => {
    const status = deferred<{ runningProgramCount: number }>();
    using fixture = renderRetirement(() => status.promise);
    await fixture.user.click(resolveButton());
    await fixture.user.click(resolveButton("two"));
    expect(fixture.inspect).toHaveBeenCalledTimes(1);
    expect(fixture.close).not.toHaveBeenCalled();
    expect(fixture.resolve).not.toHaveBeenCalled();
    await act(async () => status.resolve({ runningProgramCount: 1 }));
    expect(
      await screen.findByRole("dialog", { name: "Retire and stop running program?" }),
    ).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Continue and stop" }));
    await waitFor(() => expect(fixture.resolve).toHaveBeenCalledTimes(1));
    expect(fixture.resolve).toHaveBeenCalledWith({ workingDirectory: "/one" }, expect.any(Object));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

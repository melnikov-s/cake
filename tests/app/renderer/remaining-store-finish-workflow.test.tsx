/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import { App } from "../../../src/renderer/components/app";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const sessionId = "10000000-0000-4000-8000-000000000001";

function renderRemainingStoreCatalog(start: Client["projectSessions"]["start"]) {
  const fixture = createRendererStoreFixture({
    projects: [
      projectRecord({ path: "/project", name: "Project" }),
      projectRecord({ path: "/other", name: "Other" }),
    ],
    client: {
      projectSessions: { start },
      workspaces: {
        loadStagedSlashCommands: async () => [],
        generateSessionTitle: async () => undefined,
      },
    },
  });
  fixture.root.sessionRegistry.pendingSessions.prepareStaged("/project", sessionId);
  fixture.root.appShellStore.selectProjectSession(sessionId);
  fixture.root.sessionLayoutStore.ensureSession(sessionId);
  fixture.root.projectWorkbenchStore.showLoadedSession(sessionId);
  const view = render(
    <StoreProvider store={fixture.root}>
      <App />
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    async publish(sessions: ReturnType<typeof sessionSummary>[]) {
      await act(async () =>
        applySnapshot(fixture.models.sessionCatalog, { sessions, resolvedHasMoreByProject: {} }),
      );
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

beforeEach(() => {
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
  vi.stubGlobal("matchMedia", (query: string): MediaQueryList => ({
    media: query,
    matches: query === "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }));
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  vi.unstubAllGlobals();
});

const group = (name: string) =>
  within(
    screen
      .getByRole("button", { name: `Open Project Chat for ${name.toLowerCase()}` })
      .closest<HTMLElement>('[data-slot="project-group"]')!,
  );

describe("Remaining Store catalog workflow", () => {
  it("moves a submitted row to its authoritative Project while start is pending, without duplicating or resurrecting it", async () => {
    let accept!: (turnId: TurnId) => void;
    const receipt = new Promise<TurnId>((resolve) => (accept = resolve));
    const start = vi.fn<Client["projectSessions"]["start"]>(() => receipt);
    using fixture = renderRemainingStoreCatalog(start);

    await fixture.user.type(screen.getByRole("combobox", { name: "Message" }), "Pending title");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(group("Project").getByRole("button", { name: /^Pending title / })).toBeDefined();
    expect(group("Other").queryByRole("button", { name: /^Pending title / })).toBeNull();

    // Catalog membership may be corrected independently of the runtime Working Directory.
    await fixture.publish([
      sessionSummary({
        sessionId,
        projectPath: "/other",
        workingDirectory: "/project",
        title: "Authoritative title",
      }),
    ]);
    expect(group("Project").queryByRole("button", { name: /^Pending title / })).toBeNull();
    expect(group("Project").queryByRole("button", { name: /^Authoritative title / })).toBeNull();
    expect(group("Other").getAllByRole("button", { name: /^Authoritative title / })).toHaveLength(
      1,
    );
    expect(document.querySelectorAll(`.session-item[data-session-id="${sessionId}"]`)).toHaveLength(
      1,
    );

    await act(async () => {
      accept(TurnId.make("20000000-0000-4000-8000-000000000001"));
      await receipt;
    });
    expect(group("Other").getAllByRole("button", { name: /^Authoritative title / })).toHaveLength(
      1,
    );
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId, workingDirectory: "/project", text: "Pending title" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await fixture.publish([]);
    expect(screen.queryByRole("button", { name: /^Authoritative title / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Pending title / })).toBeNull();
  });
});

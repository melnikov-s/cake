import { createStore, mount, toSnapshot } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../../../../src/renderer/client/Client";
import type { ProjectCatalogStore } from "../../../../src/renderer/stores/ProjectCatalogStore";
import {
  ProjectOpenStore,
  type ProjectOpenResult,
} from "../../../../src/renderer/stores/ProjectOpenStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";
import { mountWithClient } from "../mount-with-client";

function mountProjectOpen(
  client: Client,
  onAccepted = vi.fn<(result: ProjectOpenResult) => Promise<void>>(async () => undefined),
) {
  const operations = mount(createStore(SessionOperationCoordinatorStore));
  const onOpening = vi.fn();
  const mounted = mountWithClient(
    createStore(ProjectOpenStore, {
      operations,
      projects: {
        nameFromPath: (path: string) => path.split("/").at(-1) ?? path,
        nameForPath: (path: string) => path.split("/").at(-1) ?? path,
      } as ProjectCatalogStore,
      onOpening,
      onAccepted,
    }),
    client,
  );
  return { ...mounted, operations, onAccepted, onOpening };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("ProjectOpenStore", () => {
  it("applies only the latest repeated Project picker result", async () => {
    const pickerResolvers: Array<(path: string) => void> = [];
    const chooseProject = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          pickerResolvers.push(resolve);
        }),
    );
    const inspect = vi.fn(async (request: { operationId: string; path: string }) => ({
      ...request,
      trustRequired: false,
    }));
    const registerProject = vi.fn(async () => undefined);
    const { root, subject, operations } = mountProjectOpen({
      electron: { chooseProject },
      workspaces: { inspect, registerProject },
    } as unknown as Client);

    const first = subject.chooseProject();
    const second = subject.chooseProject();
    pickerResolvers[1]!("/second");
    await second;
    pickerResolvers[0]!("/first");
    await first;

    expect(inspect).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/second" }),
      expect.any(Object),
    );

    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("owns trusted inspection and accepts the Project only after authorization", async () => {
    const inspect = vi.fn(async (request: { operationId: string; path: string }) => ({
      ...request,
      trustRequired: true,
    }));
    const respondToTrust = vi.fn(async () => undefined);
    const registerProject = vi.fn(async () => undefined);
    const { root, subject, operations, onAccepted } = mountProjectOpen({
      workspaces: { inspect, respondToTrust, registerProject },
    } as unknown as Client);

    await subject.inspectPath("/work/cake");
    const operationId = inspect.mock.calls[0]![0].operationId;

    expect(subject.pendingTrustPath).toBe("/work/cake");
    expect(onAccepted).not.toHaveBeenCalled();

    await subject.resolveProjectTrust(true);

    expect(respondToTrust).toHaveBeenCalledWith({
      operationId,
      path: "/work/cake",
      approved: true,
    });
    expect(registerProject).toHaveBeenCalledWith("/work/cake", "cake", expect.any(Object));
    expect(onAccepted).toHaveBeenCalledWith({
      path: "/work/cake",
      kind: "project",
      sessionId: undefined,
    });

    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("declines an untrusted Project without registering or accepting it", async () => {
    const inspect = vi.fn(async (request: { operationId: string; path: string }) => ({
      ...request,
      trustRequired: true,
    }));
    const respondToTrust = vi.fn(async () => undefined);
    const registerProject = vi.fn(async () => undefined);
    const { root, subject, operations, onAccepted } = mountProjectOpen({
      workspaces: { inspect, respondToTrust, registerProject },
    } as unknown as Client);

    await subject.inspectPath("/untrusted");
    await subject.resolveProjectTrust(false);

    expect(respondToTrust).toHaveBeenCalledWith(expect.objectContaining({ approved: false }));
    expect(registerProject).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
    expect(subject.pendingTrustPath).toBeUndefined();

    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("ignores inspection and registration results superseded by a later open", async () => {
    const inspectionResolvers: Array<() => void> = [];
    const inspect = vi.fn(
      (request: { operationId: string; path: string }) =>
        new Promise<{ operationId: string; path: string; trustRequired: boolean }>((resolve) => {
          inspectionResolvers.push(() => resolve({ ...request, trustRequired: false }));
        }),
    );
    let finishRegistration: (() => void) | undefined;
    const registerProject = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRegistration = resolve;
        }),
    );
    const { root, subject, operations, onAccepted } = mountProjectOpen({
      workspaces: { inspect, registerProject },
    } as unknown as Client);

    const first = subject.inspectPath("/first");
    const second = subject.inspectPath("/second");

    inspectionResolvers[0]!();
    await first;
    expect(registerProject).not.toHaveBeenCalled();

    inspectionResolvers[1]!();
    await flush();
    expect(registerProject).toHaveBeenCalledWith("/second", "second", expect.any(Object));

    void subject.inspectPath("/third");
    finishRegistration?.();
    await second;

    expect(onAccepted).not.toHaveBeenCalled();
    expect(subject.pendingAuthorizationPath).toBe("/third");

    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("cancels a pending inspection and rejects its late result", async () => {
    let finishInspection: (() => void) | undefined;
    const inspect = vi.fn(
      (request: { operationId: string; path: string }) =>
        new Promise<{ operationId: string; path: string; trustRequired: boolean }>((resolve) => {
          finishInspection = () => resolve({ ...request, trustRequired: false });
        }),
    );
    const registerProject = vi.fn(async () => undefined);
    const { root, subject, operations, onAccepted } = mountProjectOpen({
      workspaces: { inspect, registerProject },
    } as unknown as Client);

    const opening = subject.inspectPath("/cancelled");
    subject.cancelPending();
    finishInspection?.();
    await opening;

    expect(subject.isBusy).toBe(false);
    expect(registerProject).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();

    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("initializes persisted Project-open state and retains new-session intent", async () => {
    const inspect = vi.fn(async (request: { operationId: string; path: string }) => ({
      ...request,
      trustRequired: false,
    }));
    const registerProject = vi.fn(async () => undefined);
    const { root, subject, operations, onAccepted } = mountProjectOpen({
      workspaces: { inspect, registerProject },
    } as unknown as Client);

    await subject.initialize({
      path: "/restored",
      newSession: true,
      sessionId: "staged-1",
      stagedSession: true,
    });

    expect(subject.projectPath).toBe("/restored");
    expect(toSnapshot(subject).state).toEqual({ projectPath: "/restored" });
    expect(onAccepted).toHaveBeenCalledWith({
      path: "/restored",
      kind: "new-session",
      sessionId: "staged-1",
      stagedSession: true,
    });

    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });
});

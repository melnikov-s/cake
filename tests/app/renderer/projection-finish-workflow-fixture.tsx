import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import type {
  WorkflowRun,
  WorkflowWorkerActivity,
} from "../../../src/contracts/workflows/workflow-data";
import { workflowSummary } from "../../../src/contracts/workflows/workflow-projection";
import type { Client } from "../../../src/renderer/client/Client";
import { WorkflowConversationLayout } from "../../../src/renderer/components/workflow-conversation-layout";
import { WorkflowProgress } from "../../../src/renderer/components/workflow-progress";
import {
  applyWorkflowCatalogUpdate,
  applyWorkflowRunUpdate,
} from "../../../src/renderer/reducers/WorkflowReducer";
import { workflowRunFixture } from "../../fixtures/dynamic-workflow";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

/** Projection delivery stands for the external authority; all inspection/control Stores are real. */
export function renderProjectionFinishRun(replayDelivery: "Snapshot" | "RunChanged") {
  let run = workflowRunFixture({ status: "complete" });
  let revision = 1;
  const relaunch = vi.fn<Client["workflows"]["relaunch"]>(async () => {
    run = {
      ...workflowRunFixture(),
      execution: 2,
      steps: workflowRunFixture().steps.map((step) => ({
        ...step,
        execution: 2,
        attempt: 1,
      })),
    };
    publishRun();
    return {
      sessionId: run.ownerSessionId,
      runId: run.id,
      name: run.program.meta.name,
      status: run.status,
    };
  });
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project" })],
    sessions: [sessionSummary({ sessionId: run.ownerSessionId, projectPath: "/project" })],
    client: { workflows: { relaunch } },
  });
  const session = fixture.root.sessionRegistry.load(run.ownerSessionId, "/project");
  const catalog = fixture.models.workflowCatalog(run.ownerSessionId);
  applyWorkflowCatalogUpdate(catalog, {
    _tag: "Snapshot",
    revision,
    ownerSessionId: run.ownerSessionId,
    runs: [workflowSummary(run)],
  });
  function detail() {
    const model = catalog.details.find((candidate) => candidate.id === run.id);
    if (!model) throw new Error("Open Details before delivering the demanded payload");
    return model;
  }
  function publishRun() {
    revision += 1;
    applyWorkflowCatalogUpdate(catalog, {
      _tag: "RunChanged",
      revision,
      run: workflowSummary(run),
    });
    // A live observer receives RunChanged; reconnecting observers receive Snapshot.
    applyWorkflowRunUpdate(detail(), { _tag: replayDelivery, revision, run });
  }
  const stores = session.workflowRunStores;
  const view = render(
    <WorkflowConversationLayout stores={stores}>
      <WorkflowProgress store={session.workflowRunStore} />
    </WorkflowConversationLayout>,
  );
  return {
    user: userEvent.setup(),
    relaunch,
    deliverDetails() {
      act(() => applyWorkflowRunUpdate(detail(), { _tag: "Snapshot", revision, run }));
    },
    activity(activity: WorkflowWorkerActivity) {
      act(() =>
        applyWorkflowRunUpdate(detail(), {
          _tag: "WorkerActivity",
          revision: ++revision,
          activity,
        }),
      );
    },
    staleRun() {
      act(() =>
        applyWorkflowRunUpdate(detail(), {
          _tag: "RunChanged",
          revision: 1,
          run: workflowRunFixture({ status: "complete" }),
        }),
      );
    },
    get run(): WorkflowRun {
      return run;
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

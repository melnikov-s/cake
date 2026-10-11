import { Stream } from "effect";
import * as workflows from "../../domain/workflows/workflows";
import { DynamicWorkflowRpc } from "../protocol/DynamicWorkflowRpc";

export const dynamicWorkflowHandlers = DynamicWorkflowRpc.of({
  "workflows.start": (input) => workflows.start(input),
  "workflows.list": (input) => workflows.list(input),
  "workflows.inspect": (input) => workflows.inspect(input),
  "workflows.observe": (input) => Stream.unwrap(workflows.observe(input)),
  "workflows.observeRun": (input) => Stream.unwrap(workflows.observeRun(input)),
  "workflows.pause": (input) => workflows.pause(input),
  "workflows.resume": (input) => workflows.resume(input),
  "workflows.stop": (input) => workflows.stop(input),
  "workflows.relaunch": (input) => workflows.relaunch(input),
  "workflows.stopWorker": (input) => workflows.stopWorker(input),
  "workflows.restartWorker": (input) => workflows.restartWorker(input),
  "workflows.inspectWorker": (input) => workflows.inspectWorker(input),
  "workflows.saved": (input) => workflows.saved(input),
  "workflows.save": (input) => workflows.save(input),
});

import { workerCommandSchema, type WorkerEvent } from "@cake/protocol";

function emit(event: WorkerEvent) {
  process.parentPort?.postMessage(event);
}

process.parentPort?.on("message", (event) => {
  const result = workerCommandSchema.safeParse(event.data);
  if (!result.success) return;
  const command = result.data;

  if (command.type === "shutdown") {
    process.exit(0);
    return;
  }

  const { requestId } = command;
  const words = ["Worker", " boundary", " is", " alive."];
  words.forEach((text, index) => {
    setTimeout(() => emit({ type: "text-delta", requestId, text }), index * 90);
  });
  setTimeout(() => emit({ type: "complete", requestId }), words.length * 90);
});

emit({ type: "ready" });

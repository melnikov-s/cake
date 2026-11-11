import type { CakeOperationRegistry } from "../pi/runtime/cake-operation-registry";

/** Curate common options, never copy their schemas or advertise unregistered controls. */
export function coreChatOperations(operations: CakeOperationRegistry): string {
  const lines: string[] = [];
  const add = (command: string, common: readonly string[] = [], expand: readonly string[] = []) => {
    const reference = operations.operationReference(command, common, expand);
    if (reference) lines.push(reference);
    return Boolean(reference);
  };
  add("sessions.create", ["worktreeName", "model", "resultDelivery", "todoId"]);
  if (add("sessions.fork", ["resultDelivery", "todoId"]))
    lines.push("Fork: include unfinished-exchange specifics in initialPrompt.");
  add("todos.list", ["state", "query", "limit", "offset"]);
  add("todos.read");
  add("todos.create", ["associations"], ["associations"]);
  if (
    add("todos.update", [
      "title",
      "description",
      "status",
      "remainingWork",
      "state",
      "associations",
      "needsAttention",
      "attentionReason",
    ])
  )
    lines.push(
      "Standalone completion/reopening: state done/open. remainingWork holds closure; null clears satisfied handoffs. Revision conflict: reread before retrying.",
    );
  if (add("sessions.send", ["delivery", "resultDelivery"]))
    lines.push(
      "delivery: steer corrects active work; prompt assigns now; queue orders future work; fyi is passive. Omission steers active/starts idle. resultDelivery controls the return, not outbound delivery; fyi cannot request reply or forward attachments. Receipt is intake, not execution.",
    );
  add("sessions.abort", ["reason"]);
  if (add("sessions.set-model"))
    lines.push(
      "Idle: set only. Active: stop, join cleanup, set, Continue once. Self: accepted is not success; verify sessions.model-switch-status. Never send a second Continue.",
    );
  if (add("sessions.tool-prune"))
    lines.push(
      "Only when asked: tool prune deterministically strips tool calls/results, preserves dialogue, and makes no model call. sessions.compact/compact-batch generate model summaries; never substitute them for tool prune.",
    );
  add("worktrees.merge-and-resolve");
  if (add("worktrees.merge"))
    lines.push(
      "Owner sessionId; never manual Git landing. Inspect outcome/nextStep; merge-only: merging never resolves.",
    );
  if (add("sessions.resolve", [], ["targets"]))
    lines.push(
      "Resolve only when authorized and the outcome is satisfied; resolved:true resolves, resolved:false restores. Execution/report arrival is not resolution.",
    );
  if (add("messages.read", ["offset", "maxChars"]))
    lines.push(
      'Known report ref: read directly; page with nextOffset as offset. Link the exact original as "Full agent response", not reminders/private Pi IDs. Reports are evidence, not verified success.',
    );
  if (add("widgets.attach"))
    lines.push(
      "Attach an existing widget instance: targets are global, project-chats, project-sessions, or one session. Slots: top/bottom/left/right, or tab (target global only) for a full Workspace pane selected beside To-dos/Sessions. Tab widgets remain active independently of selection. Moving keeps identity/state; duplication uses widgets.instantiate.",
    );
  add("widgets.detach");
  add("widgets.attachments");
  return lines.length
    ? [
        "## Core chat operations",
        "Use directly: cake({command,input}). Calling sketches: ? = optional; other keys required. Exact returned IDs/revisions only. Advanced options/specialists stay behind help.",
        ...lines,
      ].join("\n")
    : "";
}

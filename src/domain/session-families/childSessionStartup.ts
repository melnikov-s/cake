import operatingBasics from "../../../docs/agent/family-startup.md?raw";
import template from "./prompts/child-startup.md?raw";
import type {
  BoardAppendInput,
  BoardCurrentInput,
  BoardReadInput,
} from "../../contracts/artifacts/message-board";
import {
  resultDeliveryBehavior,
  type ResultDelivery,
} from "../../contracts/conversations/result-delivery";
import type { ChildSessionAssignment } from "../../contracts/project-sessions/child-session-assignment";
import { renderProjectSessionPrompt } from "../project-sessions/projectSessionPromptTemplate";

type WorkboardCall =
  | { readonly command: "boards.current"; readonly input: BoardCurrentInput }
  | { readonly command: "boards.read"; readonly input: typeof BoardReadInput.Type }
  | { readonly command: "boards.append"; readonly input: BoardAppendInput };

interface ChildSessionStartup {
  readonly familyId: string;
  readonly childSessionId: string;
  readonly parentSessionId: string;
  readonly rootSessionId: string;
  readonly workingDirectory: string;
  readonly resultDelivery: ResultDelivery;
  readonly assignmentReceipt: { readonly boardId: string; readonly sequence: number };
  readonly assignmentTopic: string;
  readonly assignment: ChildSessionAssignment;
}

/** Render one initial handoff. Stable canonical public refs need no global discovery. */
export function childSessionStartup(input: ChildSessionStartup): string {
  const sequence = input.assignmentReceipt.sequence;
  // Subsequent coordination must not reuse the application-owned assignment topic.
  const topic = `result-${input.childSessionId}`;
  const addressed = { audience: [input.parentSessionId], topic };
  const current = {} satisfies BoardCurrentInput;
  const read = { sequences: [sequence] } satisfies typeof BoardReadInput.Type;
  const completion = {
    ...addressed,
    event: "completion",
    resultKind: "ready",
    description: `Result for assignment #${sequence}`,
    body: `Assignment #${sequence}: <actual outcome, commit, verification/limits, contract changes and integration action>`,
  } satisfies BoardAppendInput;
  const question = {
    ...addressed,
    description: `Question about assignment #${sequence}`,
    body: `Assignment #${sequence}: <question and context; use the blocker call instead if progress depends on the answer>`,
  } satisfies BoardAppendInput;
  const blocker = {
    ...addressed,
    event: "blocker",
    description: `Blocked on assignment #${sequence}`,
    body: `Assignment #${sequence}: <actual blocker, evidence and decision needed from the parent>`,
  } satisfies BoardAppendInput;
  const call = (request: WorkboardCall) => `\`${JSON.stringify(request)}\``;
  const workboardCalls = [
    `Live current context: ${call({ command: "boards.current", input: current })}. This returns current descriptions, not bodies or proof of agreement.`,
    `Read the known assignment original if needed: ${call({ command: "boards.read", input: read })}. For later relevant bodies, replace sequences with the actual returned sequence numbers (at most ten per call).`,
    `Completion: ${call({ command: "boards.append", input: completion })}. For research set resultKind to investigation; do not invent implementation success.`,
    `Nonblocking question (passive): ${call({ command: "boards.append", input: question })}.`,
    `Blocking question or failure: ${call({ command: "boards.append", input: blocker })}.`,
  ].join("\n\n");

  const instructions = renderProjectSessionPrompt(template, {
    familyId: input.familyId,
    childSessionId: input.childSessionId,
    parentSessionId: input.parentSessionId,
    rootSessionId: input.rootSessionId,
    workingDirectory: input.workingDirectory,
    operatingBasics: operatingBasics.trim(),
    workboardCalls,
    resultDelivery: input.resultDelivery,
    resultBehavior: resultDeliveryBehavior[input.resultDelivery],
    boardId: input.assignmentReceipt.boardId,
    assignmentSequence: String(sequence),
    assignmentTopic: input.assignmentTopic,
  });
  // Preserve the exact inline assignment, including trailing whitespace and template-like text.
  return [instructions, `Description: ${input.assignment.description}`, input.assignment.body].join(
    "\n\n",
  );
}

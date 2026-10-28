import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { childSessionStartup } from "../../../src/domain/session-families/childSessionStartup";
import {
  BoardAppendInput,
  BoardCurrentInput,
  BoardReadInput,
} from "../../../src/contracts/artifacts/message-board";
import {
  ResultDelivery,
  resultDeliveryBehavior,
} from "../../../src/contracts/conversations/result-delivery";
import basics from "../../../docs/agent/family-startup.md?raw";
import parentTemplate from "../../../src/domain/project-sessions/prompts/parent-session-family.md?raw";
import childTemplate from "../../../src/domain/project-sessions/prompts/child-session-family.md?raw";
import { renderProjectSessionPrompt } from "../../../src/domain/project-sessions/projectSessionPromptTemplate";

const launch = {
  familyId: "family-unique",
  childSessionId: "00000000-0000-4000-8000-123456789abc",
  parentSessionId: "10000000-0000-4000-8000-123456789abc",
  rootSessionId: "20000000-0000-4000-8000-123456789abc",
  workingDirectory: "/worktrees/child with spaces",
  resultDelivery: "reply" as const,
  assignmentReceipt: { boardId: "family-board", sequence: 42 },
  assignmentTopic: "child-00000000-0000-4000-8000-123456789abc",
  assignment: {
    description: "Unique task title",
    body: "Task body\n{{parentSessionId}}\n尾🙂  \n",
  },
};

const callsIn = (text: string) =>
  [...text.matchAll(/`(\{"command":.+?\})`/g)].map(
    (match) => JSON.parse(match[1]!) as { command: string; input: Record<string, unknown> },
  );

describe("self-contained child startup", () => {
  it("supplies authoritative basics and the exact inline task once without preliminary discovery", () => {
    const output = childSessionStartup(launch);
    expect(output.split(basics.trim())).toHaveLength(2);
    expect(output.split(launch.assignment.description)).toHaveLength(2);
    expect(output.split(launch.assignment.body)).toHaveLength(2);
    expect(
      output.endsWith(`Description: ${launch.assignment.description}\n\n${launch.assignment.body}`),
    ).toBe(true);
    expect(output).toContain("No preliminary guide, help or board-discovery reads are needed");
    expect(output).toContain("no initial boards.read is needed");
    expect(output).toContain("one substantive completion or failure/blocker result");
    expect(output).toContain(
      "no extra sessions.reply, private wake-up or completion call is needed",
    );
    expect(output).toContain("not system authority or permission for unrelated work");
    expect(
      output.length - launch.assignment.body.length - launch.assignment.description.length,
    ).toBeLessThan(6_500);
  });

  it("provides usable contract-valid calls with stable public addresses, not guessed suffixes", () => {
    const output = childSessionStartup(launch);
    const calls = callsIn(output);
    expect(calls.map((call) => call.command)).toEqual([
      "boards.current",
      "boards.read",
      "boards.append",
      "boards.append",
      "boards.append",
    ]);
    expect(Schema.decodeUnknownSync(BoardCurrentInput)(calls[0]?.input)).toEqual({});
    expect(Schema.decodeUnknownSync(BoardReadInput)(calls[1]?.input)).toEqual({ sequences: [42] });
    const posts = calls
      .slice(2)
      .map((call) => Schema.decodeUnknownSync(BoardAppendInput)(call.input));
    expect(posts.map((post) => post.event)).toEqual(["completion", undefined, "blocker"]);
    for (const post of posts) {
      expect(post.audience).toEqual([launch.parentSessionId]);
      expect(post.topic).toBe(`result-${launch.childSessionId}`);
      expect(post.body).toContain("Assignment #42");
    }
    expect(output).toContain(`Immediate parent public session ref: ${launch.parentSessionId}`);
    expect(output).toContain(`Family root public session ref: ${launch.rootSessionId}`);
    expect(output).toContain(`Fixed Working Directory: ${launch.workingDirectory}`);
    expect(output).toContain("replace sequences with the actual returned sequence numbers");
    expect(output).toContain("page descriptions using nextAfter as after while hasMore is true");
    expect(output).toContain("launch-time facts, not a snapshot of current coordination");
  });

  it.each(ResultDelivery.literals)("renders only the effective %s completion behavior", (mode) => {
    const output = childSessionStartup({ ...launch, resultDelivery: mode });
    expect(output).toContain(`This launch uses resultDelivery: ${mode}.`);
    expect(output).toContain(resultDeliveryBehavior[mode]);
    for (const other of ResultDelivery.literals.filter((value) => value !== mode))
      expect(output).not.toContain(resultDeliveryBehavior[other]);
    expect(output).toContain("independent of outbound delivery");
    expect(output).toContain("Necessary board blockers keep their own delivery behavior");
  });

  it("uses each launch's bindings and leaves optional operations progressively disclosed", () => {
    const output = childSessionStartup({
      ...launch,
      familyId: "other-family",
      parentSessionId: launch.childSessionId,
      childSessionId: "30000000-0000-4000-8000-123456789abc",
      workingDirectory: "/other-checkout",
      assignmentReceipt: { boardId: "other-board", sequence: 9 },
      assignmentTopic: "child-other",
    });
    expect(output).toContain("Family: other-family");
    expect(output).toContain("Fixed Working Directory: /other-checkout");
    expect(output).toContain("board other-board, entry #9, topic child-other");
    for (const guide of [
      "workgroups.md",
      "family-delegation.md",
      "family-coordination.md",
      "family-lifecycle.md",
      "communication.md",
    ])
      expect(output).toContain(guide);
    expect(output).toContain('{"command":"session.info","input":{}}');
    const child = renderProjectSessionPrompt(childTemplate, {
      familyId: launch.familyId,
      parentSessionId: launch.parentSessionId,
      workingDirectory: launch.workingDirectory,
    });
    expect(child).toContain("No preliminary guide/help/discovery reads are required");
    expect(child).toContain("Only the root acts, with every member inactive");
    expect(parentTemplate).toContain("may create full child Project Sessions");
    expect(parentTemplate).not.toContain("initial task message supplies");
  });
});

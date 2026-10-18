import assert from "node:assert/strict";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { discoveryResultText } from "../../../src/contracts/agent/discovery-result-text";
import {
  MessageListResult,
  messageReference,
  attachmentLink,
} from "../../../src/contracts/conversations/message-reference";
import { projectSessionReferences } from "../../../src/contracts/project-sessions/session-reference";
import type { JsonValue, JsonObject } from "../../../src/contracts/serialization/json-contract";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";

const root = "11111111-1111-4111-8111-000000000001";
const child = "11111111-1111-4111-8111-000000000002";
const inputId = "11111111-1111-4111-8111-000000000003";
const context = { signal: new AbortController().signal, toolCallId: "discovery", runtime: {} };
const page = { total: 1, offset: 0, nextOffset: null };
const input = {
  kind: "input",
  id: inputId,
  name: "screen.png",
  mimeType: "image/png",
  byteLength: 512,
};
const source = {
  kind: "subagent",
  sessionId: child,
  handleId: "worker-7",
  status: "done",
  task: "Investigate cache",
};
const familyResult: JsonObject = {
  total: 2,
  offset: 0,
  nextOffset: null,
  familyId: "family-1",
  rootSessionId: root,
  currentSessionId: child,
  sessions: [
    { sessionId: root, status: "idle", title: "Coordinator" },
    { sessionId: child, familyParentSessionId: root, status: "done", title: "Investigator" },
  ],
};
const ref = messageReference(root, "entry-1");
const message = {
  ref,
  link: ref,
  sessionId: root,
  entryId: "entry-1",
  parentId: null,
  timestamp: "2026-01-01T12:00:00Z",
  role: "user",
  active: true,
  hasImages: true,
  inputRefs: [input],
};

const cases: { command: string; value: JsonValue; text: string }[] = [
  {
    command: "projects.list",
    value: { ...page, projects: [{ path: "/project", name: "My App" }] },
    text: "1 projects\npath\tname\n/project\tMy App",
  },
  {
    command: "sessions.list-family",
    value: familyResult,
    text: `2 members\nfamily=family-1 root=${root} caller=${child}\nid\tparent\tstatus\ttitle\n${root}\t-\tidle\tCoordinator\n${child}\t${root}\tdone\tInvestigator`,
  },
  {
    command: "sessions.reports",
    value: { ...page, items: [{ id: "report-1", state: "pending", admissions: 2, source }] },
    text: `1 pending reports\nid\tadmissions\tsession\thandle\tstatus\ttask\nreport-1\t2\t${child}\tworker-7\tdone\tInvestigate cache`,
  },
  {
    command: "models.list",
    value: { ...page, presets: [{ name: "Sol", default: true }] },
    text: "1 presets\ndefault\tname\n1\tSol",
  },
  {
    command: "attachments.list",
    value: {
      references: [{ ...input, reference: inputId, deepLink: attachmentLink(root, inputId) }],
      nextAfter: null,
    },
    text: `1 attachments (page)\nreference\tmime\tbytes\tname\tlink\n${inputId}\timage/png\t512\tscreen.png\t${attachmentLink(root, inputId)}`,
  },
  {
    command: "messages.list",
    value: { ...page, sessionId: root, branch: "all", messages: [message] },
    text: `1 messages; branch=all\nrole\tactive\timages\ttimestamp\tref\ninput rows: id\tmime\tbytes\tname (belong to preceding message)\nuser\t1\t1\t2026-01-01T12:00:00Z\t${ref}\ninput\t${inputId}\timage/png\t512\tscreen.png`,
  },
];

function registry(command: string, value: JsonValue, typed = false) {
  return new CakeOperationRegistry([
    {
      command,
      topic: command.slice(0, command.indexOf(".")),
      summary: "Discovery",
      inputSchema: Schema.Struct({}),
      ...(typed ? { outputSchema: MessageListResult } : {}),
      examples: [],
      result: "Metadata",
      execute: async () => value,
    },
  ]);
}

describe("compact discovery presentation", () => {
  it.each(cases)(
    "formats $command only in model-facing text, preserving result data",
    async ({ command, value, text }) => {
      const typed = command === "messages.list";
      const actual = await registry(command, value, typed).invoke({ command }, context);
      expect(actual.text).toBe(text);
      expect(actual.content).toEqual([{ type: "text", text }]);
      expect(actual.details).toEqual({ protocol: "cake.operation/v1", command, result: value });
      expect(actual.structuredContent).toEqual(typed ? { command, result: value } : text);
    },
  );

  it("uses projected references in text while retaining UUID-constrained typed results", async () => {
    const uuid = Schema.String.check(Schema.isUUID(4));
    const outputSchema = Schema.Struct({
      total: Schema.Int,
      offset: Schema.Int,
      nextOffset: Schema.NullOr(Schema.Int),
      familyId: Schema.String,
      rootSessionId: uuid,
      currentSessionId: uuid,
      sessions: Schema.Array(
        Schema.Struct({
          sessionId: uuid,
          familyParentSessionId: Schema.optionalKey(uuid),
          status: Schema.String,
          title: Schema.String,
        }),
      ),
    });
    const available = new CakeOperationRegistry(
      [
        {
          command: "sessions.list-family",
          topic: "sessions",
          summary: "Family",
          inputSchema: Schema.Struct({}),
          outputSchema,
          examples: [],
          result: "Family metadata",
          execute: async () => familyResult,
        },
      ],
      async (value) => projectSessionReferences(value, [root, child]),
    );
    const result = await available.invoke({ command: "sessions.list-family" }, context);
    expect(result.text).toBe(
      "2 members\nfamily=family-1 root=00000001 caller=00000002\nid\tparent\tstatus\ttitle\n00000001\t-\tidle\tCoordinator\n00000002\t00000001\tdone\tInvestigator",
    );
    expect(result.structuredContent).toEqual({
      command: "sessions.list-family",
      result: familyResult,
    });
    expect(result.details).toMatchObject({ result: familyResult });
  });

  it("keeps continuation tokens exact and distinguishes a cursor page count from a total", () => {
    expect(
      discoveryResultText("models.list", {
        total: 61,
        offset: 20,
        nextOffset: 40,
        presets: [{ name: "Fast", default: false }],
      }),
    ).toBe("61 presets; next=40\ndefault\tname\n0\tFast");
    expect(discoveryResultText("attachments.list", { references: [], nextAfter: inputId })).toBe(
      `0 attachments (page); after=${inputId}`,
    );
    expect(
      discoveryResultText("messages.list", {
        ...page,
        total: 100,
        nextOffset: 25,
        sessionId: root,
        branch: "active",
        messages: [],
      }),
    ).toBe("100 messages; next=25; branch=active");
  });

  it.each([
    ["projects.list", { ...page, total: 0, projects: [] }, "0 projects"],
    [
      "sessions.list-family",
      { ...familyResult, total: 0, sessions: [] },
      `0 members\nfamily=family-1 root=${root} caller=${child}`,
    ],
    ["sessions.reports", { ...page, total: 0, items: [] }, "0 pending reports"],
    ["models.list", { ...page, total: 0, presets: [] }, "0 presets"],
    ["attachments.list", { references: [], nextAfter: null }, "0 attachments (page)"],
    [
      "messages.list",
      { ...page, total: 0, sessionId: root, branch: "active", messages: [] },
      "0 messages; branch=active",
    ],
  ] satisfies [string, JsonValue, string][])(
    "renders empty %s pages without a redundant header",
    (command, value, text) => {
      expect(discoveryResultText(command, value)).toBe(text);
    },
  );

  it("losslessly quotes multiline cells, paths, literal dashes and unusual punctuation", () => {
    const path = '/project\twith\n"quotes"\\backslash';
    const name = "Comma, pipe | and\r\nnewline";
    const text = discoveryResultText("projects.list", { ...page, projects: [{ path, name }] });
    expect(text).toBe(`1 projects\npath\tname\n${JSON.stringify(path)}\t${JSON.stringify(name)}`);
    assert.ok(text);
    const [, , line] = text.split("\n");
    assert.ok(line);
    const cells = line.split("\t").map((value) => JSON.parse(value));
    expect(cells).toEqual([path, name]);
    expect(
      discoveryResultText("models.list", { ...page, presets: [{ name: "-", default: false }] }),
    ).toContain('0\t"-"');
  });

  it("accepts report provenance redacted by the coordinator without reconstructing private metadata", () => {
    expect(
      discoveryResultText("sessions.reports", {
        ...page,
        items: [
          {
            id: "report-1",
            admissions: 0,
            source: { sessionId: "00000002", title: "Task session" },
          },
        ],
      }),
    ).toBe(
      "1 pending reports\nid\tadmissions\tsession\thandle\tstatus\ttask\nreport-1\t0\t00000002\t-\t-\tTask session",
    );
    expect(
      discoveryResultText("sessions.reports", {
        ...page,
        items: [{ id: "report-1", admissions: 0 }],
      }),
    ).toContain("report-1\t0\t-\t-\t-\t-");
  });

  it("leaves error and detail results in their existing JSON presentation", async () => {
    for (const command of ["projects.list", "models.info", "sessions.reports.read"]) {
      const value: JsonValue =
        command === "projects.list"
          ? { ok: false, error: "No access" }
          : { text: "Exact detail\nsecond line" };
      const result = await registry(command, value).invoke({ command }, context);
      expect(result.text).toBe(JSON.stringify(value, null, 2));
      expect(result.details).toMatchObject({ result: value });
    }
  });

  it("rejects malformed discovery data rather than silently presenting an incomplete roster", async () => {
    await expect(
      registry("projects.list", { projects: [{ name: "Missing path" }] }).invoke(
        { command: "projects.list" },
        context,
      ),
    ).rejects.toThrow();
  });

  it("keeps oversized catalog pages in a valid truncation envelope rather than cutting routing rows", async () => {
    const value = {
      total: 7,
      offset: 0,
      nextOffset: null,
      projects: Array.from({ length: 7 }, (_, index) => ({
        path: "/" + String(index) + "x".repeat(4000),
        name: "Long checkout path",
      })),
    };
    const result = await registry("projects.list", value).invoke(
      { command: "projects.list" },
      context,
    );
    expect(JSON.parse(result.text)).toMatchObject({
      truncated: true,
      guidance: expect.stringContaining("Narrow the query"),
    });
    expect(result.details).toMatchObject({ result: value });
  });

  it("cuts repeated-record overhead across representative pages", () => {
    for (const { command, value } of cases) {
      const text = discoveryResultText(command, value);
      assert.ok(text);
      expect(text.length, command).toBeLessThan(JSON.stringify(value).length * 0.9);
    }
  });
});

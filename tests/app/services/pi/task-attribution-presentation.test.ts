import { expect, it } from "vitest";
import { visibleTaskAttributionContent } from "../../../../src/services/pi/runtime/task-attribution-presentation";
import { partsFromMessage } from "../../../../src/services/pi/runtime/message-projection";
import { durableAnswer } from "../../../fixtures/durable-chat";

const payload = {
  turnId: "00000000-0000-4000-8000-000000000001",
  todoId: null,
  newTopic: true,
};
const tag = (json = JSON.stringify(payload)) => `<cake-todo>${json}</cake-todo>`;
const blocks = (...texts: string[]) => texts.map((text) => ({ type: "text" as const, text }));
const textOf = (content: ReturnType<typeof blocks>) => content.map((block) => block.text).join("");
const visible = (text: string) => textOf(visibleTaskAttributionContent(blocks(text)));

it.each([JSON.stringify(payload), JSON.stringify(payload, null, 2)])(
  "withholds every streamed prefix across every two-block split (%s)",
  (json) => {
    const prefix = tag(json);
    const wire = prefix + "Answer";
    for (let split = 0; split <= wire.length; split += 1) {
      for (let length = 0; length <= wire.length; length += 1) {
        const raw = wire.slice(0, length);
        const content = blocks(raw.slice(0, split), raw.slice(split));
        const original = structuredClone(content);
        expect(
          textOf(visibleTaskAttributionContent(content, true)),
          `split=${split}, length=${length}`,
        ).toBe(wire.slice(prefix.length, length));
        expect(content).toEqual(original);
      }
    }
  },
);

it("removes consecutive and trailing envelopes while retaining block indices and signatures", () => {
  const source = blocks("Before" + tag().slice(0, 4), tag().slice(4) + tag() + "After");
  const content = source.map((block, i) => ({ ...block, textSignature: `signature-${i}` }));
  expect(visibleTaskAttributionContent(content)).toEqual([
    { ...content[0], text: "Before" },
    { ...content[1], text: "After" },
  ]);
});

it.each([
  '{"turnId":"not internal","todoId":null}',
  "```json\n" + JSON.stringify(payload) + "\n```",
  "`" + tag() + "`",
  "``" + tag() + "``",
  "```xml\n" + tag() + "\n```",
  "~~~xml\n" + tag() + "\n~~~",
  "\\" + tag(),
  "Ordinary prose after a <comparison",
  "Comparison: a <",
  JSON.stringify({ example: tag() }),
  '"' + tag() + '"',
])("preserves legitimate assistant JSON and code exactly (%s)", (text) => {
  for (let split = 0; split <= text.length; split += 1)
    expect(
      textOf(visibleTaskAttributionContent(blocks(text.slice(0, split), text.slice(split)))),
    ).toBe(text);
});

it.each([
  ['<cake-todo>{"turnId":', ""],
  ['<cake-todo>{"turnId":\nFollowing prose', "\nFollowing prose"],
  ['<cake-todo>{"turnId":"unterminated\nFollowing prose', "\nFollowing prose"],
  ['<cake-todo>{"turnId":oops}Following prose', "oops}Following prose"],
  ["<cake-todo>Following prose", "Following prose"],
  ["<cake-todo>" + JSON.stringify(payload) + "Following prose", "Following prose"],
  ["<cake-todo>{broken}</cake-todo>Following prose", "Following prose"],
  ['<cake-todo>{"turnId":</cake-todo>Following prose', "Following prose"],
])(
  "bounds malformed/incomplete metadata instead of swallowing following prose (%s)",
  (text, expected) => {
    expect(visible(text)).toBe(expected);
  },
);

it("filters complete envelopes split around reasoning/tool blocks without removing those blocks", () => {
  const reasoning = { type: "thinking", thinking: "Reasoning" };
  const tool = { type: "toolCall", id: "call", name: "read", arguments: {} };
  const prefix = tag();
  for (let split = 0; split <= prefix.length; split += 1) {
    for (const boundary of [reasoning, tool]) {
      const content = [
        ...blocks(prefix.slice(0, split)),
        boundary,
        ...blocks(prefix.slice(split) + "Answer"),
      ];
      expect(visibleTaskAttributionContent(content)).toEqual([
        ...blocks(""),
        boundary,
        ...blocks("Answer"),
      ]);
    }
  }
});

it("does not carry incomplete metadata across a reasoning/tool boundary or across messages", () => {
  const reasoning = { type: "thinking", thinking: "Reasoning" };
  const tool = { type: "toolCall", id: "call", name: "read", arguments: {} };
  const content = [
    ...blocks('<cake-todo>{"turnId":'),
    reasoning,
    ...blocks('Following prose {"keep":true}'),
    tool,
    ...blocks("More prose"),
  ];
  const result = visibleTaskAttributionContent(content);
  expect(result).toEqual([
    ...blocks(""),
    reasoning,
    ...blocks('Following prose {"keep":true}'),
    tool,
    ...blocks("More prose"),
  ]);
  expect(result[1]).toBe(reasoning);
  expect(result[3]).toBe(tool);
  expect(
    visibleTaskAttributionContent([...blocks("<cake-todo>"), tool, ...blocks('{"keep":true}')]),
  ).toEqual([...blocks(""), tool, ...blocks('{"keep":true}')]);
  expect(visible('Following prose {"keep":true}')).toBe('Following prose {"keep":true}');
});

it.each([false, true])(
  "projects raw live/persisted assistant blocks without leaking metadata (streaming=%s)",
  (streaming) => {
    const message = durableAnswer(
      "",
      blocks(tag().slice(0, 5), tag().slice(5), 'Answer {"keep":true}'),
    );
    const parts = partsFromMessage(message, "raw", streaming);
    expect(parts.filter((part) => part.kind === "text")).toMatchObject([
      { text: 'Answer {"keep":true}', status: streaming ? "streaming" : "complete" },
    ]);
    expect(message.content).toEqual(
      blocks(tag().slice(0, 5), tag().slice(5), 'Answer {"keep":true}'),
    );
  },
);

it("never filters user metadata/JSON examples", () => {
  const text = tag() + '\n{"todoId":null}';
  expect(partsFromMessage({ role: "user", content: text }, "user")).toMatchObject([{ text }]);
});

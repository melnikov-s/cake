import { describe, expect, it } from "vitest";
import {
  appendMessageReferences,
  messageReferencesInText,
} from "../../../src/contracts/conversations/message-reference-forwarding";

const ref = "cake://session/5ea17950-f960-4fc3-a743-877328f40a85?message=967e6fa3";

describe("message references in prose", () => {
  it.each([".", ",", ";", ":", "!", "?", "...", ";."])(
    "excludes trailing sentence punctuation (%s)",
    (punctuation) => {
      expect(messageReferencesInText(`Read ${ref}${punctuation} Then continue.`)).toEqual([ref]);
    },
  );

  it.each([ref, `[Original](${ref})`, `<${ref}>`])(
    "preserves a reference without sentence punctuation (%s)",
    (text) => {
      expect(messageReferencesInText(text)).toEqual([ref]);
    },
  );

  it("preserves encoded session and entry identities", () => {
    const encoded = "cake://session/project-chat%3Aabc?message=entry%3Aone%2E%3B";
    expect(messageReferencesInText(`Read ${encoded}; then continue.`)).toEqual([encoded]);
  });

  it("deduplicates prose and footer references after removing punctuation", () => {
    const second = "cake://session/producer?message=123";
    const text = appendMessageReferences(`Read ${ref}; then ${second}.`, [ref, second]);
    expect(messageReferencesInText(text)).toEqual([ref, second]);
  });

  it("retains the bounded chronological reference order", () => {
    const refs = Array.from(
      { length: 21 },
      (_, index) => `cake://session/producer?message=${index + 1}`,
    );
    expect(messageReferencesInText(appendMessageReferences("", refs))).toEqual(refs.slice(0, 20));
  });

  it("still rejects references with extra query parameters", () => {
    expect(messageReferencesInText(`${ref}&attachment=other;`)).toEqual([]);
  });
});

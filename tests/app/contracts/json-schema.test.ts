import Ajv from "ajv";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { toDraft07JsonSchema } from "../../../src/contracts/serialization/json-contract";

it("rejects excess command fields inside referenced nested objects", () => {
  const target = Schema.Struct({ id: Schema.String }).annotate({ identifier: "Target" });
  const validate = new Ajv().compile(toDraft07JsonSchema(Schema.Struct({ target })));
  expect(validate({ target: { id: "session" } })).toBe(true);
  expect(validate({ target: { id: "session" }, extra: true })).toBe(false);
  expect(validate({ target: { id: "session", extra: true } })).toBe(false);
});

it("preserves explicitly modeled dictionary keys and validates their values", () => {
  const validate = new Ajv().compile(
    toDraft07JsonSchema(Schema.Struct({ values: Schema.Record(Schema.String, Schema.Number) })),
  );
  expect(validate({ values: { first: 1, second: 2 } })).toBe(true);
  expect(validate({ values: { first: "invalid" } })).toBe(false);
});

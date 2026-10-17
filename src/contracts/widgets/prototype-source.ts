import { Schema } from "effect";

const PrototypeModuleId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/));
const dependency = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
export const PrototypeModule = Schema.Struct({
  id: PrototypeModuleId,
  source: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_048_576)),
  dependencies: Schema.Array(dependency).check(Schema.isMaxLength(64)),
});
export interface PrototypeModule extends Schema.Schema.Type<typeof PrototypeModule> {}

/** Encoded as one default-exported JSON literal, never evaluated to extract source. */
export const PrototypeSource = Schema.Struct({
  schema: Schema.Literal("cake.prototype-source/v1"),
  chooser: PrototypeModule,
  options: Schema.Array(PrototypeModule).check(Schema.isMinLength(5), Schema.isMaxLength(5)),
  shared: Schema.Array(PrototypeModule).check(Schema.isMaxLength(64)),
});
export interface PrototypeSource extends Schema.Schema.Type<typeof PrototypeSource> {}

export const PrototypeChoice = Schema.Struct({
  schema: Schema.Literal("cake.prototype-ui/v1"),
  selectedOptionId: PrototypeModuleId,
});
export interface PrototypeChoice extends Schema.Schema.Type<typeof PrototypeChoice> {}

export const SelectedDesignReference = Schema.Struct({
  schema: Schema.Literal("cake.selected-design/v1"),
  exactRef: Schema.String.check(
    Schema.isMaxLength(512),
    Schema.isPattern(/^cake:\/\/artifact\/[A-Za-z0-9][A-Za-z0-9._:-]*@r[1-9][0-9]*$/),
  ),
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  optionId: PrototypeModuleId,
  state: Schema.Struct({
    version: Schema.Int.check(Schema.isGreaterThan(0)),
    value: PrototypeChoice,
  }),
}).check(
  Schema.makeFilter((ref) =>
    ref.optionId === ref.state.value.selectedOptionId ? undefined : "Selection evidence mismatch",
  ),
);
export interface SelectedDesignReference extends Schema.Schema.Type<
  typeof SelectedDesignReference
> {}

export const SelectedDesignCaptureInput = Schema.Struct({
  reference: SelectedDesignReference.fields.exactRef,
  expectedStateVersion: SelectedDesignReference.fields.state.fields.version,
});
export const SelectedDesignSourceInput = Schema.Struct({
  selection: SelectedDesignReference,
  moduleId: Schema.optionalKey(PrototypeModuleId),
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 48_000 }))),
});
export const SelectedDesignSourceOutput = Schema.Struct({
  selection: SelectedDesignReference,
  modules: Schema.Array(
    Schema.Struct({
      id: PrototypeModuleId,
      dependencies: PrototypeModule.fields.dependencies,
    }),
  ).check(Schema.isMaxLength(65)),
  module: Schema.optionalKey(
    Schema.Struct({
      id: PrototypeModuleId,
      source: Schema.String.check(Schema.isMaxLength(48_000)),
      offset: Schema.Int,
      totalCharacters: Schema.Int,
      nextOffset: Schema.NullOr(Schema.Int),
    }),
  ),
});

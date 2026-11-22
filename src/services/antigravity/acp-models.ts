import { Option, Schema } from "effect";
import { AntigravityModelOption } from "../../contracts/model-presets/antigravity-catalog";
import { antigravityModel } from "../../contracts/model-presets/antigravity-model";
import type { JsonValue } from "../../contracts/serialization/json-contract";

const decodeAdvertisedModels = Schema.decodeUnknownOption(
  Schema.Struct({
    models: Schema.Struct({
      availableModels: Schema.Array(AntigravityModelOption).check(Schema.isMaxLength(256)),
    }),
  }),
);

export function advertisedAntigravityModels(
  response: JsonValue | undefined,
): readonly AntigravityModelOption[] | undefined {
  const decoded = Option.getOrUndefined(decodeAdvertisedModels(response));
  if (!decoded) return undefined;
  const seen = new Set<string>([antigravityModel.modelId]);
  return decoded.models.availableModels.filter(({ modelId }) => {
    if (seen.has(modelId)) return false;
    seen.add(modelId);
    return true;
  });
}

const decodeConfigOptions = Schema.decodeUnknownOption(
  Schema.Struct({ configOptions: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(64)) }),
);
const decodeSelect = Schema.decodeUnknownOption(
  Schema.Struct({
    id: Schema.String,
    category: Schema.optionalKey(Schema.NullOr(Schema.String)),
    type: Schema.Literal("select"),
    currentValue: Schema.NonEmptyString,
  }),
);

export function confirmsAntigravityModel(response: JsonValue | undefined, requested: string) {
  const options = Option.getOrUndefined(decodeConfigOptions(response))?.configOptions.flatMap(
    (option) => {
      const select = Option.getOrUndefined(decodeSelect(option));
      return select ? [select] : [];
    },
  );
  const model = options?.find(({ id }) => id === "model")?.currentValue;
  const effort = options?.find(
    ({ id, category }) => id === "thought_level" || category === "thought_level",
  )?.currentValue;
  // agy 1.5 advertises flat variant IDs but replies with the effective family and effort.
  return Boolean(model && (model === requested || (effort && `${model}-${effort}` === requested)));
}

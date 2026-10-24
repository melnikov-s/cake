import { Schema } from "effect";

const StableVersion = Schema.String.check(
  Schema.isPattern(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
);

export const AppUpdate = Schema.Struct({
  version: StableVersion,
  downloadUrl: Schema.String,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
}).check(
  Schema.makeFilter(
    (update) =>
      update.downloadUrl ===
      `https://github.com/melnikov-s/cake/releases/download/v${update.version}/Cake-${update.version}-mac-arm64.dmg`,
  ),
);
export interface AppUpdate extends Schema.Schema.Type<typeof AppUpdate> {}

/** Releases are stable major.minor.patch only; never downgrade or compare lexically. */
export function isNewerVersion(available: string, installed: string): boolean {
  if (!Schema.is(StableVersion)(available) || !Schema.is(StableVersion)(installed)) return false;
  const next = available.split(".").map(BigInt);
  const current = installed.split(".").map(BigInt);
  for (let index = 0; index < 3; index++) {
    if (next[index]! > current[index]!) return true;
    if (next[index]! < current[index]!) return false;
  }
  return false;
}

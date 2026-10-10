import { Schema } from "effect";
import { MCP_STORED_SECRET } from "./mcp-settings-data";

const exposure = Schema.Literals(["codemode", "codemode-deferred", "deferred", "direct", "hidden"]);
const strings = Schema.Record(Schema.String, Schema.String);
const loopback = (url: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
const httpUrl = Schema.String.check(
  Schema.makeFilter((value) => {
    if (!URL.canParse(value)) return "Expected an HTTP or HTTPS URL";
    return ["http:", "https:"].includes(new URL(value).protocol);
  }),
);
const secureUrl = httpUrl.check(
  Schema.makeFilter((value) => new URL(value).protocol === "https:" || loopback(new URL(value))),
);
const callbackUrl = httpUrl.check(
  Schema.makeFilter((value) => {
    const url = new URL(value);
    return url.protocol === "http:" && loopback(url) && !url.search && !url.hash;
  }),
);
const oauth = Schema.Struct({
  clientId: Schema.optionalKey(Schema.String),
  clientSecret: Schema.optionalKey(Schema.String),
  callbackPort: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  ),
  callbackUrl: Schema.optionalKey(callbackUrl),
  scope: Schema.optionalKey(Schema.String),
  clientName: Schema.optionalKey(
    Schema.String.check(Schema.makeFilter((value) => value.trim().length > 0)),
  ),
  authServerMetadataUrl: Schema.optionalKey(secureUrl),
}).check(
  Schema.makeFilter(
    (value) =>
      !value.callbackUrl ||
      !new URL(value.callbackUrl).port ||
      value.callbackPort === undefined ||
      Number(new URL(value.callbackUrl).port) === value.callbackPort,
  ),
);
const common = {
  exposure: Schema.optionalKey(exposure),
  description: Schema.optionalKey(Schema.String),
  toolExposure: Schema.optionalKey(Schema.Record(Schema.String, exposure)),
  enabled: Schema.optionalKey(Schema.Boolean),
  timeout: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThan(0))),
};
const stdioConfig = Schema.Struct({
  ...common,
  type: Schema.optionalKey(Schema.Literal("stdio")),
  command: Schema.String.check(Schema.isMinLength(1)),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(strings),
  cwd: Schema.optionalKey(Schema.String),
}).check(Schema.makeFilter((value) => !("url" in value)));

const editableHttpUrl = Schema.Union([httpUrl, Schema.Literal(MCP_STORED_SECRET)]);
const httpConfig = (url: typeof httpUrl | typeof editableHttpUrl) =>
  Schema.Struct({
    ...common,
    type: Schema.optionalKey(Schema.Literals(["http", "streamable-http"])),
    url,
    headers: Schema.optionalKey(strings),
    oauth: Schema.optionalKey(oauth),
    auth: Schema.optionalKey(
      Schema.Struct({ provider: Schema.String.check(Schema.isMinLength(1)) }),
    ),
  }).check(
    Schema.makeFilter(
      (value) =>
        !value.auth ||
        value.url === MCP_STORED_SECRET ||
        new URL(value.url).protocol === "https:" ||
        loopback(new URL(value.url)),
    ),
  );

/** Documented Pi configuration shape; validation never resolves env/credential commands. */
export const NativeMcpConfig = Schema.Union([stdioConfig, httpConfig(httpUrl)]);
/** Tool edits may retain a redacted URL. The authoritative service restores it, then
 * validates NativeMcpConfig before writing; this is never an executable config. */
export const NativeMcpConfigEdit = Schema.Union([
  Schema.StructWithRest(stdioConfig, [Schema.Record(Schema.String, Schema.Json)]),
  Schema.StructWithRest(httpConfig(editableHttpUrl), [Schema.Record(Schema.String, Schema.Json)]),
]);

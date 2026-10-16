import { Schema } from "effect";

export const exactHost = Schema.NonEmptyString.check(
  Schema.isMaxLength(512),
  Schema.makeFilter(
    (value) => {
      try {
        const url = new URL(`http://${value}`);
        return (
          !value.includes("*") &&
          (url.host === value.toLowerCase() || `${url.hostname}:80` === value.toLowerCase()) &&
          url.pathname === "/" &&
          !url.username &&
          !url.password
        );
      } catch {
        return false;
      }
    },
    {
      message:
        "Expected an exact Host authority (hostname with optional port), not a wildcard or URL",
    },
  ),
);
export const exactOrigin = Schema.NonEmptyString.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter(
    (value) => {
      try {
        const url = new URL(value);
        return (
          (url.protocol === "http:" || url.protocol === "https:") &&
          url.origin === value &&
          !value.includes("*")
        );
      } catch {
        return false;
      }
    },
    { message: "Expected an exact http(s) origin without a path or wildcard" },
  ),
);

export const exactHttpsOrigin = exactOrigin.check(
  Schema.makeFilter((value) => value.startsWith("https://"), {
    message:
      "Expected an exact HTTPS origin (for example https://laptop.tailnet.ts.net), without a path or trailing slash",
  }),
);

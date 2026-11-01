import { themeOperationDefinitions } from "../../contracts/themes/theme-operations";
import { defineControl } from "./control-definition";
import { toStrictJson } from "./control-json";

export const themeControls = [
  defineControl({
    ...themeOperationDefinitions["themes.list"],
    run: async (_input, { host }, command) =>
      toStrictJson({ ok: true, command, scope: "window", ...host.themes.list() }),
  }),
  defineControl({
    ...themeOperationDefinitions["themes.read"],
    run: async (input, { host }, command) =>
      toStrictJson({ ok: true, command, scope: "window", ...host.themes.read(input.choice) }),
  }),
  defineControl({
    ...themeOperationDefinitions["themes.add"],
    run: async (input, { host }, command) =>
      toStrictJson({ ok: true, command, scope: "window", ...(await host.themes.add(input)) }),
  }),
  defineControl({
    ...themeOperationDefinitions["themes.apply"],
    run: async (input, { host }, command) =>
      toStrictJson({ ok: true, command, scope: "window", ...(await host.themes.apply(input)) }),
  }),
];

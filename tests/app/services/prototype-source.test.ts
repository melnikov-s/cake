import { describe, expect, it } from "vitest";
import {
  moduleImports,
  readPrototypeSource,
  selectedPrototypeModules,
} from "../../../src/services/widgets/prototype-source";
import { encodePrototype, prototypeFixture } from "../../fixtures/prototype-source";

describe("validated prototype source format", () => {
  it("extracts by explicit stable module identity, with transitive shared dependencies only", () => {
    const source = encodePrototype(prototypeFixture());
    const bundle = readPrototypeSource(source);
    if (!bundle) throw new Error("Missing manifest");
    expect(selectedPrototypeModules(bundle, "option-4").map((module) => module.id)).toEqual([
      "option-4",
      "palette",
      "tokens",
    ]);
    expect(() => selectedPrototypeModules(bundle, "missing")).toThrow("Unknown prototype option");
    expect(readPrototypeSource("export default function Widget(){return null}")).toBeUndefined();
  });

  it.each<[string, (bundle: ReturnType<typeof prototypeFixture>) => void]>([
    [
      "duplicate IDs",
      (bundle) => {
        bundle.shared[0] = { id: "option-1", source: "export const x=1", dependencies: [] };
      },
    ],
    [
      "not five",
      (bundle) => {
        bundle.options = bundle.options.slice(1);
      },
    ],
    [
      "missing shared",
      (bundle) => {
        bundle.shared = [];
      },
    ],
    [
      "undeclared import",
      (bundle) => {
        bundle.options[0] = {
          id: "option-1",
          source: 'import {palette} from "cake:prototype/palette"; export default ()=>null;',
          dependencies: [],
        };
      },
    ],
    [
      "phantom dependency",
      (bundle) => {
        bundle.options[0] = {
          id: "option-1",
          source: "export default ()=>null;",
          dependencies: ["react"],
        };
      },
    ],
    [
      "cross-option",
      (bundle) => {
        bundle.shared.push({
          id: "bad",
          source: 'export {default} from "cake:prototype/option-1";',
          dependencies: ["cake:prototype/option-1"],
        });
      },
    ],
    [
      "chooser dependency",
      (bundle) => {
        bundle.shared.push({
          id: "bad",
          source: 'export {default} from "cake:prototype/chooser";',
          dependencies: ["cake:prototype/chooser"],
        });
      },
    ],
    [
      "cycle",
      (bundle) => {
        bundle.shared.push({
          id: "cycle",
          source: 'export * from "cake:prototype/cycle";',
          dependencies: ["cake:prototype/cycle"],
        });
      },
    ],
    [
      "dynamic import",
      (bundle) => {
        bundle.shared.push({
          id: "bad",
          source: 'export const x=import("react");',
          dependencies: [],
        });
      },
    ],
    [
      "require",
      (bundle) => {
        bundle.shared.push({
          id: "bad",
          source: 'export const x=require("react");',
          dependencies: [],
        });
      },
    ],
    [
      "relative import",
      (bundle) => {
        bundle.shared.push({
          id: "bad",
          source: 'export * from "./secret";',
          dependencies: ["./secret"],
        });
      },
    ],
    [
      "missing source",
      (bundle) => {
        bundle.chooser.source = "";
      },
    ],
    [
      "syntax",
      (bundle) => {
        bundle.chooser.source = "export default function ( {";
      },
    ],
    [
      "missing chooser option",
      (bundle) => {
        bundle.chooser.source = "export default ()=>null;";
        bundle.chooser.dependencies = [];
      },
    ],
  ])("rejects %s instead of guessing or falling back", (_name, change) => {
    const bundle = prototypeFixture();
    change(bundle);
    expect(() => readPrototypeSource(encodePrototype(bundle))).toThrow();
  });

  it("preserves manifest offsets after Unicode comments without evaluating source", () => {
    const bundle = prototypeFixture();
    expect(readPrototypeSource(`// 🧁 prototype\n${encodePrototype(bundle)}`)).toEqual(bundle);
    expect(
      readPrototypeSource(`${encodePrototype(bundle)}\nconsole.log('extra');`),
    ).toBeUndefined();
  });

  it("collects TSX imports, type-only imports, and re-exports before any type erasure", () => {
    expect([
      ...moduleImports({
        id: "typed-option",
        source: [
          'import type {ReactNode} from "react";',
          'import {palette} from "cake:prototype/palette";',
          'export type {Token} from "cake:prototype/tokens";',
          'export * from "cake:prototype/shared";',
          'const label: ReactNode = "require(\\"ignored\\")";',
          "export default () => <section style={{color: palette.ink}}>{label}</section>;",
        ].join("\n"),
      }),
    ]).toEqual([
      "react",
      "cake:prototype/palette",
      "cake:prototype/tokens",
      "cake:prototype/shared",
    ]);
  });

  it.each([
    ['import React = require("react");', "import equals"],
    ['export const load = () => import("react");', "nested dynamic import"],
    ['export const load = () => require("react");', "nested require"],
    ['export const load = () => require?.("react");', "optional require"],
    ["export default () => <section>;", "malformed JSX"],
    ["export const label: = 1;", "malformed TypeScript"],
  ])("rejects unsupported module source: %s (%s)", (source) => {
    expect(() => moduleImports({ id: "bad", source })).toThrow();
  });

  it("never evaluates executable manifests", () => {
    expect(() =>
      readPrototypeSource('export default {"schema":"cake.prototype-source/v1", ...globalThis};'),
    ).toThrow();
  });
});

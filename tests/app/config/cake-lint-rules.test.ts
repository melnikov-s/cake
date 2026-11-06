import { ESLint } from "eslint";
import { resolve } from "node:path";
import tseslint from "typescript-eslint";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import cake from "../../../tools/eslint/cake.js";

// Rules are tested independently of unrelated existing error-level checks.
function isolated(name: string, options: unknown[] = [], program?: ts.Program) {
  return new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.{ts,tsx}"],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: {
            ecmaFeatures: { jsx: true },
            ...(program ? { programs: [program] } : {}),
          },
        },
        plugins: { cake },
        rules: { [`cake/${name}`]: ["warn", ...options] },
      },
    ],
  });
}
async function messages(
  name: string,
  code: string,
  options: unknown[] = [],
  filePath = "src/renderer/components/fixture.tsx",
) {
  const [result] = await isolated(name, options).lintText(code, { filePath });
  expect(result?.fatalErrorCount).toBe(0);
  expect(result?.errorCount).toBe(0);
  return result?.messages ?? [];
}

function typedProgram(code: string, extra: Record<string, string> = {}) {
  const file = resolve("tests/app/config/lint-virtual.tsx");
  const config = ts.readConfigFile(resolve("tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  const host = ts.createCompilerHost(parsed.options);
  const sources = new Map([
    [file, code],
    ...Object.entries(extra).map(([name, text]) => [resolve(name), text] as const),
  ]);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => sources.has(name) || fileExists(name);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version, ...rest) =>
    sources.has(name)
      ? ts.createSourceFile(name, sources.get(name)!, version, true, ts.ScriptKind.TSX)
      : getSourceFile(name, version, ...rest);
  return { file, program: ts.createProgram([file], parsed.options, host) };
}

describe("view capability boundaries", () => {
  it.each([
    'import { Client as Commands } from "@/client/Client";',
    'export { Runtime } from "../client/../runtime";',
    'export * from "src/renderer/observers/models";',
    'const x = import("@/../ipc/client/CakeIpcClient");',
  ])("bad/alias: warns for runtime infrastructure: %s", async (code) => {
    expect(await messages("view-capability-boundaries", code)).toHaveLength(1);
  });
  it.each([
    'import type { Client } from "@/client/Client"; type Image = Pick<Client["filesystem"], "readImage">;',
    'import { type Client } from "@/client/Client";',
    'import { FeatureStore } from "@/stores/FeatureStore";',
  ])("good/exception: passive presentation types and Store intents: %s", async (code) => {
    expect(await messages("view-capability-boundaries", code)).toHaveLength(0);
  });
});

describe("React effect ownership", () => {
  it("bad/alias: tracks useState setters and both aliased/namespace effect hooks", async () => {
    const code = `import * as React from "react"; import { useEffect as setup, useState as state } from "react";
      function View({value}) { const [copy, assign] = state(value);
        setup(() => { assign(value); }, [value]);
        React.useLayoutEffect(() => assign(value), [value]);
      }`;
    expect(
      (await messages("react-effect-ownership", code)).map((message) => message.messageId),
    ).toEqual(["copy", "copy"]);
  });
  it("good/exception: allows DOM measurement, callbacks, cleanup, retain/release, updater functions and unrelated setters", async () => {
    const code = `import {useEffect, useState} from "react";
      function View({value, element, store}) { const [bounds, measure] = useState(null);
        useEffect(() => { measure(element.getBoundingClientRect()); store.retain();
          element.addEventListener("click", () => measure(value));
          const observer = new ResizeObserver(() => measure(value));
          return () => { measure(value); store.release(); observer.disconnect(); };
        }, [value]);
        useEffect(() => measure(previous => previous), [value]);
        const other = (value) => {}; useEffect(() => other(value), [value]);
      }`;
    expect(await messages("react-effect-ownership", code)).toHaveLength(0);
  });
  it("good: hook and setter shadowing do not inherit import identity", async () => {
    expect(
      await messages(
        "react-effect-ownership",
        `import {useEffect, useState} from "react";
      function View({value}) { const [x, setX] = useState(value);
        function inner(useEffect) { useEffect(() => setX(value), [value]); }
        useEffect(() => { const setX = () => {}; setX(value); }, [value]); }`,
      ),
    ).toHaveLength(0);
  });
  it("exception: documented draft option suppresses only copies", async () => {
    expect(
      await messages(
        "react-effect-ownership",
        `import {useEffect, useState} from "react";
      function View({value}) {const [draft, setDraft] = useState(value); useEffect(() => setDraft(value), [value]);}`,
        [{ stateCopyExceptions: ["setDraft"] }],
      ),
    ).toHaveLength(0);
  });
  it("typed bad/alias and exceptions: recognizes actual Store inheritance and Promise workflows, not spelling or deferred work", async () => {
    const code = `import {Store as StateOwner} from "r-state-tree";
      import {useEffect as setup, useState} from "react";
      class Feature extends StateOwner { async load() {} retain() {} release() {} }
      function View({owner, store, value}: {owner: Feature; store: {load(): Promise<void>}; value: string}) {
        const [draft, setDraft] = useState(value);
        setup(() => { void owner.load(); owner.retain();
          window.addEventListener("click", () => void owner.load());
          void store.load(); return () => { void owner.load(); owner.release(); };
        }, []);
        setup(() => { setDraft(value); void owner.load(); }, [value]);
      }`;
    const { file, program } = typedProgram(code);
    const [result] = await isolated(
      "react-effect-ownership",
      [{ stateCopyExceptions: ["setDraft"] }],
      program,
    ).lintText(code, { filePath: file });
    expect(result?.fatalErrorCount).toBe(0);
    expect(result?.messages.map((message) => message.messageId)).toEqual(["workflow", "workflow"]);
  }, 30_000);
});

it("typed alias: view capability imports cannot hide behind a local re-export", async () => {
  const code = 'import { Client as Commands } from "./lint-barrel"; export {Commands};';
  const { file, program } = typedProgram(code, {
    "tests/app/config/lint-barrel.ts":
      'export {Client} from "../../../src/renderer/client/Client";',
  });
  const [result] = await isolated("view-capability-boundaries", [], program).lintText(code, {
    filePath: file,
  });
  expect(result?.fatalErrorCount).toBe(0);
  expect(result?.messages.map((m) => m.messageId)).toEqual(["capability"]);
}, 30_000);

it("typed view execution: broad Client capabilities warn but a narrow presentation Pick is allowed", async () => {
  const code = `import type {Client} from '../../../src/renderer/client/Client';
    declare const full: Client; declare const image: Pick<Client['filesystem'], 'readImage'>;
    full.filesystem.readImage({path: 'image.png'}); image.readImage({path: 'image.png'});`;
  const { file, program } = typedProgram(code);
  const [result] = await isolated("view-capability-boundaries", [], program).lintText(code, {
    filePath: file,
  });
  expect(result?.fatalErrorCount).toBe(0);
  expect(result?.messages.map((m) => m.messageId)).toEqual(["capability"]);
}, 30_000);

it("typed Promise warnings: explicit void and async JSX are allowed, misused void callbacks warn", async () => {
  const code = `declare function work(): Promise<void>; work(); void work();
    const handler: () => void = async () => {}; const view = <button onClick={async () => {}}/>;`;
  const { file, program } = typedProgram(code);
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.tsx"],
        languageOptions: { parser: tseslint.parser, parserOptions: { programs: [program] } },
        plugins: { "@typescript-eslint": tseslint.plugin },
        rules: {
          "@typescript-eslint/no-floating-promises": ["warn", { ignoreVoid: true }],
          "@typescript-eslint/no-misused-promises": [
            "warn",
            { checksVoidReturn: { attributes: false } },
          ],
        },
      },
    ],
  });
  const [result] = await eslint.lintText(code, { filePath: file });
  expect(result?.errorCount).toBe(0);
  expect(result?.messages.map((m) => m.ruleId)).toEqual([
    "@typescript-eslint/no-floating-promises",
    "@typescript-eslint/no-misused-promises",
  ]);
}, 30_000);

describe("reusable reactive collection contract", () => {
  const header =
    'import { Store as Owner, Model, observable as track, toObservableTree as tree, child as nested } from "r-state-tree";';
  it("bad/alias: detects observable copies and same-class raw mutation, including private fields", async () => {
    const code = `${header} class Feature extends Owner {
      items = track([]); object = tree({x: 0}); raw = []; private hidden = new Set(); get hiddenSize() { return this.hidden.size; }
      change() { this.items = [...this.items]; this.items = this.items.filter(Boolean);
        this.object = { ...this.object }; this.raw.push(1); this.hidden.add(2); }
    }`;
    expect((await messages("reactive-collection-contract", code)).map((m) => m.messageId)).toEqual([
      "replace",
      "replace",
      "replace",
      "mutate",
      "mutate",
    ]);
  });
  it("bad: catches plain object, index, length, Map and Set mutations", async () => {
    expect(
      await messages(
        "reactive-collection-contract",
        `${header} class Feature extends Model {
      data = {}; items = []; map = new Map(); set = new Set();
      change() { this.data.x = 1; this.items[0]++; this.items.length = 0; this.map.set('a', 1); this.set.clear(); delete this.data.x; }
    }`,
      ),
    ).toHaveLength(6);
  });
  it("good/exception: initialization, outbound copies, rewrapping, plain reassignment, managed @child and unknown helpers", async () => {
    expect(
      await messages(
        "reactive-collection-contract",
        `${header} class Feature extends Owner {
      items = track([]); raw = []; unknown = factory(); @nested(Model) children = [];
      constructor() { super(); this.items = []; this.raw.push(1); }
      change() { const result = [...this.items]; this.items.push(1); this.items = track(result);
        this.raw = [...this.raw, 1]; this.unknown.push(1); this.children.push(Model.create()); this.children = [...this.children]; return result; }
    }`,
      ),
    ).toHaveLength(0);
  });
  it("exception: narrowly configured private nonreactive buffer, not every private field", async () => {
    expect(
      await messages(
        "reactive-collection-contract",
        `${header} class Feature extends Owner {
      private queue = []; private visible = []; get count() { return this.queue.length + this.visible.length; } change() { this.queue.push(1); this.visible.push(1); }
    }`,
        [{ nonReactiveFields: ["Feature.queue"] }],
      ),
    ).toHaveLength(1);
  });
  it("exception: private queues and fields subsequently wrapped by unknown helpers are not guessed", async () => {
    expect(
      await messages(
        "reactive-collection-contract",
        `${header} class Feature extends Owner {
      private queue = []; raw = []; constructor() { super(); this.raw = track([]); }
      change() { this.queue.push(1); this.raw.push(1); }
    }`,
      ),
    ).toHaveLength(0);
  });
  it("good: unrelated classes and shadowed factories are not assumed reactive", async () => {
    expect(
      await messages(
        "reactive-collection-contract",
        `class Store {} class Feature extends Store { items = []; change(){ this.items.push(1); } }`,
      ),
    ).toHaveLength(0);
  });
});

describe("Effect conventions", () => {
  it("bad/alias: exported native async functions and real global timers", async () => {
    expect(
      await messages(
        "domain-native-orchestration",
        `export async function run() {};
      const later = async () => {}; export {later}; export default async () => {};
      setTimeout(() => {}, 1); globalThis.setInterval(() => {}, 2);`,
      ),
    ).toHaveLength(5);
  });
  it("good/exception: native adapters nested in Effects and object methods/shadowed timers", async () => {
    expect(
      await messages(
        "domain-native-orchestration",
        `import {Effect} from "effect";
      export const run = Effect.fn("run")(function*(){ yield* Effect.tryPromise(async () => 1); });
      api.setTimeout(() => {}, 1); function adapter(setTimeout) { setTimeout(() => {}, 1); }
      const internal = async () => {};`,
      ),
    ).toHaveLength(0);
  });
  it.each(["catchCause", "catchCauseIf", "catchCauseFilter", "catchDefect"])(
    "bad/alias: import-aware %s recovery",
    async (method) => {
      expect(
        await messages(
          "cause-recovery-boundaries",
          `import { Effect as E } from "effect"; E.${method}(f);
      import {${method} as recover} from "effect/Effect"; recover(f);`,
        ),
      ).toHaveLength(2);
    },
  );
  it("good/exception: typed recovery, observation and shadowed Effect identifiers", async () => {
    expect(
      await messages(
        "cause-recovery-boundaries",
        `import {Effect} from "effect";
      Effect.catchTag("Expected", f); Effect.tapCause(f); function local(Effect) { Effect.catchCause(f); }`,
      ),
    ).toHaveLength(0);
  });
  it("bad/alias: direct exported gen wrappers including later export", async () => {
    expect(
      await messages(
        "named-effect-operations",
        `import * as E from "effect/Effect";
      export const run = () => E.gen(function*() {});
      function other() { return E.gen(function*() {}); } export {other};`,
      ),
    ).toHaveLength(2);
  });
  it("good/exception: named operations, acquisition values, locals, generic adapters and branch composition", async () => {
    expect(
      await messages(
        "named-effect-operations",
        `import {Effect as E, Layer} from "effect";
      export const run = E.fn("run")(function*() {}); export const layer = Layer.effect(Tag, E.gen(function*(){}));
      const local = () => E.gen(function*(){}); export const generic = <T,>(v: T) => E.gen(function*(){return v;});
      export function branch(flag) { if (flag) return E.gen(function*(){}); return E.void; }`,
      ),
    ).toHaveLength(0);
  });
});

describe("deterministic test waits and controls", () => {
  it("bad/alias: Promise-as-sleep with resolver binding aliases", async () => {
    expect(
      await messages(
        "deterministic-test-waits",
        `await new Promise(done => setTimeout(done, 30));
      await new Promise(resolve => { setTimeout(() => resolve(), 30); });`,
      ),
    ).toHaveLength(2);
  });
  it("bad/alias: known Playwright Page type and fixture binding", async () => {
    expect(
      await messages(
        "deterministic-test-waits",
        `import {test as scenario, type Page as Tab} from '@playwright/test';
      async function wait(tab: Tab) { await tab.waitForTimeout(50); }
      scenario('delay', async ({page: browser}) => { await browser.waitForTimeout(30); });`,
      ),
    ).toHaveLength(2);
  });
  it("good/exception: actual timer callback behavior, fake async under test, controlled Effect time and unrelated APIs", async () => {
    expect(
      await messages(
        "deterministic-test-waits",
        `new Promise(resolve => setTimeout(() => { work(); resolve(); }, 30));
      Effect.sleep('1 second'); TestClock.adjust('1 second'); api.waitForTimeout(30);
      function fake(setTimeout) { return new Promise(resolve => setTimeout(resolve, 1)); }`,
      ),
    ).toHaveLength(0);
  });
  it("bad/good: raw controls warn, shared components do not", async () => {
    expect(
      await messages(
        "authoritative-controls",
        `const v = <><button/><input/><select/><textarea/><Button/><Input/></>;`,
      ),
    ).toHaveLength(4);
  });
});

describe("real configuration stays advisory", () => {
  const eslint = new ESLint();
  // Config projections above prove severity/scoping; syntax fixtures below
  // avoid constructing the entire application type graph. Typed ownership is
  // exercised independently against a real TypeScript Program above.
  const syntax = new ESLint({
    overrideConfig: {
      languageOptions: { parserOptions: { projectService: false } },
      rules: {
        "@typescript-eslint/no-floating-promises": "off",
        "@typescript-eslint/no-misused-promises": "off",
      },
    },
  });
  it("all new rules are warnings, source cap is 1000 counted lines, no test cap", async () => {
    const source = await eslint.calculateConfigForFile(
      "src/renderer/components/table-artifact.tsx",
    );
    for (const [name, value] of Object.entries(source.rules)) {
      if (
        name.startsWith("cake/") ||
        [
          "max-lines",
          "@typescript-eslint/no-floating-promises",
          "@typescript-eslint/no-misused-promises",
        ].includes(name)
      )
        expect(Array.isArray(value) ? value[0] : value, name).toBe(1);
    }
    expect(source.rules["max-lines"]).toEqual([
      1,
      { max: 1000, skipBlankLines: true, skipComments: true },
    ]);
    const test = await eslint.calculateConfigForFile(
      "tests/app/renderer/slash-command-combobox.test.tsx",
    );
    expect(test.rules["max-lines"]).toBeUndefined();
    expect(test.rules["cake/deterministic-test-waits"][0]).toBe(1);
    expect(source.rules["architecture/module-boundaries"][0]).toBe(2);
  }, 30_000);
  it("exceptions: UI primitives, bootstrap, draft reconciliation and explicit supervisors", async () => {
    const primitive = await eslint.calculateConfigForFile("src/renderer/components/ui/button.tsx");
    expect(primitive.rules["cake/authoritative-controls"]).toBeUndefined();
    const bootstrap = await eslint.calculateConfigForFile("src/renderer/main.tsx");
    expect(bootstrap.rules["cake/view-capability-boundaries"]).toBeUndefined();
    const draft = await eslint.calculateConfigForFile(
      "src/renderer/components/settings/settings-text-field.tsx",
    );
    expect(draft.rules["cake/react-effect-ownership"]).toEqual([
      1,
      { stateCopyExceptions: ["setDraft"] },
    ]);
    const runtime = await eslint.calculateConfigForFile("src/main/MainApplication.ts");
    expect(runtime.rules["cake/cause-recovery-boundaries"][0]).toBe(0);
  });
  it("warning-only real lint results exit successfully without suppressing violations", async () => {
    const [result] = await syntax.lintText("export const Control = () => <input />;", {
      filePath: "src/renderer/components/table-artifact.tsx",
    });
    expect(result?.errorCount).toBe(0);
    expect(result?.warningCount).toBe(1);
    expect(result?.messages[0]?.severity).toBe(1);
  }, 30_000);
  it("source size ignores comment-only/blank lines and generated/declaration files", async () => {
    const line = "export const value = 1;";
    const code = `${line}\n${"// commentary\n\n".repeat(1001)}`;
    const [result] = await syntax.lintText(code, {
      filePath: "src/contracts/configuration/settings.ts",
    });
    expect(result?.fatalErrorCount).toBe(0);
    expect(result?.messages.filter((m) => m.ruleId === "max-lines")).toHaveLength(0);
    const [oversized] = await syntax.lintText(
      Array.from({ length: 1001 }, (_, i) => `export const value${i} = ${i};`).join("\n"),
      { filePath: "src/contracts/configuration/settings.ts" },
    );
    expect(oversized?.messages.filter((m) => m.ruleId === "max-lines")).toHaveLength(1);
    const generated = await eslint.calculateConfigForFile("src/generated/example.ts");
    expect(generated.rules["max-lines"]).toBeUndefined();
    const declaration = await eslint.calculateConfigForFile("src/renderer/example.d.ts");
    expect(declaration.rules["max-lines"]).toBeUndefined();
  }, 30_000);
});

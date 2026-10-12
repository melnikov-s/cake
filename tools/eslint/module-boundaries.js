import { builtinModules } from "node:module";
import path from "node:path";

const nodeModules = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));

// Classify process ownership, not import spelling. In particular, type-only
// dependencies and re-exports cannot smuggle backend contracts into the UI.
function owner(file) {
  // Include directory/barrel imports as well as leaf files.
  const location = `${file}/`;
  if (/^src\/(contracts|utils)\//.test(location)) return "shared";
  if (location.startsWith("src/services/")) return "service";
  if (location.startsWith("src/domain/")) return "domain";
  if (location.startsWith("src/layers/")) return "composition";
  if (location.startsWith("src/config/")) return "config";
  if (location.startsWith("src/renderer/")) return "renderer";
  if (location.startsWith("src/preload/")) return "preload";
  if (/^src\/(main|backend|server)\//.test(location)) return "backend";
  if (location.startsWith("src/ipc/server/")) return "backend";
  if (location.startsWith("src/ipc/client/")) return "client";
  if (location.startsWith("src/ipc/protocol/")) return "protocol";
  if (location.startsWith("src/ipc/transport/")) {
    if (/\/ElectronRpcClientProtocol(?:\.[cm]?[jt]s)?$/.test(file)) return "client";
    if (/\/(ElectronRpcChannels|ElectronRpcTransport)(?:\.[cm]?[jt]s)?$/.test(file))
      return "shared";
    // New privileged transports are backend-owned by default, not implicitly shared.
    return "backend";
  }
  // IPC contains only protocol and transport infrastructure, never shared data.
  if (location.startsWith("src/ipc/")) return "unclassified-ipc";
  return undefined;
}

const allowed = {
  shared: new Set(["shared"]),
  config: new Set(["config", "shared"]),
  service: new Set(["service", "shared", "config"]),
  domain: new Set(["domain", "service", "shared", "config"]),
  composition: new Set([
    "composition",
    "backend",
    "domain",
    "service",
    "shared",
    "config",
    "protocol",
  ]),
  backend: new Set(["backend", "composition", "domain", "service", "shared", "config", "protocol"]),
  renderer: new Set(["renderer", "client", "protocol", "shared"]),
  client: new Set(["client", "protocol", "shared"]),
  protocol: new Set(["protocol", "shared"]),
  preload: new Set(["shared"]),
};

function importPath(file, source, cwd) {
  // Vite asset/query suffixes do not change the module's owner.
  source = source.split(/[?#]/, 1)[0];
  if (source.startsWith(".")) return path.resolve(path.dirname(file), source);
  // These are the application aliases from tsconfig / Vite. Normalize dot
  // segments before classifying, so ../ escapes cannot bypass the rule.
  if (source.startsWith("@/")) return path.resolve(cwd, "src/renderer", source.slice(2));
  if (source.startsWith("src/")) return path.resolve(cwd, source);
  if (path.isAbsolute(source)) return source;
  return undefined;
}

function literalValue(node) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0].value.cooked;
  return undefined;
}

const rule = {
  meta: {
    type: "problem",
    docs: { description: "Enforce Cake's capability, policy, contract, and process boundaries." },
    schema: [],
    messages: {
      dependency:
        "{{from}} code cannot import {{to}} modules ({{source}}). Extract shared schemas, values, and codecs into src/contracts; keep policy in domain and wire callbacks in layers.",
      privileged:
        "{{from}} code cannot import privileged runtime package {{source}}. Use shared contracts and the typed RPC/preload boundary.",
      pi: "Pi SDK imports belong only beneath src/services/pi or src/services/pi-durable.",
      ipcLocation:
        "IPC modules belong in protocol/, client/, server/, or transport/. Move shared schemas, values, and codecs into feature-named src/contracts modules.",
    },
  },
  create(context) {
    const cwd = context.cwd;
    const file = context.filename;
    const relativeFile = path.relative(cwd, file).split(path.sep).join("/");
    const from = owner(relativeFile);
    if (!from) return {};
    if (from === "unclassified-ipc")
      return { Program: (node) => context.report({ node, messageId: "ipcLocation" }) };

    function check(node, sourceNode) {
      const source = literalValue(sourceNode);
      if (source === undefined) return;
      const piPackage = /^@earendil-works\/(pi(?:-|\/|$)|chord(?:\/|$))/.test(source);
      const piAdapter = /^src\/services\/(pi|pi-durable)\//.test(relativeFile);
      if (piPackage && !piAdapter) {
        context.report({ node, messageId: "pi" });
        return;
      }
      const privileged =
        source.startsWith("node:") ||
        nodeModules.has(source) ||
        /^electron(?:\/|$)/.test(source) ||
        /^@effect\/platform-node/.test(source);
      if (["renderer", "client", "protocol", "shared"].includes(from) && privileged) {
        context.report({ node, messageId: "privileged", data: { from, source } });
        return;
      }
      const target = importPath(file, source, cwd);
      if (!target) return;
      const relativeTarget = path.relative(cwd, target).split(path.sep).join("/");
      const to = owner(relativeTarget);
      if (to && !allowed[from].has(to))
        context.report({ node, messageId: "dependency", data: { from, to, source } });
    }

    return {
      ImportDeclaration: (node) => check(node, node.source),
      ExportNamedDeclaration: (node) => check(node, node.source),
      ExportAllDeclaration: (node) => check(node, node.source),
      ImportExpression: (node) => check(node, node.source),
      TSImportType: (node) => check(node, node.source),
      TSImportEqualsDeclaration: (node) => check(node, node.moduleReference.expression),
      CallExpression: (node) => {
        if (node.callee.type === "Identifier" && node.callee.name === "require")
          check(node, node.arguments[0]);
      },
    };
  },
};

export default { rules: { "module-boundaries": rule } };

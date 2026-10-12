import type { SubagentReportOrigin } from "../../src/contracts/subagents/subagent-data";

export const researchOrigin: SubagentReportOrigin = {
  handleId: "10000000-0000-4000-8000-000000000002",
  task: "Compare Godot and Three.js game-development workflows",
  status: "complete",
  resolvedModel: {
    requested: "current",
    source: "current",
    provider: "fixture",
    modelId: "fixture",
    thinkingLevel: "off",
    fallbacks: [],
  },
  fastMode: false,
  usage: { cost: 0.25 },
};

export const researchMarkdown = [
  "## Game-development workflow comparison",
  "",
  "This is a deterministic UI fixture, not live research.",
  "",
  "- **Godot:** an integrated game editor and engine.",
  "- **Three.js:** a rendering library for browser-based experiences.",
  "",
  "### Example",
  "",
  "```ts",
  "const scene = new THREE.Scene();",
  "```",
  "",
  "Reference links: [Godot](https://godotengine.org) and [Three.js](https://threejs.org).",
  "",
  "Web access is not guaranteed; do not treat this fixture as retrieved evidence.",
].join("\n");

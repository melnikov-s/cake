import { captureVisual } from "./capture.ts";
import { parseVisualCaptureArguments } from "./arguments.ts";
import { formatVisualCaptureResult } from "./result.ts";
import { visualCaptureScenarios } from "./scenarios.ts";

export const visualCaptureHelp = `Usage: pnpm visual:capture <scenario> [options]

Capture a deterministic Cake UI scenario from the compiled Electron application.

Commands:
  --list                       List repository-owned scenarios and states
  -h, --help                   Show this help

Options:
  --state <name>               Named interaction state (default: default)
  --theme <light|dark>         Seeded application theme (default: dark)
  --width <pixels>             Renderer viewport width, 320-3840 (default: 1280)
  --height <pixels>            Renderer viewport height, 320-3840 (default: 900)
  --capture <region|window>    Scenario region or full app content (default: region)
  --output <file.png>          Exact output file
  --output-dir <directory>     Output directory (default: .visual-captures)
  --no-build                   Use the existing compiled out/ application

Examples:
  pnpm visual:capture --list
  pnpm visual:capture assistant-markdown-code
  pnpm visual:capture assistant-markdown-code --state hover --theme light
  pnpm visual:capture assistant-markdown-code --capture window --width 1440 --height 1000
`;

export async function runVisualCaptureCli(arguments_: readonly string[]) {
  const options = parseVisualCaptureArguments(arguments_);
  if (options.help) {
    console.log(visualCaptureHelp.trimEnd());
    return;
  }
  if (options.list) {
    console.log("Cake visual-capture scenarios:");
    for (const scenario of visualCaptureScenarios)
      console.log(
        `  ${scenario.name.padEnd(28)} ${scenario.description} (states: ${scenario.states.join(", ")})`,
      );
    return;
  }

  const result = await captureVisual(options);
  console.log(`Captured ${result.scenario}/${result.state} → ${result.outputPath}`);
  console.log(formatVisualCaptureResult(result));
}

runVisualCaptureCli(process.argv.slice(2)).catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  console.error(`visual:capture failed: ${message}`);
  process.exitCode = 1;
});

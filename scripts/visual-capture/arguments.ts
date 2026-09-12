import { resolve } from "node:path";

const visualCaptureThemes = ["light", "dark"] as const;
const visualCaptureModes = ["region", "window"] as const;

export type VisualCaptureTheme = (typeof visualCaptureThemes)[number];
type VisualCaptureMode = (typeof visualCaptureModes)[number];

export interface VisualCaptureOptions {
  readonly scenario?: string;
  readonly state: string;
  readonly theme: VisualCaptureTheme;
  readonly width: number;
  readonly height: number;
  readonly capture: VisualCaptureMode;
  readonly output?: string;
  readonly outputDirectory: string;
  readonly build: boolean;
  readonly help: boolean;
  readonly list: boolean;
}

const defaultOptions: VisualCaptureOptions = {
  state: "default",
  theme: "dark",
  width: 1280,
  height: 900,
  capture: "region",
  outputDirectory: resolve(".visual-captures"),
  build: true,
  help: false,
  list: false,
};

export function parseVisualCaptureArguments(
  arguments_: readonly string[],
  cwd = process.cwd(),
): VisualCaptureOptions {
  let options = { ...defaultOptions, outputDirectory: resolve(cwd, ".visual-captures") };
  const positionals: string[] = [];
  let outputSeen = false;
  let outputDirectorySeen = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--help" || argument === "-h") options = { ...options, help: true };
    else if (argument === "--list") options = { ...options, list: true };
    else if (argument === "--no-build") options = { ...options, build: false };
    else if (argument.startsWith("--")) {
      const equal = argument.indexOf("=");
      const name = equal < 0 ? argument : argument.slice(0, equal);
      const inlineValue = equal < 0 ? undefined : argument.slice(equal + 1);
      const value = inlineValue ?? arguments_[index + 1];
      if (inlineValue === undefined) index += 1;
      if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
      if (name === "--output") outputSeen = true;
      if (name === "--output-dir") outputDirectorySeen = true;
      options = applyOption(options, name, value, cwd);
    } else positionals.push(argument);
  }

  if (positionals.length > 1)
    throw new Error(`Expected one scenario, received: ${positionals.join(", ")}`);
  if (outputSeen && outputDirectorySeen)
    throw new Error("Use either --output or --output-dir, not both");
  if (!options.help && !options.list && positionals.length === 0)
    throw new Error("A scenario is required. Use --list to see available scenarios.");

  return { ...options, scenario: positionals[0] };
}

function applyOption(
  options: VisualCaptureOptions,
  name: string,
  value: string,
  cwd: string,
): VisualCaptureOptions {
  switch (name) {
    case "--state":
      return { ...options, state: value };
    case "--theme":
      if (!isVisualCaptureTheme(value))
        throw new Error(`--theme must be one of: ${visualCaptureThemes.join(", ")}`);
      return { ...options, theme: value };
    case "--width":
      return { ...options, width: parseDimension(name, value) };
    case "--height":
      return { ...options, height: parseDimension(name, value) };
    case "--capture":
      if (!isVisualCaptureMode(value))
        throw new Error(`--capture must be one of: ${visualCaptureModes.join(", ")}`);
      return { ...options, capture: value };
    case "--output":
      return { ...options, output: resolve(cwd, value) };
    case "--output-dir":
      return { ...options, outputDirectory: resolve(cwd, value) };
    default:
      throw new Error(`Unknown option: ${name}`);
  }
}

function isVisualCaptureTheme(value: string): value is VisualCaptureTheme {
  return value === "light" || value === "dark";
}

function isVisualCaptureMode(value: string): value is VisualCaptureMode {
  return value === "region" || value === "window";
}

function parseDimension(name: string, value: string) {
  const dimension = Number(value);
  if (!Number.isInteger(dimension) || dimension < 320 || dimension > 3840)
    throw new Error(`${name} must be an integer between 320 and 3840`);
  return dimension;
}

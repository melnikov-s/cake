import type { Readable, Writable } from "node:stream";
import type { Interface } from "node:readline";

export function forwardSwiftBuildDiagnostics(input: Readable, output: Writable): Interface;

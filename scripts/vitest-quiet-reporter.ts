import type { Reporter, SerializedError, TestModule, TestRunEndReason } from "vitest/node";

const MAX_DETAIL_LINES = 40;

function describeError(error: SerializedError): string {
  const name = typeof error.name === "string" && error.name.length > 0 ? `${error.name}: ` : "";
  return `${name}${error.message}`;
}

function capLines(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= MAX_DETAIL_LINES) return text;
  return [
    ...lines.slice(0, MAX_DETAIL_LINES),
    `… (${lines.length - MAX_DETAIL_LINES} more lines; full output: pnpm test --reporter=default)`,
  ].join("\n");
}

function errorDetail(error: SerializedError): string {
  const message = describeError(error);
  const diff = typeof error.diff === "string" && error.diff.length > 0 ? error.diff : undefined;
  return capLines(diff ? `${message}\n${diff}` : message);
}

function describeFailure(entity: string, error: SerializedError): string {
  return `FAIL ${entity}\n${errorDetail(error)}`;
}

/**
 * Reporter tuned for agent runs: one summary line when everything passes, and
 * only the failing tests otherwise. Console logs from tests are suppressed;
 * `pnpm test --reporter=default` restores vitest's full output.
 */
export default class QuietReporter implements Reporter {
  private startedAt = 0;

  onTestRunStart(): void {
    this.startedAt = Date.now();
  }

  onUserConsoleLog(): void {}

  onTestRunEnd(
    testModules: ReadonlyArray<TestModule>,
    unhandledErrors: ReadonlyArray<SerializedError>,
    reason: TestRunEndReason,
  ): void {
    const duration = `${((Date.now() - this.startedAt) / 1000).toFixed(1)}s`;
    let passed = 0;
    let skipped = 0;
    const failures: string[] = [];
    for (const testModule of testModules) {
      for (const error of testModule.errors())
        failures.push(describeFailure(testModule.relativeModuleId, error));
      for (const testCase of testModule.children.allTests()) {
        const result = testCase.result();
        if (result.state === "passed") {
          passed += 1;
        } else if (result.state === "skipped") {
          skipped += 1;
        } else if (result.state === "failed") {
          const location = testCase.location;
          const at = location ? `:${location.line}:${location.column}` : "";
          for (const error of result.errors)
            failures.push(
              describeFailure(`${testModule.relativeModuleId}${at} > ${testCase.fullName}`, error),
            );
        }
      }
    }

    if (reason === "passed" && failures.length === 0 && unhandledErrors.length === 0) {
      const skippedNote = skipped > 0 ? `, ${skipped} skipped` : "";
      console.log(
        `✓ ${passed} tests passed across ${testModules.length} files${skippedNote} in ${duration}`,
      );
      return;
    }

    console.log(
      `${reason === "interrupted" ? "✗ Test run interrupted" : "✗ Test run failed"} in ${duration}\n`,
    );
    for (const failure of failures) console.log(`${failure}\n`);
    for (const error of unhandledErrors) console.log(`Unhandled error\n${errorDetail(error)}\n`);
    console.log("Full output: pnpm test --reporter=default");
  }
}

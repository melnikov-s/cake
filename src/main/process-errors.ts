interface ProcessErrors {
  on(event: "uncaughtException" | "unhandledRejection", listener: (error: unknown) => void): void;
}

/** Replace Electron's unparented exception dialog with Cake's acknowledged fatal report. */
export function installProcessErrorHandlers(
  process: ProcessErrors,
  report: (details: string) => Promise<void>,
  exit: () => void,
) {
  let reporting = false;
  const failed = (error: unknown) => {
    const details = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error("[cake.main] Unhandled process error", details);
    if (reporting) return;
    reporting = true;
    void report(details)
      .catch((cause: unknown) => {
        console.error("[cake.main] Could not display fatal error", cause);
      })
      .finally(exit);
  };
  process.on("uncaughtException", failed);
  process.on("unhandledRejection", failed);
}

/** A disconnected launcher must not turn diagnostic output into a desktop error dialog.
 * Keep every other stream failure visible; this is not a process-wide exception handler.
 */
export function installStdioErrorHandlers(...streams: readonly NodeJS.WritableStream[]) {
  for (const stream of streams) {
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") throw error;
    });
  }
}

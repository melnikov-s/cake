/**
 * Cake itself may run inside an Electron run admission (`pnpm dev`, `pnpm start`, E2E tests).
 * Work Cake starts afterwards (Project Session shell tools, terminals) is the user's own work:
 * a `pnpm test:electron:run` there must take its own admission, not nest in the run that
 * happened to launch this application. Drop the run's markers before anything spawns.
 */
const launchingRunVariables = [
  "CAKE_ELECTRON_QUEUE_SOCKET",
  "CAKE_ELECTRON_RUN_PARENT",
  "CAKE_QUEUED_ELECTRON_EXECUTABLE",
  "CAKE_ELECTRON_QUEUE_ALONGSIDE",
  "CAKE_VALIDATION_RUN",
] as const;

export function leaveLaunchingRun(env: NodeJS.ProcessEnv) {
  for (const name of launchingRunVariables) delete env[name];
}

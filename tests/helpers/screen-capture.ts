import type {
  CaptureRouting,
  CaptureSessionOption,
} from "../../src/contracts/desktop/screen-capture-data";

export function captureSession(
  sessionId: string,
  title: string,
  overrides: Partial<CaptureSessionOption> = {},
): CaptureSessionOption {
  return {
    sessionId,
    title,
    modifiedAt: new Date(0).toISOString(),
    activityTime: "1h",
    labels: [],
    familyCollapsed: false,
    ...overrides,
  };
}

export const captureRouting: CaptureRouting = {
  appearance: { theme: "dark", sessionAvatarsEnabled: true, sidebarCharactersEnabled: false },
  projects: [
    {
      path: "/project",
      name: "Project",
      sessions: [captureSession("alpha", "Session A"), captureSession("beta", "Session B")],
    },
    { path: "/other", name: "Other Project", sessions: [captureSession("gamma", "Session C")] },
  ],
  cakeChats: [],
  defaultDestination: { kind: "project-session", sessionId: "alpha" },
};

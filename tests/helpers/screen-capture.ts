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
  appearance: {
    theme: "dark",
    projectAvatarsEnabled: true,
    sessionAvatarsEnabled: true,
    sidebarCharactersEnabled: false,
  },
  dictation: {
    enabled: false,
    deviceId: "",
    textProcessingMode: "raw",
    recognition: {
      thresholds: { start: 0.6, continuation: 0.4 },
      minimumSpeechMs: 200,
      prerollMs: 600,
      maximumUtteranceSeconds: 30,
    },
  },
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

import type { CaptureRouting } from "../../src/contracts/desktop/screen-capture-data";

export const captureRouting: CaptureRouting = {
  projects: [
    {
      path: "/project",
      name: "Project",
      sessions: [
        { sessionId: "alpha", title: "Session A" },
        { sessionId: "beta", title: "Session B" },
      ],
    },
    {
      path: "/other",
      name: "Other Project",
      sessions: [{ sessionId: "gamma", title: "Session C" }],
    },
  ],
  cakeChats: [],
  defaultDestination: { kind: "project-session", sessionId: "alpha" },
};

export const cakeSlotNames = [
  "global.sidebar.header",
  "global.sidebar.footer",
  "project-session.header.actions",
  "project-session.content.top-right",
  "project-session.transcript.after",
  "project-session.composer.before",
  "project-session.composer.actions",
  "project-session.status"
] as const;

export type CakeSlotName = typeof cakeSlotNames[number];

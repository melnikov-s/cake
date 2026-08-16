export const cakeSlotNames = [
  "global.sidebar.header",
  "global.sidebar.footer",
  "project-session.header.actions",
  "project-session.left.top",
  "project-session.left.middle",
  "project-session.left.bottom",
  "project-session.right.top",
  "project-session.right.middle",
  "project-session.right.bottom",
  "project-session.transcript.after",
  "project-session.composer.before",
  "project-session.composer.actions",
  "project-session.status"
] as const;

export type CakeSlotName = typeof cakeSlotNames[number];

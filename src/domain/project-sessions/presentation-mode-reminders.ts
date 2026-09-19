import type { ProjectSessionPresentationMode } from "./project-session-presentation";

const reminders = {
  enterVscode: `<system-reminder>
The user has entered embedded VS Code. They may now be looking at the editor. Use Cake's VS Code operations when they would help.
</system-reminder>`,
  enterDraw: `<system-reminder>
The user has entered Draw. They may now be looking at the active whiteboard. Use Cake's Draw operations when they would help.
</system-reminder>`,
  returnToNormal: `<system-reminder>
The user has returned to the normal conversation view and is no longer viewing embedded VS Code or Draw.
</system-reminder>`,
  vscodeToDraw: `<system-reminder>
The user has switched from embedded VS Code to Draw. They may now be looking at the active whiteboard. Use Cake's Draw operations when they would help.
</system-reminder>`,
  drawToVscode: `<system-reminder>
The user has switched from Draw to embedded VS Code. They may now be looking at the editor. Use Cake's VS Code operations when they would help.
</system-reminder>`,
} as const;

type Reminder = {
  readonly mode: ProjectSessionPresentationMode;
  readonly content: string;
};

const knownReminders: readonly Reminder[] = [
  { mode: "vscode", content: reminders.enterVscode },
  { mode: "draw", content: reminders.enterDraw },
  { mode: "normal", content: reminders.returnToNormal },
  { mode: "draw", content: reminders.vscodeToDraw },
  { mode: "vscode", content: reminders.drawToVscode },
];

export function presentationModeFromReminder(
  text: string,
): ProjectSessionPresentationMode | undefined {
  return knownReminders.find(({ content }) => text.startsWith(content))?.mode;
}

export function stripPresentationModeReminder(text: string): string {
  const reminder = knownReminders.find(({ content }) => text.startsWith(content));
  if (!reminder) return text;
  return text.slice(reminder.content.length).replace(/^\n{1,2}/, "");
}

export function addPresentationModeReminder(
  text: string,
  previousMode: ProjectSessionPresentationMode,
  currentMode: ProjectSessionPresentationMode,
): string {
  if (currentMode === previousMode) return text;
  const reminder =
    currentMode === "normal"
      ? reminders.returnToNormal
      : currentMode === "vscode"
        ? previousMode === "draw"
          ? reminders.drawToVscode
          : reminders.enterVscode
        : previousMode === "vscode"
          ? reminders.vscodeToDraw
          : reminders.enterDraw;
  return `${reminder}${text ? `\n\n${text}` : ""}`;
}

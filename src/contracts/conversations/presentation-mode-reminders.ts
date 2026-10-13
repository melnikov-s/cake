import type { ProjectSessionPresentationMode } from "../project-sessions/project-session-presentation";

const reminders = {
  enterVscode: `<system-reminder>
The user has entered embedded VS Code. They may now be looking at the editor. Use Cake's VS Code operations when they would help.
</system-reminder>`,
  enterBrowser: `<system-reminder>
The user has entered Browser Mode. They may now be looking at the embedded browser. Use Cake's browser CDP operations when they would help.
</system-reminder>`,
  returnToNormal: `<system-reminder>
The user has returned to the normal conversation view and is no longer viewing embedded VS Code or Browser Mode.
</system-reminder>`,
} as const;

type Reminder = {
  readonly mode: ProjectSessionPresentationMode;
  readonly content: string;
};

const knownReminders: readonly Reminder[] = [
  { mode: "vscode", content: reminders.enterVscode },
  { mode: "browser", content: reminders.enterBrowser },
  { mode: "normal", content: reminders.returnToNormal },
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
      : currentMode === "browser"
        ? reminders.enterBrowser
        : reminders.enterVscode;
  return `${reminder}${text ? `\n\n${text}` : ""}`;
}

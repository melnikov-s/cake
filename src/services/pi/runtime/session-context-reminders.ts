import {
  responseModeReminders,
  stripResponseModeReminder,
} from "../../../contracts/conversations/response-mode-reminders";
import { stripPresentationModeReminder } from "../../../contracts/conversations/presentation-mode-reminders";
import {
  projectTodoContextPresentation,
  splitProjectTodoReminder,
} from "../../../contracts/projects/project-todo-context";
import { splitSessionDigestReminder } from "../../../contracts/cake-chats/session-digest-reminder";
import { splitReferenceNotifications } from "../../../contracts/conversations/reference-notification";

/** Only remove Cake-owned blocks at their injection boundaries, never user-authored tags. */
export function splitContextReminders(text: string) {
  const withoutResponse = stripResponseModeReminder(text);
  const withoutPresentation = stripPresentationModeReminder(withoutResponse);
  const references = splitReferenceNotifications(withoutPresentation);
  const digest = splitSessionDigestReminder(references.text);
  const todos = splitProjectTodoReminder(digest.text);
  const body = todos.text;
  const reminders: { title: string; text: string }[] = [];
  if (withoutPresentation !== withoutResponse) {
    const block = withoutResponse.match(/^<system-reminder>[\s\S]*?<\/system-reminder>/)?.[0];
    if (block) reminders.push({ title: "Cake · presentation mode", text: block });
  }
  if (references.reminder)
    reminders.push({ title: "Cake · reference notifications", text: references.reminder });
  if (digest.reminder) reminders.push({ title: "Cake · session updates", text: digest.reminder });
  if (todos.reminder) reminders.push(projectTodoContextPresentation(todos.reminder));
  if (withoutResponse !== text) {
    const block = Object.values(responseModeReminders).find((reminder) => text.includes(reminder));
    if (block) reminders.push({ title: "Cake · response mode", text: block });
  }
  return { text: body, reminders };
}

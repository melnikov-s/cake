import {
  responseModeReminders,
  stripResponseModeReminder,
} from "../../../contracts/conversations/response-mode-reminders";
import { stripPresentationModeReminder } from "../../../contracts/conversations/presentation-mode-reminders";

/** Only remove Cake-owned blocks at their injection boundaries, never user-authored tags. */
export function splitContextReminders(text: string) {
  const withoutResponse = stripResponseModeReminder(text);
  const body = stripPresentationModeReminder(withoutResponse);
  const reminders: { title: string; text: string }[] = [];
  if (body !== withoutResponse) {
    const block = withoutResponse.match(/^<system-reminder>[\s\S]*?<\/system-reminder>/)?.[0];
    if (block) reminders.push({ title: "Cake · presentation mode", text: block });
  }
  if (withoutResponse !== text) {
    const block = Object.values(responseModeReminders).find((reminder) => text.includes(reminder));
    if (block) reminders.push({ title: "Cake · response mode", text: block });
  }
  return { text: body, reminders };
}

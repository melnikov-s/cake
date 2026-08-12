export const MAX_SESSION_TITLE_LENGTH = 40;

export function displaySessionTitle(title: string) {
  const characters = Array.from(title);
  if (characters.length <= MAX_SESSION_TITLE_LENGTH) return title;
  return `${characters.slice(0, MAX_SESSION_TITLE_LENGTH - 1).join("").trimEnd()}…`;
}

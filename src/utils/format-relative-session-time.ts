const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

export function formatRelativeSessionTime(modified: string, now = Date.now()) {
  const timestamp = Date.parse(modified);
  if (!Number.isFinite(timestamp)) return "";
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < minute) return "Now";
  if (elapsed < hour) return `${Math.floor(elapsed / minute)} min ago`;
  if (elapsed < day) {
    const hours = Math.floor(elapsed / hour);
    return `${hours} ${hours === 1 ? "hr" : "hrs"} ago`;
  }
  if (elapsed < 7 * day) {
    const days = Math.floor(elapsed / day);
    return `${days} ${days === 1 ? "day" : "days"} ago`;
  }
  const date = new Date(timestamp);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (!sameYear) options.year = "numeric";
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

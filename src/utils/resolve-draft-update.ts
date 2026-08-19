export function resolveDraftUpdate(value: string | ((current: string) => string), current: string) {
  return value instanceof Function ? value(current) : value;
}

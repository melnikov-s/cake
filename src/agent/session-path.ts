import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function assertSessionPath(sessionFile: string, sessionRoot: string, label: string) {
  const pathFromRoot = relative(resolve(sessionRoot), resolve(dirname(sessionFile)));
  if (isAbsolute(pathFromRoot) || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) {
    throw new Error(`${label} is outside Cake's Pi session directory`);
  }
}

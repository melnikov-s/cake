import { Model, id } from "r-state-tree";

export class Project extends Model {
  @id
  path = "";
  name = "";
  addedAt = "";
  lastOpenedAt = "";

  rename(name: string) {
    const next = name.trim();
    if (next) this.name = next.slice(0, 512);
  }

  touch(at = new Date().toISOString()) {
    this.lastOpenedAt = at;
  }
}

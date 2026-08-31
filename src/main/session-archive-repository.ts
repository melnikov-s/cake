import { access, mkdir, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  cakeWorkspaceSessionDirectory,
  findSessionFile,
} from "../services/pi/runtime/session-discovery";

export interface SessionArchiveLocation {
  cwd: string;
  activeRoot: string;
  resolvedRoot: string;
  direct?: boolean;
}

/** Moves settled Pi transcripts between the active namespace and Cake's read-only archive. */
export class SessionArchiveRepository {
  async resolve(sessionId: string, location: SessionArchiveLocation) {
    return this.move(sessionId, location, true);
  }

  async restore(sessionId: string, location: SessionArchiveLocation) {
    return this.move(sessionId, location, false);
  }

  async deleteResolved(sessionId: string, location: SessionArchiveLocation) {
    const source = await findSessionFile(
      location.cwd,
      sessionId,
      location.resolvedRoot,
      location.direct,
    );
    if (!source) throw new Error(`Cake could not find resolved session ${sessionId}`);
    await rm(source);
  }

  /** Permanently deletes a transcript from either the active or resolved namespace. */
  async delete(sessionId: string, location: SessionArchiveLocation) {
    const active = await findSessionFile(
      location.cwd,
      sessionId,
      location.activeRoot,
      location.direct,
    );
    const resolved = await findSessionFile(
      location.cwd,
      sessionId,
      location.resolvedRoot,
      location.direct,
    );
    if (active && resolved) throw new Error(`Session ${sessionId} exists in both namespaces`);
    const source = active ?? resolved;
    if (!source) throw new Error(`Cake could not find session ${sessionId}`);
    await rm(source);
  }

  private async move(
    sessionId: string,
    location: SessionArchiveLocation,
    resolved: boolean,
  ): Promise<boolean> {
    const activeDirectory = location.direct
      ? resolve(location.activeRoot)
      : cakeWorkspaceSessionDirectory(location.cwd, location.activeRoot);
    const resolvedDirectory = location.direct
      ? resolve(location.resolvedRoot)
      : cakeWorkspaceSessionDirectory(location.cwd, location.resolvedRoot);
    const destinationDirectory = resolved ? resolvedDirectory : activeDirectory;
    const source = await findSessionFile(
      location.cwd,
      sessionId,
      resolved ? location.activeRoot : location.resolvedRoot,
      location.direct,
    );
    if (!source) {
      const alreadyMoved = await findSessionFile(
        location.cwd,
        sessionId,
        resolved ? location.resolvedRoot : location.activeRoot,
        location.direct,
      );
      if (alreadyMoved) return false;
      throw new Error(`Cake could not find session ${sessionId}`);
    }
    await mkdir(destinationDirectory, { recursive: true });
    const destination = join(destinationDirectory, basename(source));
    try {
      await access(destination);
      throw new Error(`Session archive destination already exists for ${sessionId}`);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await rename(source, destination);
    return true;
  }
}

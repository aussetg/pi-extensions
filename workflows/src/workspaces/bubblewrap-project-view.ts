import fs from "node:fs";
import path from "node:path";

export type BubblewrapProjectView = "inspection" | "temporary";

/**
 * Build the one project-mount fragment used by contained effects. Inspection
 * gets an immutable bind. Temporary commands/builds get an in-memory overlay;
 * Bubblewrap discards its upper layer with the sandbox mount namespace.
 */
export function bubblewrapProjectViewArgs(
  snapshotRootInput: string,
  sandboxDestinationInput: string,
  view: BubblewrapProjectView,
): string[] {
  if (!path.isAbsolute(snapshotRootInput)) throw new Error("Project snapshot root must be absolute");
  const snapshotRoot = path.resolve(snapshotRootInput);
  const sandboxDestination = path.posix.normalize(sandboxDestinationInput);
  if (
    !path.posix.isAbsolute(sandboxDestinationInput)
    || sandboxDestination === "/"
    || sandboxDestination !== sandboxDestinationInput
  ) {
    throw new Error("Bubblewrap project destination must be an absolute non-root path");
  }
  const stat = fs.lstatSync(snapshotRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Project snapshot root must be a real directory");
  if (view === "inspection") return ["--ro-bind", snapshotRoot, sandboxDestination];
  if (view === "temporary") return ["--overlay-src", snapshotRoot, "--tmp-overlay", sandboxDestination];
  throw new Error(`Unsupported Bubblewrap project view ${String(view)}`);
}

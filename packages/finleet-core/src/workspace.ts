import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { fail, type Result } from "./domain.js";

export type WorkspaceMode = "shared" | "isolated";

export interface WorkspaceRequest {
  workingDirectory: string;
  mode?: WorkspaceMode;
  /** Set by the host after obtaining the user's authorization. */
  authorized?: boolean;
}

interface SharedWorkspace {
  readonly id: string;
  readonly mode: "shared";
  readonly workingDirectory: string;
  readonly worktreeDirectory?: never;
  readonly baseCommit?: never;
}

interface IsolatedWorkspace {
  readonly id: string;
  readonly mode: "isolated";
  readonly workingDirectory: string;
  readonly worktreeDirectory: string;
  readonly baseCommit: string;
}

export type Workspace = SharedWorkspace | IsolatedWorkspace;

type OwnedWorkspace = SharedWorkspace | (IsolatedWorkspace & { readonly repositoryDirectory: string });

export type WorkspaceCleanup = { status: "removed" | "retained" | "released"; reason?: string };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitDirectory(cwd: string, option: string): string {
  return realpathSync(git(cwd, "rev-parse", "--path-format=absolute", option).replace(/\r?\n$/, ""));
}

/**
 * Validate an existing, explicitly user-selected linked worktree. The selection
 * must belong to the same repository and be a different checkout from the
 * source. Nested directories are accepted and returned as canonical paths.
 *
 * This is a read-only selection, suitable for hosts that run in separate
 * processes. It does not adopt the worktree, authorize any job or tool, or
 * grant permission to remove it. The user remains responsible for its lifecycle.
 */
export function validateExistingWorkspace(sourceDirectory: string, selectedDirectory: string): Result<string> {
  try {
    const source = realpathSync(sourceDirectory);
    const selected = realpathSync(selectedDirectory);
    if (!statSync(source).isDirectory() || !statSync(selected).isDirectory()) {
      return fail("WORKSPACE_DIRECTORY_INVALID", "Source and selected workspace must be directories");
    }
    const sourceRoot = gitDirectory(source, "--show-toplevel");
    const selectedRoot = gitDirectory(selected, "--show-toplevel");
    const common = gitDirectory(source, "--git-common-dir");
    if (sourceRoot === selectedRoot || gitDirectory(selected, "--git-common-dir") !== common ||
        gitDirectory(selected, "--git-dir") === common) {
      return fail("WORKSPACE_SELECTION_INVALID", "Select a different linked worktree in the same repository");
    }
    const worktrees = git(source, "worktree", "list", "--porcelain", "-z");
    if (!worktrees.split("\0").some((field) => field === `worktree ${selectedRoot}`)) {
      return fail("WORKSPACE_SELECTION_INVALID", "Selected workspace is not registered with the repository");
    }
    return { ok: true, value: selected };
  } catch {
    return fail("WORKSPACE_SELECTION_INVALID", "Could not validate the selected Git worktree");
  }
}

/**
 * Owns workspaces allocated during this host process. Call cleanup explicitly
 * after execution has stopped; allocation never implies permission to clean up.
 * Ownership is not persisted across CLI invocations. Use validateExistingWorkspace
 * for read-only selection of a user-managed worktree in a new process.
 */
export class WorkspaceManager {
  private readonly workspaces = new Map<string, OwnedWorkspace>();

  constructor(private readonly workspaceRoot = tmpdir()) {}

  allocate(request: WorkspaceRequest): Result<Workspace> {
    const mode = request.mode ?? "shared";
    if (mode !== "shared" && mode !== "isolated") return fail("WORKSPACE_MODE_INVALID", "Unknown workspace mode");
    if (mode === "isolated" && request.authorized !== true) {
      return fail("WORKSPACE_AUTHORIZATION_REQUIRED", "Creating an isolated workspace requires user authorization");
    }

    let worktreeDirectory: string | undefined;
    try {
      const workingDirectory = realpathSync(request.workingDirectory);
      if (!statSync(workingDirectory).isDirectory()) return fail("WORKSPACE_DIRECTORY_INVALID", "Working directory must be a directory");
      const id = randomUUID();
      if (mode === "shared") {
        const workspace = Object.freeze({ id, mode, workingDirectory });
        this.workspaces.set(id, workspace);
        return { ok: true, value: workspace };
      }

      const repositoryDirectory = realpathSync(git(workingDirectory, "rev-parse", "--show-toplevel").replace(/\r?\n$/, ""));
      const baseCommit = git(repositoryDirectory, "rev-parse", "--verify", "HEAD^{commit}").trim();
      const subdirectory = relative(repositoryDirectory, workingDirectory);
      if (subdirectory !== "" && git(repositoryDirectory, "cat-file", "-t", `${baseCommit}:${subdirectory}`).trim() !== "tree") {
        return fail("WORKSPACE_DIRECTORY_INVALID", "Working directory must exist in the base commit");
      }
      const root = realpathSync(this.workspaceRoot);
      const rootRelative = relative(repositoryDirectory, root);
      if (!isAbsolute(rootRelative) && rootRelative !== ".." && !rootRelative.startsWith(`..${sep}`)) {
        // Keep worktrees outside the source checkout so they never appear as its untracked files.
        return fail("WORKSPACE_ROOT_INVALID", "Workspace root must be outside the source checkout");
      }
      worktreeDirectory = mkdtempSync(join(root, "finleet-workspace-"));
      git(repositoryDirectory, "worktree", "add", "--detach", "--", worktreeDirectory, baseCommit);
      const workspace: OwnedWorkspace = Object.freeze({
        id,
        mode,
        repositoryDirectory,
        baseCommit,
        worktreeDirectory,
        workingDirectory: join(worktreeDirectory, subdirectory),
      });
      this.workspaces.set(id, workspace);
      return { ok: true, value: workspace };
    } catch {
      if (worktreeDirectory !== undefined) {
        // Never recursively delete a partially created worktree.
        try { rmdirSync(worktreeDirectory); } catch { /* Leave nonempty directories for recovery. */ }
        if (existsSync(worktreeDirectory)) {
          return fail("WORKSPACE_ALLOCATION_FAILED", `Could not allocate workspace; partial checkout retained at ${worktreeDirectory}`);
        }
      }
      return fail("WORKSPACE_ALLOCATION_FAILED", "Could not allocate workspace");
    }
  }

  cleanup(id: string, authorized: boolean): Result<WorkspaceCleanup> {
    const workspace = this.workspaces.get(id);
    if (workspace === undefined) return fail("WORKSPACE_NOT_FOUND", "Workspace is not owned by this manager");
    if (workspace.mode === "shared") {
      this.workspaces.delete(id);
      return { ok: true, value: { status: "released" } };
    }
    if (authorized !== true) return fail("WORKSPACE_AUTHORIZATION_REQUIRED", "Removing an isolated workspace requires user authorization");
    try {
      // Include ignored files too: they may contain useful uncommitted output.
      if (git(workspace.worktreeDirectory, "status", "--porcelain=v1", "--untracked-files=all", "--ignored", "--ignore-submodules=none") !== "") {
        return { ok: true, value: { status: "retained", reason: "Workspace has uncommitted or untracked files" } };
      }
      const head = git(workspace.worktreeDirectory, "rev-parse", "--verify", "HEAD^{commit}").trim();
      try {
        git(workspace.repositoryDirectory, "merge-base", "--is-ancestor", head, "HEAD");
      } catch {
        return { ok: true, value: { status: "retained", reason: "Workspace commits are not integrated into the source checkout" } };
      }
      git(workspace.repositoryDirectory, "worktree", "remove", "--", workspace.worktreeDirectory);
      this.workspaces.delete(id);
      return { ok: true, value: { status: "removed" } };
    } catch {
      return { ok: true, value: { status: "retained", reason: "Could not safely remove workspace" } };
    }
  }
}

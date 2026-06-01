import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_MAX_BYTES } from "../constants.js";
import { parseWorkflowScript } from "../runtime/parser.js";
import { projectWorkflowDir, userWorkflowDir } from "./paths.js";
import { readBoundedTextFile } from "./safe-paths.js";

export interface WorkflowRef {
  name: string;
  source: "built-in" | "package" | "user" | "project";
  path: string;
  description?: string;
  error?: string;
}

export class WorkflowRegistry {
  private refs = new Map<string, WorkflowRef>();
  private invalid: WorkflowRef[] = [];

  async refresh(cwd: string): Promise<void> {
    const refs = new Map<string, WorkflowRef>();
    const invalid: WorkflowRef[] = [];
    const addDir = async (dir: string, source: WorkflowRef["source"]) => {
      for (const filePath of await listJsFiles(dir)) {
        const ref = await loadRef(filePath, source);
        if (ref.error) invalid.push(ref);
        else refs.set(ref.name, ref);
      }
    };

    await addDir(builtinsDir(), "built-in");
    await addDir(packageWorkflowDir(), "package");
    await addDir(userWorkflowDir(), "user");
    await addDir(projectWorkflowDir(cwd), "project");

    this.refs = refs;
    this.invalid = invalid;
  }

  list(): WorkflowRef[] {
    return [...this.refs.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  listInvalid(): WorkflowRef[] {
    return [...this.invalid].sort((a, b) => a.path.localeCompare(b.path));
  }

  get(name: string): WorkflowRef | undefined {
    return this.refs.get(name);
  }
}

async function listJsFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

async function loadRef(filePath: string, source: WorkflowRef["source"]): Promise<WorkflowRef> {
  try {
    const text = await readBoundedTextFile(filePath, SCRIPT_MAX_BYTES);
    const parsed = parseWorkflowScript(text);
    return { name: parsed.meta.name, description: parsed.meta.description, path: filePath, source };
  } catch (err) {
    return { name: path.basename(filePath, ".js"), path: filePath, source, error: (err as Error).message };
  }
}

function builtinsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "builtins");
}

function packageWorkflowDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "workflows");
}

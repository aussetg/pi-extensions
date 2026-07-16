import * as fs from "node:fs";
import * as path from "node:path";
import { walkUpInsideProject } from "./command-path.ts";
import { statIfExists } from "./fs.ts";
import { displayPathFromRoot, isInsideOrEqual } from "./paths.ts";

export type LanguageEnvironmentKind = "venv" | "uv" | "conda";

export interface LanguageEnvironment {
  language: "python";
  kind: LanguageEnvironmentKind;
  root: string;
  binDirs: string[];
  executable?: string;
  env: NodeJS.ProcessEnv;
  key: string;
  description: string;
}

const PYTHON_ENV_DIR_NAMES = [".venv", "venv", "env"];
const PYTHON_BIN_DIR = process.platform === "win32" ? "Scripts" : "bin";
const PYTHON_EXECUTABLE_NAMES = process.platform === "win32" ? ["python.exe", "python"] : ["python", "python3"];
const PYTHON_ENV_SCRUB_KEYS = [
  "CONDA_DEFAULT_ENV",
  "CONDA_PREFIX",
  "CONDA_PROMPT_MODIFIER",
  "CONDA_SHLVL",
  "PIPENV_ACTIVE",
  "PYENV_VERSION",
  "PYTHONHOME",
  "PYTHONPATH",
  "PYTHONUSERBASE",
  "VIRTUAL_ENV",
];

export function resolvePythonEnvironment(filePath: string, projectRoot: string, trustedRoots: string[] = []): LanguageEnvironment | undefined {
  const startDir = directoryForPath(filePath);
  const root = path.resolve(projectRoot);
  const searchRoots = containingSearchRoots(startDir, root, trustedRoots);
  const searchedDirs = new Set<string>();

  for (const searchRoot of searchRoots) {
    for (const dir of walkUpInsideProject(startDir, searchRoot)) {
      if (searchedDirs.has(dir)) continue;
      searchedDirs.add(dir);

      const declared = resolveDeclaredDotVenv(dir);
      if (declared) return createPythonEnvironment(declared, root);

      for (const name of PYTHON_ENV_DIR_NAMES) {
        const candidate = resolvePythonEnvironmentRoot(path.join(dir, name));
        if (candidate) return createPythonEnvironment(candidate, root);
      }
    }
  }

  const trustedBoundaryRoots = [root, ...trustedRoots.map((trustedRoot) => path.resolve(trustedRoot))];
  const activeVenv = process.env.VIRTUAL_ENV ? resolvePythonEnvironmentRoot(process.env.VIRTUAL_ENV) : undefined;
  if (activeVenv && isInsideAnyRoot(activeVenv, trustedBoundaryRoots)) return createPythonEnvironment(activeVenv, root);

  const activeConda = process.env.CONDA_PREFIX ? resolvePythonEnvironmentRoot(process.env.CONDA_PREFIX) : undefined;
  if (activeConda && isInsideAnyRoot(activeConda, trustedBoundaryRoots)) return createPythonEnvironment(activeConda, root);

  return undefined;
}

export function mergeProcessEnv(overlay: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv | undefined {
  if (!overlay) return undefined;
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

export function resolveWorkspaceRootForPath(filePath: string, projectRoot: string, trustedRoots: string[] = []): string {
  const resolved = path.resolve(filePath);
  const candidates = [projectRoot, ...trustedRoots]
    .map((candidate) => path.resolve(candidate))
    .filter((candidate, index, all) => all.indexOf(candidate) === index)
    .filter((candidate) => isInsideOrEqual(resolved, candidate))
    .sort((left, right) => right.length - left.length);
  return candidates[0] ?? path.resolve(projectRoot);
}

function resolveDeclaredDotVenv(dir: string): string | undefined {
  const dotVenv = path.join(dir, ".venv");
  const stat = statIfExists(dotVenv);
  if (!stat) return undefined;

  if (stat.isDirectory()) return resolvePythonEnvironmentRoot(dotVenv);
  if (!stat.isFile()) return undefined;

  const declaration = readFirstLine(dotVenv);
  if (!declaration) return undefined;

  const candidate = path.isAbsolute(declaration) ? declaration : path.join(dir, declaration);
  return resolvePythonEnvironmentRoot(candidate);
}

function resolvePythonEnvironmentRoot(candidate: string): string | undefined {
  const resolved = path.resolve(candidate);
  if (!isDirectory(resolved)) return undefined;
  if (!pythonExecutable(resolved)) return undefined;
  if (!fs.existsSync(path.join(resolved, "pyvenv.cfg")) && !fs.existsSync(path.join(resolved, "conda-meta"))) return undefined;
  return resolved;
}

function createPythonEnvironment(root: string, projectRoot: string): LanguageEnvironment {
  const binDir = path.join(root, PYTHON_BIN_DIR);
  const executable = pythonExecutable(root);
  const kind = pythonEnvironmentKind(root);
  const env: NodeJS.ProcessEnv = {
    PATH: [binDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
  };

  for (const key of PYTHON_ENV_SCRUB_KEYS) env[key] = undefined;

  if (kind === "conda") {
    env.CONDA_PREFIX = root;
  } else {
    env.VIRTUAL_ENV = root;
  }

  const displayPath = displayPathFromRoot(root, projectRoot);
  return {
    language: "python",
    kind,
    root,
    binDirs: [binDir],
    executable,
    env,
    key: `python\0${kind}\0${root}`,
    description: `python ${kind}: ${displayPath}`,
  };
}

function pythonEnvironmentKind(root: string): LanguageEnvironmentKind {
  if (fs.existsSync(path.join(root, "conda-meta"))) return "conda";
  const parent = path.dirname(root);
  if (fs.existsSync(path.join(parent, "uv.lock"))) return "uv";
  return "venv";
}

function pythonExecutable(root: string): string | undefined {
  const binDir = path.join(root, PYTHON_BIN_DIR);
  for (const name of PYTHON_EXECUTABLE_NAMES) {
    const candidate = path.join(binDir, name);
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

function directoryForPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  const stat = statIfExists(resolved);
  return stat?.isDirectory() ? resolved : path.dirname(resolved);
}

function containingSearchRoots(startDir: string, projectRoot: string, trustedRoots: string[]): string[] {
  const candidates = [projectRoot, ...trustedRoots].map((candidate) => path.resolve(candidate));
  const unique = [...new Set(candidates)].filter((candidate) => isInsideOrEqual(startDir, candidate));
  return unique.sort((left, right) => right.length - left.length);
}

function isInsideAnyRoot(filePath: string, roots: string[]): boolean {
  return roots.some((root) => isInsideOrEqual(filePath, root));
}

function readFirstLine(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/, 1)[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function isDirectory(filePath: string): boolean {
  return statIfExists(filePath)?.isDirectory() === true;
}

function isFile(filePath: string): boolean {
  return statIfExists(filePath)?.isFile() === true;
}

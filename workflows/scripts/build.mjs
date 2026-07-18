import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(root, "src");
const output = path.join(root, "dist");
const temporary = path.join(root, `.dist-${process.pid}`);

await fs.promises.rm(temporary, { recursive: true, force: true });
await fs.promises.mkdir(temporary, { recursive: true });

try {
  for (const sourcePath of await files(sourceRoot)) {
    const relative = path.relative(root, sourcePath);
    if (sourcePath.endsWith(".d.ts") || sourcePath.endsWith(".flow.ts")) continue;
    if (sourcePath.endsWith(".ts")) {
      await emitTypeScript(sourcePath, path.join(temporary, relative.replace(/\.ts$/u, ".js")));
    } else if (sourcePath.endsWith(".js")) {
      await copy(sourcePath, path.join(temporary, relative));
    }
  }

  await copy(path.join(root, "workflow-api.d.ts"), path.join(temporary, "workflow-api.d.ts"));
  await fs.promises.cp(path.join(sourceRoot, "builtins"), path.join(temporary, "src", "builtins"), {
    recursive: true,
  });

  await fs.promises.rm(output, { recursive: true, force: true });
  await fs.promises.rename(temporary, output);
} catch (error) {
  await fs.promises.rm(temporary, { recursive: true, force: true });
  throw error;
}

async function files(directory) {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(child));
    else if (entry.isFile()) result.push(child);
  }
  return result;
}

async function emitTypeScript(sourcePath, targetPath) {
  const source = await fs.promises.readFile(sourcePath, "utf8");
  const emitted = ts.transpileModule(source, {
    fileName: sourcePath,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      verbatimModuleSyntax: true,
    },
  });
  const errors = (emitted.diagnostics ?? []).filter(diagnostic =>
    diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length) {
    throw new Error(ts.formatDiagnostics(errors, {
      getCanonicalFileName: fileName => fileName,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n",
    }));
  }
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.promises.writeFile(targetPath, emitted.outputText, "utf8");
}

async function copy(sourcePath, targetPath) {
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.promises.copyFile(sourcePath, targetPath);
}

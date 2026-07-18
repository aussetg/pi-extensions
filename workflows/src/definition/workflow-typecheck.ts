import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { WorkflowScriptError } from "../runtime/errors.js";
import { stableHash } from "../utils/hashes.js";
import { WORKFLOW_MODULE } from "./workflow-language.js";

const DEFAULT_API_PATH = fileURLToPath(new URL("../../workflow-api.d.ts", import.meta.url));

export interface WorkflowTypecheckOptions {
  fileName: string;
  apiPath?: string;
}

export interface WorkflowTypecheckSource {
  fileName: string;
  source: string;
}

export interface WorkflowTypecheckBatchOptions {
  apiPath?: string;
  /** Exact API bytes already read and hashed by registry discovery. */
  apiSource?: string;
}

export interface WorkflowTypecheckResult {
  fileName: string;
  error?: WorkflowScriptError;
}

/** Content identity for the exact runtime compiler and options. */
export const WORKFLOW_TYPECHECK_IDENTITY = stableHash({
  revision: 2,
  typescriptVersion: ts.version,
  compilerOptions: runtimeCompilerOptions(),
});

export function workflowTypecheckApiPath(apiPath?: string): string {
  return path.resolve(apiPath ?? DEFAULT_API_PATH);
}

/** Inspect syntax that Node's strip-only pass deliberately erases, especially type-only imports. */
export function validateWorkflowTypeScriptEnvelope(source: string, fileName: string): void {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const imports = file.statements.filter(ts.isImportDeclaration);
  const importEquals = file.statements.find(ts.isImportEqualsDeclaration);
  if (importEquals) throw nodeError(file, importEquals, "Import-equals declarations are unavailable");
  if (imports.length !== 1) {
    throw nodeError(
      file,
      imports[1] ?? imports[0] ?? file,
      `A workflow requires exactly one import from ${JSON.stringify(WORKFLOW_MODULE)}`,
    );
  }
  const declaration = imports[0]!;
  if (!ts.isStringLiteral(declaration.moduleSpecifier)
    || declaration.moduleSpecifier.text !== WORKFLOW_MODULE) {
    throw nodeError(
      file,
      declaration.moduleSpecifier,
      `Workflow imports are restricted to ${JSON.stringify(WORKFLOW_MODULE)}`,
    );
  }
  if (declaration.importClause?.name
    || (declaration.importClause?.namedBindings && !ts.isNamedImports(declaration.importClause.namedBindings))) {
    throw nodeError(file, declaration, "The virtual workflow module permits named imports only");
  }
  if (file.referencedFiles.length || file.typeReferenceDirectives.length || file.libReferenceDirectives.length) {
    throw new WorkflowScriptError("TypeScript reference directives are unavailable", { line: 1, column: 1 });
  }
  validateErasedTypeScriptDependencies(file);
  for (const statement of file.statements) {
    if (statement === declaration) continue;
    if (ts.isExportDeclaration(statement)) {
      throw nodeError(file, statement, "Named workflow exports are unavailable");
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      && !ts.isExportAssignment(statement)) {
      throw nodeError(file, statement, "Only the default workflow definition may be exported");
    }
  }
}

function validateErasedTypeScriptDependencies(file: ts.SourceFile): void {
  const visit = (node: ts.Node): void => {
    if (ts.isModuleDeclaration(node)) {
      throw nodeError(file, node, "Module and namespace declarations are unavailable");
    }
    if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (!ts.isLiteralTypeNode(argument)
        || !ts.isStringLiteral(argument.literal)
        || argument.literal.text !== WORKFLOW_MODULE) {
        throw nodeError(
          file,
          node,
          `Type imports are restricted to ${JSON.stringify(WORKFLOW_MODULE)}`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
}

/** Strictly typecheck one original `.flow.ts` module against the pinned virtual API. */
export function typecheckWorkflowSource(
  source: string,
  options: WorkflowTypecheckOptions,
): void {
  const [result] = typecheckWorkflowSources(
    [{ source, fileName: options.fileName }],
    options.apiPath ? { apiPath: options.apiPath } : {},
  );
  if (result?.error) throw result.error;
}

/** Strictly typecheck many original `.flow.ts` modules in one TypeScript program. */
export function typecheckWorkflowSources(
  inputs: readonly WorkflowTypecheckSource[],
  options: WorkflowTypecheckBatchOptions = {},
): WorkflowTypecheckResult[] {
  if (inputs.length === 0) return [];
  const apiPath = workflowTypecheckApiPath(options.apiPath);
  const apiKey = canonicalFileName(apiPath);
  const sources = new Map<string, { fileName: string; source: string }>();
  for (const input of inputs) {
    const fileName = path.resolve(input.fileName);
    const key = canonicalFileName(fileName);
    if (key === apiKey) throw new Error("Workflow source path collides with the public API declaration");
    if (sources.has(key)) throw new Error(`Duplicate workflow typecheck source ${fileName}`);
    sources.set(key, { fileName, source: input.source });
  }
  const compilerOptions = runtimeCompilerOptions();
  const host = ts.createCompilerHost(compilerOptions, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);

  host.fileExists = (candidate): boolean => {
    const key = canonicalFileName(candidate);
    return sources.has(key) || (options.apiSource !== undefined && key === apiKey) || originalFileExists(candidate);
  };
  host.readFile = (candidate): string | undefined => {
    const key = canonicalFileName(candidate);
    if (options.apiSource !== undefined && key === apiKey) return options.apiSource;
    const source = sources.get(key);
    return source ? source.source : originalReadFile(candidate);
  };
  host.getSourceFile = (candidate, languageVersion, onError, shouldCreateNewSourceFile) => {
    const key = canonicalFileName(candidate);
    if (options.apiSource !== undefined && key === apiKey) {
      return ts.createSourceFile(apiPath, options.apiSource, languageVersion, true, ts.ScriptKind.TS);
    }
    const source = sources.get(key);
    if (source) {
      return ts.createSourceFile(source.fileName, source.source, languageVersion, true, ts.ScriptKind.TS);
    }
    return originalGetSourceFile(candidate, languageVersion, onError, shouldCreateNewSourceFile);
  };

  const program = ts.createProgram({
    rootNames: [apiPath, ...[...sources.values()].map(source => source.fileName)],
    options: compilerOptions,
    host,
  });
  const errors = ts.getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .sort(compareDiagnostics);
  const shared = errors.filter(diagnostic =>
    !diagnostic.file || !sources.has(canonicalFileName(diagnostic.file.fileName)));
  return [...sources.entries()].map(([key, source]) => {
    const error = [...shared, ...errors.filter(diagnostic =>
      diagnostic.file && canonicalFileName(diagnostic.file.fileName) === key)]
      .sort(compareDiagnostics)[0];
    return {
      fileName: source.fileName,
      ...(error ? { error: diagnosticError(error) } : {}),
    };
  });
}

function runtimeCompilerOptions(): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    // Runtime checks workflow consumers; pinned declaration integrity is covered by the
    // strict development and conformance typechecks.
    skipLibCheck: true,
    noEmit: true,
    noErrorTruncation: true,
    types: [],
  };
}

function diagnosticError(diagnostic: ts.Diagnostic): WorkflowScriptError {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (diagnostic.file && diagnostic.start !== undefined) {
    const location = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return new WorkflowScriptError(`TypeScript TS${diagnostic.code}: ${message}`, {
      line: location.line + 1,
      column: location.character + 1,
    });
  }
  return new WorkflowScriptError(`TypeScript TS${diagnostic.code}: ${message}`);
}

function compareDiagnostics(left: ts.Diagnostic, right: ts.Diagnostic): number {
  const leftFile = left.file?.fileName ?? "";
  const rightFile = right.file?.fileName ?? "";
  return leftFile.localeCompare(rightFile)
    || (left.start ?? -1) - (right.start ?? -1)
    || left.code - right.code;
}

function canonicalFileName(fileName: string): string {
  return path.resolve(fileName);
}

function nodeError(file: ts.SourceFile, node: ts.Node, message: string): WorkflowScriptError {
  const position = file.getLineAndCharacterOfPosition(node.getStart(file));
  return new WorkflowScriptError(message, { line: position.line + 1, column: position.character + 1 });
}

import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { WorkflowScriptError } from "../runtime/errors.js";
import { WORKFLOW_MODULE } from "./workflow-language.js";

const DEFAULT_API_PATH = fileURLToPath(new URL("../../workflow-api.d.ts", import.meta.url));

export interface WorkflowTypecheckOptions {
  fileName: string;
  apiPath?: string;
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

/** Strictly typecheck one original `.flow.ts` module against the pinned virtual API. */
export function typecheckWorkflowSource(
  source: string,
  options: WorkflowTypecheckOptions,
): void {
  const fileName = path.resolve(options.fileName);
  const apiPath = path.resolve(options.apiPath ?? DEFAULT_API_PATH);
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    skipLibCheck: false,
    noEmit: true,
    noErrorTruncation: true,
    types: [],
  };
  const host = ts.createCompilerHost(compilerOptions, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  const sourceKey = canonicalFileName(fileName);

  host.fileExists = (candidate): boolean =>
    canonicalFileName(candidate) === sourceKey || originalFileExists(candidate);
  host.readFile = (candidate): string | undefined =>
    canonicalFileName(candidate) === sourceKey ? source : originalReadFile(candidate);
  host.getSourceFile = (candidate, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (canonicalFileName(candidate) === sourceKey) {
      return ts.createSourceFile(candidate, source, languageVersion, true, ts.ScriptKind.TS);
    }
    return originalGetSourceFile(candidate, languageVersion, onError, shouldCreateNewSourceFile);
  };

  const program = ts.createProgram({
    rootNames: [apiPath, fileName],
    options: compilerOptions,
    host,
  });
  const errors = ts.getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .sort(compareDiagnostics);
  if (errors.length === 0) return;
  throw diagnosticError(errors[0]!);
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

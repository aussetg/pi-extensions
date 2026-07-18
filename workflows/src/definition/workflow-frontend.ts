import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "acorn";
import type { JsonSchema, JsonValue } from "../types.js";
import { WorkflowScriptError } from "../runtime/errors.js";
import { sha256, stableHash } from "../utils/hashes.js";
import { deepFreezeJson, scalarLength } from "./canonical-json.js";
import { DEFINITION_LIMITS, FLOW_NAME_PATTERN } from "./limits.js";
import {
  buildParentMap,
  isFunction,
  location,
  objectProperties,
  sourceLocation,
  walk,
  type WorkflowAstNode,
} from "./workflow-ast.js";
import {
  WORKFLOW_MODULE,
  WORKFLOW_RUNTIME_API_HASH,
  WORKFLOW_SOURCE_EXTENSION,
  type WorkflowDescriptorIdentity,
} from "./workflow-language.js";
import { analyzeWorkflowSource } from "./workflow-analysis.js";
import {
  collectWorkflowSchemaResources,
  WorkflowSchemaEvaluator,
} from "./workflow-schema.js";
import {
  typecheckWorkflowSource,
  validateWorkflowTypeScriptEnvelope,
} from "./workflow-typecheck.js";
import type {
  ParsedWorkflow,
  WorkflowAgentDescriptor,
  WorkflowCommandDescriptor,
  WorkflowDescriptor,
  WorkflowMetadata,
  WorkflowSourceTransform,
} from "./workflow-types.js";

export interface ParseWorkflowOptions {
  fileName?: string;
  apiPath?: string;
}

interface VirtualImportBindings {
  declaration: WorkflowAstNode;
  byImported: Map<"agent" | "command" | "schema" | "workflow", string>;
  byLocal: Map<string, "agent" | "command" | "schema" | "workflow">;
}

interface WorkflowDefinitionAst {
  exportNode: WorkflowAstNode;
  call: WorkflowAstNode;
  object: WorkflowAstNode;
  runNode: WorkflowAstNode;
  flowName: string;
  argsPattern: WorkflowAstNode;
}

interface TopLevelConstants {
  initializers: Map<string, WorkflowAstNode>;
  ranges: Array<{ start: number; end: number }>;
}

interface InputPathResolver {
  resolve(node: WorkflowAstNode): string | undefined;
  names: ReadonlySet<string>;
}

interface SourceEdit {
  start: number;
  end: number;
  text: string;
  order: number;
}

const DEFINITION_FIELDS = new Set(["title", "description", "input", "output", "concurrency", "run"]);
const REQUIRED_DEFINITION_FIELDS = ["description", "input", "output", "run"] as const;
const AGENT_FIELDS = new Set(["profile", "output", "workspace", "network", "instructions", "title"]);
const COMMAND_FIELDS = new Set(["profile", "output", "effect", "allowFailure", "title"]);
const VALUE_IMPORTS = new Set(["agent", "command", "schema", "workflow"]);
const PROFILE_SELECTOR = /^(?:builtin|user|project):[a-z][a-z0-9_-]{0,63}$/;
const TYPESCRIPT_SUPPRESSION = /\/\/[ \t]*@ts-(?:ignore|expect-error|nocheck|check)\b|\/\*[\s\S]*?@ts-(?:ignore|expect-error|nocheck|check)\b/giu;

/** Parse, typecheck, statically review, and instrument one workflow source module. */
export function parseWorkflow(
  source: string,
  options: ParseWorkflowOptions = {},
): ParsedWorkflow {
  const fileName = validateFileName(options.fileName ?? "workflow.flow.ts");
  validateSourceEnvelope(source);
  rejectTypeScriptSuppressions(source);
  validateWorkflowTypeScriptEnvelope(source, fileName);
  const strippedSource = stripErasableTypeScript(source);
  if (strippedSource.length !== source.length || lineCount(strippedSource) !== lineCount(source)) {
    throw new WorkflowScriptError("TypeScript stripping did not preserve source positions");
  }
  const ast = parseStrippedModule(strippedSource);
  const parents = buildParentMap(ast);
  const imports = parseVirtualImport(ast);
  const definition = findDefinition(ast, imports);
  validateTopLevel(ast, imports.declaration, definition.exportNode);
  const inputPaths = createInputPathResolver(definition.argsPattern);
  rejectReservedBindingShadows(ast, imports, definition, inputPaths.names);
  validateConstructorUse(ast, imports, definition, parents);
  typecheckWorkflowSource(source, {
    fileName: path.resolve(fileName),
    ...(options.apiPath ? { apiPath: options.apiPath } : {}),
  });

  const constants = collectTopLevelConstants(ast, imports.declaration, definition.exportNode);
  const schemaBinding = imports.byImported.get("schema")!;
  const evaluator = new WorkflowSchemaEvaluator(schemaBinding, constants.initializers);
  const metadata = parseMetadata(definition, evaluator);
  const descriptors = parseDescriptors(ast, imports, constants, evaluator);
  validateStaticTopLevelBindings(constants, descriptors, evaluator);
  rejectDescriptorShadows(ast, constants, descriptors);
  const analysis = analyzeWorkflowSource({
    ast,
    runNode: definition.runNode,
    flowName: definition.flowName,
    inputSchema: metadata.input,
    ...(metadata.concurrency !== undefined ? { maximumConcurrency: metadata.concurrency } : {}),
    inputPath: inputPaths.resolve,
    schemaEvaluator: evaluator,
    descriptors,
    parents,
  });
  const review = {
    ...analysis.review,
    ...(metadata.concurrency !== undefined ? { maximumConcurrency: metadata.concurrency } : {}),
  };
  const { executableSource, transform } = buildExecutableSource({
    source,
    strippedSource,
    imports,
    definition,
    constants,
    descriptors,
    operationNodes: analysis.operationNodes,
  });
  const parsed: ParsedWorkflow = {
    fileName: path.basename(fileName),
    installedName: path.basename(fileName, WORKFLOW_SOURCE_EXTENSION),
    source,
    sourceHash: sha256(source),
    strippedSource,
    executableSource,
    metadata,
    descriptors,
    operations: analysis.operations,
    helpers: analysis.helpers,
    review,
    transform,
  };
  return deepFreezeJson(parsed as unknown as JsonValue) as unknown as ParsedWorkflow;
}

function validateFileName(fileNameInput: string): string {
  const fileName = path.basename(fileNameInput);
  if (!fileName.endsWith(WORKFLOW_SOURCE_EXTENSION)) {
    throw new WorkflowScriptError(`Workflow source must use ${WORKFLOW_SOURCE_EXTENSION}`);
  }
  const stem = fileName.slice(0, -WORKFLOW_SOURCE_EXTENSION.length);
  if (!FLOW_NAME_PATTERN.test(stem)) {
    throw new WorkflowScriptError(`Workflow filename must match ${FLOW_NAME_PATTERN.source}`);
  }
  return fileNameInput;
}

function validateSourceEnvelope(source: string): void {
  if (typeof source !== "string") throw new WorkflowScriptError("Workflow source must be text");
  if (Buffer.byteLength(source, "utf8") > DEFINITION_LIMITS.sourceBytes) {
    throw new WorkflowScriptError(`Workflow definition exceeds ${DEFINITION_LIMITS.sourceBytes} bytes`);
  }
  if (source.includes("\0")) throw new WorkflowScriptError("Workflow definition contains a NUL byte");
}

function rejectTypeScriptSuppressions(source: string): void {
  TYPESCRIPT_SUPPRESSION.lastIndex = 0;
  const match = TYPESCRIPT_SUPPRESSION.exec(source);
  if (!match || match.index === undefined) return;
  throw new WorkflowScriptError("TypeScript diagnostic suppression directives are unavailable", offsetLocation(source, match.index));
}

function stripErasableTypeScript(source: string): string {
  try {
    return stripTypeScriptTypes(source, { mode: "strip", sourceMap: false });
  } catch (error) {
    const line = stripErrorLine(error);
    const sourceLine = line ? source.split("\n")[line - 1] ?? "" : "";
    const column = sourceLine.search(/\S/u) + 1;
    throw new WorkflowScriptError(
      `Workflow TypeScript must use erasable syntax: ${errorMessage(error)}`,
      line ? { line, column: Math.max(1, column) } : undefined,
    );
  }
}

function parseStrippedModule(source: string): WorkflowAstNode {
  try {
    return parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
      allowAwaitOutsideFunction: false,
      allowReturnOutsideFunction: false,
    } as never);
  } catch (error) {
    const parseError = error as Error & { loc?: { line: number; column: number } };
    throw new WorkflowScriptError(
      `Invalid workflow TypeScript: ${parseError.message.replace(/\s*\(\d+:\d+\)\s*$/u, "")}`,
      parseError.loc ? { line: parseError.loc.line, column: parseError.loc.column + 1 } : undefined,
    );
  }
}

function parseVirtualImport(ast: WorkflowAstNode): VirtualImportBindings {
  const imports = ast.body.filter((node: WorkflowAstNode) => node.type === "ImportDeclaration");
  if (imports.length !== 1) {
    throw new WorkflowScriptError(
      `A workflow requires exactly one import from ${JSON.stringify(WORKFLOW_MODULE)}`,
      location(imports[1] ?? imports[0] ?? ast),
    );
  }
  const declaration = imports[0]!;
  if (declaration.source?.value !== WORKFLOW_MODULE) {
    throw new WorkflowScriptError(
      `Workflow imports are restricted to ${JSON.stringify(WORKFLOW_MODULE)}`,
      location(declaration.source ?? declaration),
    );
  }
  const byImported = new Map<"agent" | "command" | "schema" | "workflow", string>();
  const byLocal = new Map<string, "agent" | "command" | "schema" | "workflow">();
  for (const specifier of declaration.specifiers ?? []) {
    if (specifier.type !== "ImportSpecifier" || specifier.imported?.type !== "Identifier") {
      throw new WorkflowScriptError("The virtual workflow module permits named imports only", location(specifier));
    }
    const imported = specifier.imported.name as "agent" | "command" | "schema" | "workflow";
    if (!VALUE_IMPORTS.has(imported)) {
      throw new WorkflowScriptError(`Unknown workflow value import ${imported}`, location(specifier.imported));
    }
    if (byImported.has(imported) || byLocal.has(specifier.local.name)) {
      throw new WorkflowScriptError(`Duplicate workflow import ${imported}`, location(specifier));
    }
    byImported.set(imported, specifier.local.name);
    byLocal.set(specifier.local.name, imported);
  }
  for (const required of ["schema", "workflow"] as const) {
    if (!byImported.has(required)) {
      throw new WorkflowScriptError(`Workflow import requires ${required}`, location(declaration));
    }
  }
  return { declaration, byImported, byLocal };
}

function findDefinition(ast: WorkflowAstNode, imports: VirtualImportBindings): WorkflowDefinitionAst {
  const exports = ast.body.filter((node: WorkflowAstNode) => node.type.startsWith("Export"));
  if (exports.length !== 1 || exports[0]?.type !== "ExportDefaultDeclaration") {
    throw new WorkflowScriptError("A .flow.ts file must have exactly one default workflow({...}) export", location(exports[1] ?? exports[0] ?? ast));
  }
  const exportNode = exports[0]!;
  const call = exportNode.declaration;
  const workflowBinding = imports.byImported.get("workflow");
  if (call?.type !== "CallExpression" || call.optional || call.callee?.type !== "Identifier"
    || call.callee.name !== workflowBinding || call.arguments.length !== 1
    || call.arguments[0]?.type !== "ObjectExpression") {
    throw new WorkflowScriptError("Default export must be workflow({...})", location(exportNode));
  }
  const object = call.arguments[0];
  const properties = objectProperties(object, "workflow definition");
  for (const [name, property] of properties) {
    if (!DEFINITION_FIELDS.has(name)) throw new WorkflowScriptError(`Unknown workflow definition field ${name}`, location(property));
  }
  for (const name of REQUIRED_DEFINITION_FIELDS) {
    if (!properties.has(name)) throw new WorkflowScriptError(`Workflow definition is missing ${name}`, location(object));
  }
  const runNode = properties.get("run")!.value;
  if (!isFunction(runNode) || !runNode.async || runNode.generator || runNode.params.length !== 2
    || runNode.params[0]?.type !== "Identifier"
    || !["Identifier", "ObjectPattern"].includes(runNode.params[1]?.type)) {
    throw new WorkflowScriptError(
      "Workflow run must be async run(flow, input) with an identifier or object input pattern",
      location(runNode),
    );
  }
  return {
    exportNode,
    call,
    object,
    runNode,
    flowName: runNode.params[0].name,
    argsPattern: runNode.params[1],
  };
}

function validateTopLevel(
  ast: WorkflowAstNode,
  importNode: WorkflowAstNode,
  exportNode: WorkflowAstNode,
): void {
  for (const statement of ast.body) {
    if (statement === importNode || statement === exportNode || statement.type === "EmptyStatement") continue;
    if (statement.type === "VariableDeclaration" && statement.kind === "const") continue;
    if (statement.type === "FunctionDeclaration" && statement.id && !statement.async && !statement.generator) continue;
    throw new WorkflowScriptError(
      "Top level permits only the virtual import, const values, pure function declarations, and the default workflow export",
      location(statement),
    );
  }
}

function rejectReservedBindingShadows(
  ast: WorkflowAstNode,
  imports: VirtualImportBindings,
  definition: WorkflowDefinitionAst,
  inputNames: ReadonlySet<string>,
): void {
  const allowedInputNodes = patternIdentifierNodes(definition.argsPattern);
  for (const node of declarationIdentifierNodes(ast)) {
    if (imports.byLocal.has(node.name)) {
      throw new WorkflowScriptError(`Imported workflow binding ${node.name} may not be shadowed`, location(node));
    }
    if (node.name === definition.flowName && node !== definition.runNode.params[0]) {
      throw new WorkflowScriptError(`Flow binding ${node.name} may not be shadowed`, location(node));
    }
    if (inputNames.has(node.name) && !allowedInputNodes.has(node)) {
      throw new WorkflowScriptError(`Workflow input binding ${node.name} may not be shadowed`, location(node));
    }
  }
}

function validateConstructorUse(
  ast: WorkflowAstNode,
  imports: VirtualImportBindings,
  definition: WorkflowDefinitionAst,
  parents: ReadonlyMap<WorkflowAstNode, { parent: WorkflowAstNode; key: string }>,
): void {
  const constructorByLocal = imports.byLocal;
  walk(ast, (node, parent, key) => {
    if (node.type !== "Identifier") return;
    const imported = constructorByLocal.get(node.name);
    if (!imported || parent?.type === "ImportSpecifier" || isNoncomputedPropertyKey(node, parent, key)
      || (parent?.type === "MemberExpression" && key === "property" && !parent.computed)) return;
    if (imported === "schema") {
      if (parent?.type === "MemberExpression" && key === "object" && !parent.computed) return;
      throw new WorkflowScriptError("The schema facade may only use static constructor calls", location(node));
    }
    if (parent?.type !== "CallExpression" || key !== "callee") {
      throw new WorkflowScriptError(`Workflow constructor ${imported} may not escape`, location(node));
    }
    if (imported === "workflow") {
      if (parent !== definition.call) throw new WorkflowScriptError("workflow() is available only for the default definition", location(node));
      return;
    }
    const declarator = parents.get(parent)?.parent;
    const declaration = declarator ? parents.get(declarator)?.parent : undefined;
    const program = declaration ? parents.get(declaration)?.parent : undefined;
    if (!declarator || declarator.init !== parent || declarator.id?.type !== "Identifier"
      || declaration?.type !== "VariableDeclaration" || declaration.kind !== "const" || program?.type !== "Program") {
      throw new WorkflowScriptError(`${imported}() descriptors must initialize a top-level const`, location(parent));
    }
  });
}

function collectTopLevelConstants(
  ast: WorkflowAstNode,
  importNode: WorkflowAstNode,
  exportNode: WorkflowAstNode,
): TopLevelConstants {
  const initializers = new Map<string, WorkflowAstNode>();
  const ranges: Array<{ start: number; end: number }> = [];
  for (const statement of ast.body) {
    if (statement === importNode || statement === exportNode || statement.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declarations ?? []) {
      if (declaration.id?.type !== "Identifier" || !declaration.init) {
        throw new WorkflowScriptError("Top-level const declarations require simple initialized names", location(declaration));
      }
      if (initializers.has(declaration.id.name)) {
        throw new WorkflowScriptError(`Duplicate top-level binding ${declaration.id.name}`, location(declaration.id));
      }
      initializers.set(declaration.id.name, declaration.init);
      ranges.push({ start: declaration.init.start, end: declaration.init.end });
    }
  }
  return { initializers, ranges };
}

function validateStaticTopLevelBindings(
  constants: TopLevelConstants,
  descriptors: readonly WorkflowDescriptor[],
  evaluator: WorkflowSchemaEvaluator,
): void {
  const descriptorBindings = new Set(descriptors.map((descriptor) => descriptor.binding));
  for (const name of constants.initializers.keys()) {
    if (!descriptorBindings.has(name)) evaluator.validateBinding(name);
  }
}

function rejectDescriptorShadows(
  ast: WorkflowAstNode,
  constants: TopLevelConstants,
  descriptors: readonly WorkflowDescriptor[],
): void {
  const descriptorNames = new Set(descriptors.map((descriptor) => descriptor.binding));
  const allowed = new Set<WorkflowAstNode>();
  walk(ast, (node) => {
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier"
      && descriptorNames.has(node.id.name) && node.init === constants.initializers.get(node.id.name)) {
      allowed.add(node.id);
    }
  });
  for (const node of declarationIdentifierNodes(ast)) {
    if (descriptorNames.has(node.name) && !allowed.has(node)) {
      throw new WorkflowScriptError(`Task descriptor binding ${node.name} may not be shadowed`, location(node));
    }
  }
}

function parseMetadata(
  definition: WorkflowDefinitionAst,
  evaluator: WorkflowSchemaEvaluator,
): WorkflowMetadata {
  const properties = objectProperties(definition.object, "workflow definition");
  const description = boundedStaticString(
    evaluator,
    properties.get("description")!.value,
    "workflow description",
    DEFINITION_LIMITS.descriptionScalars,
  );
  const titleProperty = properties.get("title");
  const title = titleProperty
    ? boundedStaticString(evaluator, titleProperty.value, "workflow title", DEFINITION_LIMITS.titleScalars)
    : undefined;
  const input = evaluator.schema(properties.get("input")!.value, "workflow input");
  if (input.type !== "object") throw new WorkflowScriptError("Workflow input schema must have object root type", location(properties.get("input")!.value));
  const output = evaluator.schema(properties.get("output")!.value, "workflow output");
  rejectExecutableResources(output, properties.get("output")!.value, "Workflow output");
  const concurrencyNode = properties.get("concurrency")?.value;
  let concurrency: number | undefined;
  if (concurrencyNode) {
    const value = evaluator.json(concurrencyNode, "workflow concurrency");
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > DEFINITION_LIMITS.concurrency) {
      throw new WorkflowScriptError(`Workflow concurrency must be 1–${DEFINITION_LIMITS.concurrency}`, location(concurrencyNode));
    }
    concurrency = value as number;
  }
  return {
    ...(title ? { title } : {}),
    description,
    input,
    output,
    ...(concurrency !== undefined ? { concurrency } : {}),
  };
}

function parseDescriptors(
  ast: WorkflowAstNode,
  imports: VirtualImportBindings,
  constants: TopLevelConstants,
  evaluator: WorkflowSchemaEvaluator,
): WorkflowDescriptor[] {
  const constructors = new Map<string, "agent-task" | "command-task">();
  const agentBinding = imports.byImported.get("agent");
  const commandBinding = imports.byImported.get("command");
  if (agentBinding) constructors.set(agentBinding, "agent-task");
  if (commandBinding) constructors.set(commandBinding, "command-task");
  const declarations: Array<{ binding: string; call: WorkflowAstNode; kind: "agent-task" | "command-task" }> = [];
  for (const [binding, initializer] of constants.initializers) {
    if (initializer.type !== "CallExpression" || initializer.callee?.type !== "Identifier") continue;
    const kind = constructors.get(initializer.callee.name);
    if (kind) declarations.push({ binding, call: initializer, kind });
  }
  declarations.sort((left, right) => left.call.start - right.call.start);
  return declarations.map((declaration, index) => {
    const sourceSite = `descriptor-${String(index).padStart(6, "0")}`;
    if (declaration.call.arguments.length !== 1 || declaration.call.arguments[0]?.type !== "ObjectExpression") {
      throw new WorkflowScriptError(`${declaration.kind} requires one literal definition`, location(declaration.call));
    }
    const definition = objectProperties(declaration.call.arguments[0], `${declaration.kind} definition`);
    return declaration.kind === "agent-task"
      ? parseAgentDescriptor(declaration.binding, sourceSite, declaration.call, definition, evaluator)
      : parseCommandDescriptor(declaration.binding, sourceSite, declaration.call, definition, evaluator);
  });
}

function parseAgentDescriptor(
  binding: string,
  sourceSite: string,
  call: WorkflowAstNode,
  definition: Map<string, WorkflowAstNode>,
  evaluator: WorkflowSchemaEvaluator,
): WorkflowAgentDescriptor {
  assertDefinitionKeys(definition, AGENT_FIELDS, ["profile", "output"], "agent descriptor");
  const profile = profileField(evaluator, definition.get("profile")!.value, "agent profile");
  const output = evaluator.schema(definition.get("output")!.value, "agent output");
  if (output.type !== "object") throw new WorkflowScriptError("Agent output schema must have object root type", location(definition.get("output")!.value));
  rejectExecutableResources(output, definition.get("output")!.value, "Agent output");
  const workspace = optionalEnumField(evaluator, definition, "workspace", ["snapshot", "candidate"] as const) ?? "snapshot";
  const network = optionalEnumField(evaluator, definition, "network", ["none", "research"] as const) ?? "none";
  const instructions = optionalBoundedField(evaluator, definition, "instructions", DEFINITION_LIMITS.profileInstructionsScalars);
  const title = optionalBoundedField(evaluator, definition, "title", DEFINITION_LIMITS.titleScalars);
  const semantic = {
    profile,
    output,
    workspace,
    network,
    ...(instructions ? { instructions } : {}),
  };
  const identity: WorkflowDescriptorIdentity = {
    kind: "agent-task",
    sourceSite,
    definitionHash: stableHash(semantic),
  };
  return {
    binding,
    kind: "agent-task",
    identity,
    ...semantic,
    ...(title ? { title } : {}),
    location: sourceLocation(call),
  };
}

function parseCommandDescriptor(
  binding: string,
  sourceSite: string,
  call: WorkflowAstNode,
  definition: Map<string, WorkflowAstNode>,
  evaluator: WorkflowSchemaEvaluator,
): WorkflowCommandDescriptor {
  assertDefinitionKeys(definition, COMMAND_FIELDS, ["profile"], "command descriptor");
  const profile = profileField(evaluator, definition.get("profile")!.value, "command profile");
  const output = optionalEnumField(evaluator, definition, "output", ["summary", "text", "json"] as const) ?? "summary";
  const effect = optionalEnumField(evaluator, definition, "effect", ["read-only", "temporary", "candidate"] as const) ?? "read-only";
  const allowFailureValue = definition.get("allowFailure")
    ? evaluator.json(definition.get("allowFailure")!.value, "command allowFailure")
    : false;
  if (typeof allowFailureValue !== "boolean") {
    throw new WorkflowScriptError("command allowFailure must be boolean", location(definition.get("allowFailure")?.value));
  }
  const title = optionalBoundedField(evaluator, definition, "title", DEFINITION_LIMITS.titleScalars);
  const semantic = { profile, output, effect, allowFailure: allowFailureValue };
  const identity: WorkflowDescriptorIdentity = {
    kind: "command-task",
    sourceSite,
    definitionHash: stableHash(semantic),
  };
  return {
    binding,
    kind: "command-task",
    identity,
    ...semantic,
    ...(title ? { title } : {}),
    location: sourceLocation(call),
  };
}

function createInputPathResolver(pattern: WorkflowAstNode): InputPathResolver {
  const bindings = new Map<string, string>();
  if (pattern.type === "Identifier") bindings.set(pattern.name, "");
  else collectInputPatternBindings(pattern, "", bindings);
  return {
    resolve: (node: WorkflowAstNode): string | undefined => expressionInputPath(node, bindings),
    names: new Set(bindings.keys()),
  };
}

function collectInputPatternBindings(pattern: WorkflowAstNode, base: string, bindings: Map<string, string>): void {
  if (pattern.type !== "ObjectPattern") {
    throw new WorkflowScriptError("Workflow input destructuring must use an object pattern", location(pattern));
  }
  for (const property of pattern.properties ?? []) {
    if (property.type === "RestElement") {
      throw new WorkflowScriptError("Workflow input destructuring may not use rest bindings", location(property));
    }
    if (property.computed || property.kind !== "init") {
      throw new WorkflowScriptError("Workflow input destructuring requires static data properties", location(property));
    }
    const name = property.key.type === "Identifier" ? property.key.name : property.key.value;
    if (typeof name !== "string") throw new WorkflowScriptError("Workflow input keys must be static strings", location(property.key));
    const childPath = `${base}/${escapePointer(name)}`;
    const value = property.value?.type === "AssignmentPattern" ? property.value.left : property.value;
    if (value?.type === "Identifier") bindings.set(value.name, childPath);
    else if (value?.type === "ObjectPattern") collectInputPatternBindings(value, childPath, bindings);
    else throw new WorkflowScriptError("Workflow input bindings must be identifiers or nested objects", location(value));
  }
}

function expressionInputPath(node: WorkflowAstNode | undefined, bindings: ReadonlyMap<string, string>): string | undefined {
  if (!node) return undefined;
  if (node.type === "ChainExpression") return expressionInputPath(node.expression, bindings);
  if (node.type === "Identifier") return bindings.get(node.name);
  if (node.type !== "MemberExpression" || node.optional || node.object === undefined) return undefined;
  const base = expressionInputPath(node.object, bindings);
  if (base === undefined) return undefined;
  const property = node.computed
    ? node.property?.type === "Literal" && typeof node.property.value === "string" ? node.property.value : undefined
    : node.property?.type === "Identifier" ? node.property.name : undefined;
  return property === undefined ? undefined : `${base}/${escapePointer(property)}`;
}

function buildExecutableSource(input: {
  source: string;
  strippedSource: string;
  imports: VirtualImportBindings;
  definition: WorkflowDefinitionAst;
  constants: TopLevelConstants;
  descriptors: readonly WorkflowDescriptor[];
  operationNodes: ReadonlyArray<{ sourceSite: string; node: WorkflowAstNode }>;
}): { executableSource: string; transform: WorkflowSourceTransform } {
  const edits: SourceEdit[] = [];
  let order = 0;
  const importBindings = [...input.imports.byImported.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([imported, local]) => `${imported}: ${local}`)
    .join(", ");
  edits.push({
    start: input.imports.declaration.start,
    end: input.imports.declaration.end,
    text: `const { ${importBindings} } = __flowLanguage;`,
    order: order++,
  });
  edits.push({
    start: input.definition.exportNode.start,
    end: input.definition.call.start,
    text: "const __flowDefinition = ",
    order: order++,
  });
  for (const range of input.constants.ranges) {
    edits.push({ start: range.start, end: range.start, text: "__flowDeepFreeze(", order: order++ });
    edits.push({ start: range.end, end: range.end, text: ")", order: order++ });
  }
  for (const descriptor of input.descriptors) {
    const call = input.constants.initializers.get(descriptor.binding)!;
    const first = call.arguments[0];
    edits.push({
      start: first.start,
      end: first.start,
      text: `__flowSourceSite(${JSON.stringify(descriptor.identity.sourceSite)}), `,
      order: order++,
    });
  }
  for (const operation of input.operationNodes) {
    const first = operation.node.arguments?.[0];
    const insertion = first?.start ?? operation.node.callee.end + 1;
    edits.push({
      start: insertion,
      end: insertion,
      text: `__flowSourceSite(${JSON.stringify(operation.sourceSite)}), `,
      order: order++,
    });
  }
  let executableSource = input.strippedSource;
  for (const edit of edits.sort((left, right) =>
    right.start - left.start || right.end - left.end || right.order - left.order)) {
    executableSource = executableSource.slice(0, edit.start) + edit.text + executableSource.slice(edit.end);
  }
  executableSource = `${executableSource}\n;__flowDefinition;`;
  assertExecutableSyntax(executableSource);
  const body = {
    sourceHash: sha256(input.source),
    strippedSourceHash: sha256(input.strippedSource),
    executableSourceHash: sha256(executableSource),
    runtimeApiHash: WORKFLOW_RUNTIME_API_HASH,
    descriptorSites: input.descriptors.map((descriptor) => ({
      sourceSite: descriptor.identity.sourceSite,
      kind: descriptor.kind,
      location: descriptor.location,
    })),
    operationSites: input.operationNodes.map((operation) => ({
      sourceSite: operation.sourceSite,
      method: operation.node.callee.property.name,
      location: sourceLocation(operation.node),
    })),
  };
  const transform: WorkflowSourceTransform = {
    ...body,
    operationSites: body.operationSites as WorkflowSourceTransform["operationSites"],
    transformHash: stableHash(body),
  };
  return { executableSource, transform };
}

function assertExecutableSyntax(source: string): void {
  try { parse(source, { ecmaVersion: "latest", sourceType: "script" } as never); }
  catch (error) { throw new Error(`Generated workflow executable source is invalid: ${errorMessage(error)}`); }
}

function assertDefinitionKeys(
  properties: ReadonlyMap<string, WorkflowAstNode>,
  allowed: ReadonlySet<string>,
  required: readonly string[],
  label: string,
): void {
  for (const [name, property] of properties) {
    if (!allowed.has(name)) throw new WorkflowScriptError(`${label} contains unknown field ${name}`, location(property));
  }
  for (const name of required) {
    if (!properties.has(name)) throw new WorkflowScriptError(`${label} requires ${name}`);
  }
}

function profileField(
  evaluator: WorkflowSchemaEvaluator,
  node: WorkflowAstNode,
  label: string,
): string {
  const value = evaluator.json(node, label);
  if (typeof value !== "string" || !PROFILE_SELECTOR.test(value)) {
    throw new WorkflowScriptError(`${label} must be an exact registered selector`, location(node));
  }
  return value;
}

function optionalEnumField<const T extends readonly string[]>(
  evaluator: WorkflowSchemaEvaluator,
  properties: ReadonlyMap<string, WorkflowAstNode>,
  name: string,
  allowed: T,
): T[number] | undefined {
  const property = properties.get(name);
  if (!property) return undefined;
  const value = evaluator.json(property.value, name);
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new WorkflowScriptError(`${name} must be one of ${allowed.join(", ")}`, location(property.value));
  }
  return value as T[number];
}

function optionalBoundedField(
  evaluator: WorkflowSchemaEvaluator,
  properties: ReadonlyMap<string, WorkflowAstNode>,
  name: string,
  maximum: number,
): string | undefined {
  const property = properties.get(name);
  return property ? boundedStaticString(evaluator, property.value, name, maximum) : undefined;
}

function boundedStaticString(
  evaluator: WorkflowSchemaEvaluator,
  node: WorkflowAstNode,
  label: string,
  maximum: number,
): string {
  const value = evaluator.json(node, label);
  if (typeof value !== "string" || value.trim() === "" || scalarLength(value) > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new WorkflowScriptError(`${label} must contain 1–${maximum} safe Unicode scalars`, location(node));
  }
  return value;
}

function rejectExecutableResources(schema: JsonSchema, node: WorkflowAstNode, label: string): void {
  if (collectWorkflowSchemaResources(schema).length) {
    throw new WorkflowScriptError(`${label} schemas may not mint invocation-selected resources`, location(node));
  }
}

function declarationIdentifierNodes(ast: WorkflowAstNode): Set<WorkflowAstNode> {
  const result = new Set<WorkflowAstNode>();
  walk(ast, (node) => {
    if (node.type === "VariableDeclarator") collectPatternIdentifierNodes(node.id, result);
    if ((node.type === "FunctionDeclaration" || node.type === "FunctionExpression") && node.id) result.add(node.id);
    if (isFunction(node)) for (const parameter of node.params ?? []) collectPatternIdentifierNodes(parameter, result);
    if (node.type === "CatchClause" && node.param) collectPatternIdentifierNodes(node.param, result);
  });
  return result;
}

function patternIdentifierNodes(pattern: WorkflowAstNode): Set<WorkflowAstNode> {
  const result = new Set<WorkflowAstNode>();
  collectPatternIdentifierNodes(pattern, result);
  return result;
}

function collectPatternIdentifierNodes(pattern: WorkflowAstNode | undefined, result: Set<WorkflowAstNode>): void {
  if (!pattern) return;
  if (pattern.type === "Identifier") result.add(pattern);
  else if (pattern.type === "RestElement") collectPatternIdentifierNodes(pattern.argument, result);
  else if (pattern.type === "AssignmentPattern") collectPatternIdentifierNodes(pattern.left, result);
  else if (pattern.type === "ArrayPattern") {
    for (const entry of pattern.elements ?? []) collectPatternIdentifierNodes(entry, result);
  } else if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties ?? []) collectPatternIdentifierNodes(property.value ?? property.argument, result);
  }
}

function isNoncomputedPropertyKey(
  node: WorkflowAstNode,
  parent: WorkflowAstNode | undefined,
  key: string | undefined,
): boolean {
  return parent?.type === "Property" && key === "key" && !parent.computed && parent.key === node;
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function lineCount(value: string): number {
  return value.split("\n").length;
}

function offsetLocation(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function stripErrorLine(error: unknown): number | undefined {
  const stack = error instanceof Error ? error.stack : undefined;
  const match = stack?.match(/^:(\d+)\s*$/mu);
  return match ? Number(match[1]) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

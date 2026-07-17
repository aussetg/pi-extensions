# Workflow runtime v17 conformance oracle

These fixtures are the executable contract for the native-TypeScript workflow redesign. They are
deliberately independent from the current production runtime so the implementation can be rebuilt
against settled behavior instead of gradually redefining the target.

It contains:

- framework-independent reference models for causal replay, same-run recovery, artifacts, candidate
  lifecycle, helper analysis, and invocation-selected resources;
- the production `pi/workflows` declaration in `workflow-api.d.ts`;
- the pinned runtime/API identity in `src/definition/workflow-language-v17.ts`;
- all six complete target workflows as strict TypeScript compile fixtures;
- positive inference and negative authority checks;
- the consolidated target specification.

The executable oracle currently contains 56 behavioral cases. TypeScript assertions are checked
separately because they are compile-time contracts rather than runtime tests.

Run the executable reference cases:

```bash
npm run test:conformance:v17
```

Compile the target API and workflow corpus:

```bash
npm run typecheck:conformance:v17
```

The normal `npm run check` runs both commands. The v17 declaration is now the canonical public
contract; the separate `workflow-api-v16.d.ts` exists only to typecheck the old runtime until the
atomic cutover. A production implementation may replace model code
with imports from `src/` only after the corresponding behavior exists there. Changing expected
behavior requires an explicit contract decision; tests must not be weakened merely to accommodate an
implementation.

The production TypeScript frontend now exists under `src/definition/workflow-v17-*`. Its own tests
parse all six corpus files, pin exact derived review snapshots, and exercise malformed source with
source locations. The reference models in this directory remain independent: later persistence and
runtime phases must still reproduce them rather than importing away the oracle.

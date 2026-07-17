# Workflow runtime v17 conformance oracle

These fixtures are the executable contract for the native-TypeScript workflow redesign. They are
deliberately independent from the current production runtime so the implementation can be rebuilt
against settled behavior instead of gradually redefining the target.

It contains:

- framework-independent reference models for causal replay, same-run recovery, artifacts, candidate
  lifecycle, helper analysis, and invocation-selected resources;
- the candidate `pi/workflows` declaration;
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

The normal `npm run check` runs both commands. A production implementation may replace model code
with imports from `src/` only after the corresponding behavior exists there. Changing expected
behavior requires an explicit contract decision; tests must not be weakened merely to accommodate an
implementation.

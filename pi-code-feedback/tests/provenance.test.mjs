import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { createDiagnosticSnapshot } from "../src/diagnostics/snapshots.ts";
import { diagnosticOverlapsTouchedRange, linkDiagnosticsToTouchedRanges } from "../src/diagnostics/provenance.ts";

function uri(path) {
  return pathToFileURL(path).href;
}

function diagnostic(filePath, range, overrides = {}) {
  return {
    uri: uri(filePath),
    range,
    severity: "error",
    message: "diagnostic",
    source: "test",
    code: "T1",
    ...overrides,
  };
}

function touched(filePath, startLine, endLine = startLine) {
  return {
    uri: uri(filePath),
    filePath,
    startLine,
    endLine,
    source: "tool-diff",
    confidence: "exact",
  };
}

test("diagnostic overlap treats an end at character 1 as exclusive", () => {
  const filePath = "/tmp/pi-code-feedback-exclusive.ts";
  const diag = diagnostic(filePath, {
    start: { line: 3, character: 4 },
    end: { line: 4, character: 1 },
  });

  assert.equal(diagnosticOverlapsTouchedRange(diag, touched(filePath, 3)), true);
  assert.equal(diagnosticOverlapsTouchedRange(diag, touched(filePath, 4)), false);
});

test("cross-file related diagnostics only cascade when new and enabled", () => {
  const touchedPath = "/tmp/pi-code-feedback-source.ts";
  const diagnosticPath = "/tmp/pi-code-feedback-target.ts";
  const afterDiagnostic = diagnostic(diagnosticPath, {
    start: { line: 2, character: 1 },
    end: { line: 2, character: 5 },
  }, {
    relatedInformation: [
      {
        uri: uri(touchedPath),
        range: {
          start: { line: 10, character: 1 },
          end: { line: 10, character: 5 },
        },
        message: "introduced here",
      },
    ],
  });
  const afterSnapshot = createDiagnosticSnapshot([afterDiagnostic]);
  const touchedRanges = [touched(touchedPath, 10)];

  const enabled = linkDiagnosticsToTouchedRanges({
    beforeSnapshot: createDiagnosticSnapshot([]),
    afterSnapshot,
    touchedRanges,
    maxInline: 8,
    includeCrossFileRelated: true,
  });
  assert.equal(enabled.linked.length, 1);
  assert.equal(enabled.linked[0].linkReason, "cascade-related");

  const disabled = linkDiagnosticsToTouchedRanges({
    beforeSnapshot: createDiagnosticSnapshot([]),
    afterSnapshot,
    touchedRanges,
    maxInline: 8,
    includeCrossFileRelated: false,
  });
  assert.equal(disabled.linked.length, 0);
  assert.equal(disabled.summary.hiddenUnrelated, 1);

  const notKnownNew = linkDiagnosticsToTouchedRanges({
    afterSnapshot,
    touchedRanges,
    maxInline: 8,
    includeCrossFileRelated: true,
  });
  assert.equal(notKnownNew.linked.length, 0);
});

test("diagnostic linking honors maxInline while retaining full summary", () => {
  const filePath = "/tmp/pi-code-feedback-limit.ts";
  const diagnostics = [1, 2, 3].map((line) => diagnostic(filePath, {
    start: { line, character: 1 },
    end: { line, character: 3 },
  }, { code: `T${line}`, message: `diagnostic ${line}` }));

  const result = linkDiagnosticsToTouchedRanges({
    afterSnapshot: createDiagnosticSnapshot(diagnostics),
    touchedRanges: [touched(filePath, 1, 3)],
    maxInline: 2,
    includeCrossFileRelated: true,
  });

  assert.equal(result.linked.length, 2);
  assert.equal(result.allLinked.length, 3);
  assert.deepEqual(result.summary, {
    totalDiagnostics: 3,
    linkedDiagnostics: 3,
    shownDiagnostics: 2,
    hiddenUnrelated: 0,
    hiddenByLimit: 1,
  });
});

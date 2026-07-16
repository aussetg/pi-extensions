import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { computeTouchedRanges } from "../src/diagnostics/ranges.ts";
import { createDiagnosticSnapshot } from "../src/diagnostics/snapshots.ts";
import { diagnosticOverlapsTouchedRange, linkDiagnosticsToTouchedRanges, workspaceDiagnosticDelta } from "../src/diagnostics/provenance.ts";
import { createDefaultConfig } from "../src/config.ts";
import { renderDiagnosticsStatus } from "../src/render.ts";
import { createRuntime, setProjectRoot } from "../src/runtime.ts";

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

test("workspace diagnostic deltas are bounded, cross-file, and explicitly separate from attribution", () => {
  const touchedPath = "/tmp/pi-code-feedback-delta-source.ts";
  const targetPath = "/tmp/pi-code-feedback-delta-target.ts";
  const otherPath = "/tmp/pi-code-feedback-delta-other.ts";
  const existing = diagnostic(targetPath, {
    start: { line: 2, character: 1 },
    end: { line: 2, character: 5 },
  }, { severity: "warning", code: "OLD", message: "existing warning" });
  const worsened = { ...existing, severity: "error" };
  const possible = diagnostic(otherPath, {
    start: { line: 4, character: 1 },
    end: { line: 4, character: 5 },
  }, { severity: "warning", code: "NEW", message: "new cross-file failure" });
  const attributed = diagnostic(targetPath, {
    start: { line: 8, character: 1 },
    end: { line: 8, character: 5 },
  }, { code: "RELATED", message: "attributed cascade" });
  const touchedDiagnostic = diagnostic(touchedPath, {
    start: { line: 10, character: 1 },
    end: { line: 10, character: 5 },
  }, { code: "LOCAL", message: "local failure" });
  const touchedRanges = [touched(touchedPath, 10)];

  const delta = workspaceDiagnosticDelta({
    beforeSnapshot: createDiagnosticSnapshot([existing]),
    afterSnapshot: createDiagnosticSnapshot([worsened, possible, attributed, touchedDiagnostic]),
    touchedRanges,
    linkedDiagnostics: [{
      diagnostic: attributed,
      linkReason: "cascade-related",
      touchedRange: touchedRanges[0],
      isNewOrWorsened: true,
    }],
    maxDiagnostics: 1,
  });

  assert.ok(delta);
  assert.equal(delta.label, "possible workspace impact");
  assert.deepEqual(delta.diagnostics.map((entry) => entry.code), ["OLD"]);
  assert.deepEqual(delta.summary, {
    totalNewOrWorsened: 2,
    shownDiagnostics: 1,
    hiddenByLimit: 1,
  });

  assert.equal(workspaceDiagnosticDelta({
    afterSnapshot: createDiagnosticSnapshot([possible]),
    touchedRanges,
    maxDiagnostics: 8,
  }), undefined, "a missing before snapshot must not manufacture a possible impact");

  const boundedMessage = workspaceDiagnosticDelta({
    beforeSnapshot: createDiagnosticSnapshot([]),
    afterSnapshot: createDiagnosticSnapshot([diagnostic(otherPath, {
      start: { line: 1, character: 1 },
      end: { line: 1, character: 2 },
    }, { code: "LONG", message: "x".repeat(10_000) })]),
    touchedRanges,
    maxDiagnostics: 8,
  });
  assert.ok(boundedMessage);
  assert.equal(boundedMessage.diagnostics[0].message.length, 1_000);
  assert.equal(boundedMessage.diagnostics[0].relatedInformation, undefined);
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

test("oversized tool diffs record skipped provenance and fall back to content diff", () => {
  const filePath = "/tmp/pi-code-feedback-large-diff.ts";
  const result = computeTouchedRanges({
    filePath,
    beforeContent: "export const value = 1;\n",
    afterContent: "export const value = 2;\n",
    toolName: "edit",
    detailsDiff: "+".repeat(1_000_001),
  });

  assert.equal(result.computation.source, "content-diff");
  assert.equal(result.computation.toolDiff.present, true);
  assert.equal(result.computation.toolDiff.used, false);
  assert.equal(result.computation.toolDiff.skippedReason, "too-large");
  assert.equal(result.ranges.length, 1);
  assert.equal(result.ranges[0].source, "content-diff");
});

test("diagnostics status reports the range source actually used", () => {
  const filePath = "/tmp/probe.ts";
  const runtime = createRuntime(createDefaultConfig());
  setProjectRoot(runtime, "/tmp");
  runtime.completedEdits.push({
    id: "edit-1",
    toolName: "edit",
    filePath,
    beforeContent: "one\n",
    afterContent: "two\n",
    touchedRanges: [{
      uri: uri(filePath),
      filePath,
      startLine: 1,
      endLine: 1,
      source: "content-diff",
      confidence: "exact",
    }],
    turnIndex: 1,
    writeIndex: 1,
    startedAt: 1,
    completedAt: 2,
    rangeComputation: {
      source: "content-diff",
      confidence: "exact",
      toolDiff: { present: true, used: false, skippedReason: "too-large", minBytes: 1_000_001, limitBytes: 1_000_000 },
    },
  });

  const text = renderDiagnosticsStatus(runtime);
  assert.match(text, /content diff \(tool diff too large\)/);
  assert.doesNotMatch(text, /\[edit, tool diff\]/);
});

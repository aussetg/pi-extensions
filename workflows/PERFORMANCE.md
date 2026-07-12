# Performance notes

The extension exposes one bounded progress/result renderer derived from the current run record.

- At most `RENDER_LIMITS.progressCalls` recent calls and `RENDER_LIMITS.progressLogs` logs are shown.
- Run-manager and artifact previews have fixed row limits.
- Components cache output by width and run revision.
- Rendering never scans Pi session history, workflow journals, transcripts, or repository files.

Rendering is therefore O(1) with respect to session and run history. This document makes no claim
about model quality or end-to-end workflow speed; those require task-level benchmarks.

export const inactiveLspService = {
  cachedDiagnosticsIfKnown() { return undefined; },
  prewarm() {},
  notifyFileMutations() {},
  forgetFile() {},
  async diagnosticsForFileDetailed() { return undefined; },
  async reconcileOpenDocuments() { return { mutations: [] }; },
};

export const inactiveFormatService = {
  configure() {},
  getStatus() { return { recentRuns: [], commands: [] }; },
  async formatFile(_filePath, content) {
    return { changed: false, finalContent: content, errors: [], skippedReason: "disabled in test" };
  },
};

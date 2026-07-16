export type LspFileMutation =
  | { type: "created"; filePath: string }
  | { type: "changed"; filePath: string }
  | { type: "deleted"; filePath: string }
  | { type: "renamed"; oldFilePath: string; newFilePath: string };

export const MAX_RECONCILED_OPEN_DOCUMENTS = 100;
export const MAX_RECONCILED_OPEN_DOCUMENT_BYTES = 2 * 1024 * 1024;
export const MAX_RECONCILED_OPEN_DOCUMENT_TOTAL_BYTES = 16 * 1024 * 1024;

export interface OpenDocumentReconciliationOptions {
  limit?: number;
  signal?: AbortSignal;
}

export interface OpenDocumentReconciliationResult {
  candidateFiles: number;
  inspectedFiles: number;
  changedFiles: number;
  deletedFiles: number;
  skippedFiles: number;
  resynchronizedDocuments: number;
  closedDocuments: number;
  bytesRead: number;
  fileLimitReached: boolean;
  byteLimitReached: boolean;
  mutations: LspFileMutation[];
}

export function lspFileMutationPaths(mutation: LspFileMutation): readonly string[] {
  return mutation.type === "renamed"
    ? [mutation.oldFilePath, mutation.newFilePath]
    : [mutation.filePath];
}

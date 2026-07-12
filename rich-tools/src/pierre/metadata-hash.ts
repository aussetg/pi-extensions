import { createHash, type Hash } from "node:crypto";
import type { FileDiffMetadata } from "../../node_modules/@pierre/diffs/dist/types.js";
import { hashStringArrayPart, hashStringPart } from "../hash.ts";

export type FileDiffMetadataKeyParts = {
  contentKey: string;
  hunksKey: string;
};

export function fileDiffMetadataKeyParts(
  metadata: FileDiffMetadata,
): FileDiffMetadataKeyParts {
  return {
    contentKey: fileDiffMetadataContentKey(metadata),
    hunksKey: fileDiffMetadataHunksKey(metadata),
  };
}

export function fileDiffMetadataContentKey(
  metadata: FileDiffMetadata,
): string {
  const hash = createHash("sha256");
  hashFileDiffMetadataContent(hash, metadata);
  return `content:${hash.digest("hex").slice(0, 24)}`;
}

export function fileDiffMetadataHunksKey(
  metadata: FileDiffMetadata,
): string {
  const hash = createHash("sha256");
  hashFileDiffMetadataHunks(hash, metadata);
  return `hunks:${hash.digest("hex").slice(0, 24)}`;
}

export function hashFileDiffMetadataContent(
  hash: Hash,
  metadata: FileDiffMetadata,
): void {
  hashStringPart(hash, metadata.name);
  hashStringPart(hash, metadata.prevName ?? "");
  hashStringPart(hash, metadata.type);
  hashStringPart(hash, metadata.lang ?? "");
  hashStringArrayPart(hash, metadata.deletionLines);
  hashStringArrayPart(hash, metadata.additionLines);
}

export function hashFileDiffMetadataHunks(
  hash: Hash,
  metadata: FileDiffMetadata,
): void {
  hashStringPart(hash, metadata.isPartial ? "1" : "0");
  hashStringPart(hash, String(metadata.hunks.length));
  for (const hunk of metadata.hunks) {
    hashStringPart(hash, "h");
    hashStringPart(hash, String(hunk.collapsedBefore));
    hashStringPart(hash, String(hunk.additionStart));
    hashStringPart(hash, String(hunk.additionCount));
    hashStringPart(hash, String(hunk.additionLineIndex));
    hashStringPart(hash, String(hunk.deletionStart));
    hashStringPart(hash, String(hunk.deletionCount));
    hashStringPart(hash, String(hunk.deletionLineIndex));
    hashStringPart(hash, hunk.noEOFCRDeletions ? "1" : "0");
    hashStringPart(hash, hunk.noEOFCRAdditions ? "1" : "0");
    hashStringPart(hash, hunk.hunkSpecs ?? "");
    hashStringPart(hash, String(hunk.hunkContent.length));
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        hashStringPart(hash, "c");
        hashStringPart(hash, String(content.lines));
        hashStringPart(hash, String(content.deletionLineIndex));
        hashStringPart(hash, String(content.additionLineIndex));
      } else {
        hashStringPart(hash, "x");
        hashStringPart(hash, String(content.deletions));
        hashStringPart(hash, String(content.deletionLineIndex));
        hashStringPart(hash, String(content.additions));
        hashStringPart(hash, String(content.additionLineIndex));
      }
    }
  }
}

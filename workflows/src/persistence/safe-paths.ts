import fs from "node:fs";

export async function readBoundedTextFile(filePath: string, maxBytes: number): Promise<string> {
  const before = await fs.promises.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`unsafe file: ${filePath}`);
  if (before.size > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes: ${filePath}`);

  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`unsafe file: ${filePath}`);
    if (stat.size > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes: ${filePath}`);

    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, maxBytes + 1)));
    let total = 0;
    while (total <= maxBytes) {
      const remaining = maxBytes + 1 - total;
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes: ${filePath}`);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total)); }
    catch { throw new Error(`file is not valid UTF-8: ${filePath}`); }
  } finally {
    await handle.close();
  }
}

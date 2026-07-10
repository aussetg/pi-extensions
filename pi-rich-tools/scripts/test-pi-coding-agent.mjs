export const DEFAULT_MAX_BYTES = 50 * 1024;
export const DEFAULT_MAX_LINES = 2_000;

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function keyHint(_binding, description) {
  return description;
}

export function keyText(binding) {
  return binding;
}

function builtInToolDefinition(name, options = {}) {
  return {
    name,
    label: name,
    description: `${name} test tool`,
    parameters: {},
    async execute() {
      return { content: [], details: undefined };
    },
    ...options,
  };
}

export function createBashTool(_cwd, options = {}) {
  return builtInToolDefinition("bash", options);
}

export function createReadToolDefinition() {
  return builtInToolDefinition("read");
}

export function createWriteToolDefinition() {
  return builtInToolDefinition("write");
}

export function createEditToolDefinition() {
  return builtInToolDefinition("edit");
}

export function truncateHead(text, options = {}) {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const lines = text ? text.split("\n") : [];
  if (text.endsWith("\n")) lines.pop();

  const totalLines = lines.length;
  const totalBytes = Buffer.byteLength(text);
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content: text,
      truncated: false,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
    };
  }

  const output = [];
  let bytes = 0;
  for (const line of lines.slice(0, maxLines)) {
    const nextBytes = Buffer.byteLength(line) + (output.length > 0 ? 1 : 0);
    if (bytes + nextBytes > maxBytes) break;
    output.push(line);
    bytes += nextBytes;
  }
  const content = output.join("\n");
  return {
    content,
    truncated: true,
    totalLines,
    totalBytes,
    outputLines: output.length,
    outputBytes: Buffer.byteLength(content),
  };
}

export async function withFileMutationQueue(_path, mutation) {
  return mutation();
}

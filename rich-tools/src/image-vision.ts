import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
// @ts-ignore The pi runtime provides the compat entrypoint to extensions.
import { complete, type Message } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

declare const Buffer: any;
declare const process: { env: Record<string, string | undefined> };
type BinaryBuffer = any;

/**
 * Extension for image vision support.
 *
 * When the current model doesn't support vision:
 * 1. Activates the `read_image` tool (deactivates it when vision is available)
 * 2. Intercepts `read` tool results containing images and tells the model to use `read_image`
 *
 * Configuration via $PI_CODING_AGENT_DIR/vision-config.json (default: ~/.pi/agent/vision-config.json):
 * {
 *   "model": "GLM-5V",           // Vision model ID to use
 *   "provider": "zai",          // Provider (optional, inferred from model)
 *   "imagePreset": "high",      // local resize policy: low, high, auto, or preserve; default high
 *   "apiDetail": "auto",        // optional API hint: low, high, auto, or omit; omitted by default
 *   "maxRawBytes": 104857600,    // hard local input cap; default 100 MiB
 *   "maxPayloadBytes": 10485760, // post-resize upload cap; default 10 MiB
 *   "maxDimension": 2048         // optional explicit local dimension cap
 * }
 *
 * Legacy "detail" is still accepted: low/high/auto map to both local preset and API hint;
 * original maps to local preserve plus API auto.
 */

interface VisionConfig {
  model?: string;
  provider?: string;
  detail?: LegacyImageDetail;
  imagePreset?: LocalImagePreset | "original";
  apiDetail?: ApiImageDetail | "omit";
  maxRawBytes?: number;
  maxPayloadBytes?: number;
  maxDimension?: number;
}

type ApiImageDetail = "low" | "high" | "auto";
type LegacyImageDetail = ApiImageDetail | "original";
type LocalImagePreset = "low" | "high" | "auto" | "preserve";

interface ResolvedImageConfig {
  localPreset: LocalImagePreset;
  apiDetail?: ApiImageDetail;
  maxRawBytes: number;
  maxPayloadBytes: number;
  maxDimension: number;
  resizeByDimension: boolean;
}

interface ImageDimensions {
  width: number;
  height: number;
}

interface PreparedImage {
  buffer: BinaryBuffer;
  mimeType: string;
  localPreset: LocalImagePreset;
  apiDetail?: ApiImageDetail;
  resized: boolean;
  originalBytes: number;
  inputBytes: number;
  originalDimensions?: ImageDimensions;
  inputDimensions?: ImageDimensions;
  note?: string;
}

interface VisionModelInfo {
  id: string;
  provider: string;
  input: string[];
}

interface ToolResultEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

interface ReadImageDetails {
  ok?: boolean;
  error?: string;
  visionModel: string;
  visionProvider: string;
  imagePath: string;
  prompt: string;
  imagePreset?: LocalImagePreset;
  apiDetail?: ApiImageDetail;
  detail?: LegacyImageDetail;
  resized?: boolean;
  originalBytes?: number;
  inputBytes?: number;
  originalDimensions?: string;
  inputDimensions?: string;
  imageNote?: string;
}

const TOOL_NAME = "read_image";
const CONFIG_FILE_NAME = "vision-config.json";
const DEFAULT_LOCAL_IMAGE_PRESET: LocalImagePreset = "high";
const RAW_IMAGE_HARD_LIMIT_BYTES = 100 * 1024 * 1024;
const VISION_IMAGE_PAYLOAD_LIMIT_BYTES = 10 * 1024 * 1024;
const IMAGE_DIMENSION_HEADER_BYTES = 512 * 1024;

let cachedConfig: { path: string; mtimeMs: number; config: VisionConfig } | undefined;
let cachedImageMagickCommand: string | null | undefined;

function loadConfig(): VisionConfig {
  try {
    const configPath = visionConfigPath();
    const stat = fs.statSync(configPath);
    if (!stat.isFile()) return {};
    if (cachedConfig?.path === configPath && cachedConfig.mtimeMs === stat.mtimeMs) return cachedConfig.config;
    const content = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(content) as VisionConfig;
    cachedConfig = { path: configPath, mtimeMs: stat.mtimeMs, config };
    return config;
  } catch (err) {
    // Ignore errors, fall back to defaults
  }
  return {};
}

function visionConfigPath(): string {
  return path.join(process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), CONFIG_FILE_NAME);
}

function resolveImageConfig(config: VisionConfig): ResolvedImageConfig {
  const localPreset = localPresetFromConfig(config);
  const explicitMaxDimension = optionalPositiveLimit(config.maxDimension);
  return {
    localPreset,
    apiDetail: requestedApiDetailFromConfig(config),
    maxRawBytes: positiveLimit(config.maxRawBytes, RAW_IMAGE_HARD_LIMIT_BYTES),
    maxPayloadBytes: positiveLimit(config.maxPayloadBytes, VISION_IMAGE_PAYLOAD_LIMIT_BYTES),
    maxDimension: Math.max(1, Math.trunc(explicitMaxDimension ?? maxDimensionForLocalPreset(localPreset))),
    resizeByDimension: explicitMaxDimension !== undefined || localPreset !== "preserve",
  };
}

function localPresetFromConfig(config: VisionConfig): LocalImagePreset {
  const raw = config.imagePreset ?? config.detail;
  if (raw === "low" || raw === "high" || raw === "auto" || raw === "preserve") return raw;
  if (raw === "original") return "preserve";
  return DEFAULT_LOCAL_IMAGE_PRESET;
}

function requestedApiDetailFromConfig(config: VisionConfig): ApiImageDetail | undefined {
  // API-level image detail is provider-specific. Send it only when explicitly
  // configured instead of guessing from OpenAI-compatible transport names.
  if (config.apiDetail === "omit") return undefined;
  if (config.apiDetail === "low" || config.apiDetail === "high" || config.apiDetail === "auto") return config.apiDetail;
  if (config.imagePreset === undefined) {
    if (config.detail === "low" || config.detail === "high" || config.detail === "auto") return config.detail;
    if (config.detail === "original") return "auto";
  }
  return undefined;
}

function maxDimensionForLocalPreset(preset: LocalImagePreset): number {
  switch (preset) {
    case "low":
      return 768;
    case "high":
      return 2048;
    case "auto":
    case "preserve":
      return 6000;
  }
}

async function prepareImageForVision(filePath: string, config: VisionConfig, signal?: AbortSignal): Promise<PreparedImage> {
  const options = resolveImageConfig(config);
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`Image path is not a regular file: ${filePath}`);
  if (stat.size > options.maxRawBytes) {
    throw new Error(`Image file is too large to read locally: ${formatBytes(stat.size)} > ${formatBytes(options.maxRawBytes)}`);
  }

  const originalDimensions = readImageDimensions(filePath, stat.size);
  const targetMax = options.maxDimension;
  const exceedsDimension = options.resizeByDimension && originalDimensions ? Math.max(originalDimensions.width, originalDimensions.height) > targetMax : false;
  const exceedsPayload = stat.size > options.maxPayloadBytes;
  const originalMimeType = mimeTypeForPath(filePath);

  if (exceedsDimension || exceedsPayload) {
    try {
      const resized = await resizeImageWithImageMagick(filePath, targetMax, options.maxPayloadBytes, signal);
      const inputDimensions = imageDimensionsFromBuffer(resized) ?? scaledDimensions(originalDimensions, targetMax);
      if (resized.length > options.maxPayloadBytes) {
        throw new Error(`resized image is still too large: ${formatBytes(resized.length)} > ${formatBytes(options.maxPayloadBytes)}`);
      }
      return {
        buffer: resized,
        mimeType: "image/jpeg",
        localPreset: options.localPreset,
        apiDetail: options.apiDetail,
        resized: true,
        originalBytes: stat.size,
        inputBytes: resized.length,
        originalDimensions,
        inputDimensions,
        note: `resized for ${options.localPreset} preset`,
      };
    } catch (err) {
      throw new Error(`${resizeRequirementSummary(options, stat.size, originalDimensions)}; resize failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const buffer = fs.readFileSync(filePath);
  if (buffer.length > options.maxPayloadBytes) {
    throw new Error(`Image payload is too large: ${formatBytes(buffer.length)} > ${formatBytes(options.maxPayloadBytes)}`);
  }
  return {
    buffer,
    mimeType: originalMimeType,
    localPreset: options.localPreset,
    apiDetail: options.apiDetail,
    resized: false,
    originalBytes: stat.size,
    inputBytes: buffer.length,
    originalDimensions,
    inputDimensions: originalDimensions ?? imageDimensionsFromBuffer(buffer),
  };
}

function positiveLimit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function optionalPositiveLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function resizeRequirementSummary(options: ResolvedImageConfig, originalBytes: number, dimensions: ImageDimensions | undefined): string {
  if (originalBytes > options.maxPayloadBytes) {
    return `Image exceeds payload limit (${formatBytes(originalBytes)} > ${formatBytes(options.maxPayloadBytes)})`;
  }
  if (dimensions && Math.max(dimensions.width, dimensions.height) > options.maxDimension) {
    return `Image exceeds ${options.localPreset} dimension limit (${formatDimensions(dimensions)} > ${options.maxDimension}px)`;
  }
  return "Image resize is required";
}

function mimeTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };
  return mimeTypes[ext] || "image/png";
}

function readImageDimensions(filePath: string, size: number): ImageDimensions | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const bytesToRead = Math.min(Math.max(0, size), IMAGE_DIMENSION_HEADER_BYTES);
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0);
    return imageDimensionsFromBuffer(buffer.subarray(0, bytesRead));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors while reading best-effort metadata.
      }
    }
  }
}

function imageDimensionsFromBuffer(buffer: BinaryBuffer): ImageDimensions | undefined {
  return pngDimensions(buffer) ?? jpegDimensions(buffer) ?? gifDimensions(buffer) ?? webpDimensions(buffer);
}

function pngDimensions(buffer: BinaryBuffer): ImageDimensions | undefined {
  if (buffer.length < 24) return undefined;
  if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) return undefined;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function gifDimensions(buffer: BinaryBuffer): ImageDimensions | undefined {
  if (buffer.length < 10) return undefined;
  const signature = buffer.toString("ascii", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return undefined;
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

function jpegDimensions(buffer: BinaryBuffer): ImageDimensions | undefined {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (offset + 1 >= buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    offset += 2;
    if (length < 2 || offset + length - 2 > buffer.length) break;
    if (isJpegStartOfFrame(marker) && offset + 5 < buffer.length) {
      return { height: buffer.readUInt16BE(offset + 1), width: buffer.readUInt16BE(offset + 3) };
    }
    offset += length - 2;
  }
  return undefined;
}

function isJpegStartOfFrame(marker: number): boolean {
  return (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
}

function webpDimensions(buffer: BinaryBuffer): ImageDimensions | undefined {
  if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return undefined;
  const type = buffer.toString("ascii", 12, 16);
  if (type === "VP8X" && buffer.length >= 30) {
    return { width: readUInt24LE(buffer, 24) + 1, height: readUInt24LE(buffer, 27) + 1 };
  }
  if (type === "VP8 " && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (type === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

function readUInt24LE(buffer: BinaryBuffer, offset: number): number {
  return buffer[offset]! | (buffer[offset + 1]! << 8) | (buffer[offset + 2]! << 16);
}

function scaledDimensions(dimensions: ImageDimensions | undefined, maxDimension: number): ImageDimensions | undefined {
  if (!dimensions) return undefined;
  const scale = Math.min(1, maxDimension / Math.max(dimensions.width, dimensions.height));
  return {
    width: Math.max(1, Math.round(dimensions.width * scale)),
    height: Math.max(1, Math.round(dimensions.height * scale)),
  };
}

async function resizeImageWithImageMagick(filePath: string, maxDimension: number, outputLimit: number, signal?: AbortSignal): Promise<BinaryBuffer> {
  const command = findImageMagickCommand();
  if (!command) throw new Error("ImageMagick not found (need magick or convert)");
  if (signal?.aborted) throw new Error("Image analysis was cancelled.");
  const { spawn } = await import("node:" + "child_process") as any;

  const inputPath = `${filePath}[0]`;
  const args = [
    inputPath,
    "-auto-orient",
    "-resize",
    `${maxDimension}x${maxDimension}>`,
    "-strip",
    "-background",
    "white",
    "-alpha",
    "remove",
    "-alpha",
    "off",
    "jpeg:-",
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: BinaryBuffer[] = [];
    const stderr: BinaryBuffer[] = [];
    let bytes = 0;
    let settled = false;

    const finish = (err: Error | undefined, buffer?: BinaryBuffer) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else if (!buffer || buffer.length === 0) reject(new Error("ImageMagick produced no output"));
      else resolve(buffer);
    };
    const onAbort = () => {
      child.kill();
      finish(new Error("Image analysis was cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: BinaryBuffer) => {
      bytes += chunk.length;
      if (bytes > outputLimit) {
        child.kill();
        finish(new Error(`resized image exceeds payload budget (${formatBytes(bytes)} > ${formatBytes(outputLimit)})`));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: BinaryBuffer) => stderr.push(chunk));
    child.on("error", (err: Error) => finish(err));
    child.on("close", (code: number | null) => {
      if (settled) return;
      if (code !== 0) {
        const message = Buffer.concat(stderr).toString("utf8").trim() || `ImageMagick exited with code ${code}`;
        finish(new Error(message));
        return;
      }
      finish(undefined, Buffer.concat(chunks));
    });
  });
}

function findImageMagickCommand(): string | null {
  if (cachedImageMagickCommand !== undefined) return cachedImageMagickCommand;
  for (const command of ["magick", "convert"]) {
    const resolved = findOnPath(command);
    if (resolved) {
      cachedImageMagickCommand = resolved;
      return resolved;
    }
  }
  cachedImageMagickCommand = null;
  return null;
}

function findOnPath(command: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep searching
    }
  }
  return undefined;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib >= 10 ? kib.toFixed(0) : kib.toFixed(1)} KiB`;
  const mib = kib / 1024;
  return `${mib >= 10 ? mib.toFixed(0) : mib.toFixed(1)} MiB`;
}

function formatDimensions(dimensions: ImageDimensions | undefined): string | undefined {
  return dimensions ? `${dimensions.width}×${dimensions.height}` : undefined;
}

function imageDetails(base: ReadImageDetails, image?: PreparedImage): ReadImageDetails {
  if (!image) return base;
  return {
    ...base,
    imagePreset: image.localPreset,
    apiDetail: image.apiDetail,
    resized: image.resized,
    originalBytes: image.originalBytes,
    inputBytes: image.inputBytes,
    originalDimensions: formatDimensions(image.originalDimensions),
    inputDimensions: formatDimensions(image.inputDimensions),
    imageNote: image.note,
  };
}

function readImageErrorResult(text: string, details: Omit<ReadImageDetails, "ok" | "error">) {
  return {
    content: [{ type: "text" as const, text }],
    details: { ...details, ok: false, error: text } as ReadImageDetails,
    isError: true,
  };
}

function isReadImageErrorDetails(details: unknown): details is ReadImageDetails & { ok: false } {
  return Boolean(details && typeof details === "object" && (details as { ok?: unknown }).ok === false);
}

function imagePreparationSummary(details: ReadImageDetails | undefined): string {
  if (!details) return "";
  const localPreset = details.imagePreset ?? legacyLocalPreset(details.detail);
  if (!localPreset) return "";
  const size = details.originalBytes !== undefined && details.inputBytes !== undefined && details.originalBytes !== details.inputBytes
    ? `${formatBytes(details.originalBytes)}→${formatBytes(details.inputBytes)}`
    : details.inputBytes !== undefined
      ? formatBytes(details.inputBytes)
      : "";
  const dimensions = details.originalDimensions && details.inputDimensions && details.originalDimensions !== details.inputDimensions
    ? `${details.originalDimensions}→${details.inputDimensions}`
    : details.inputDimensions ?? details.originalDimensions ?? "";
  const apiDetail = details.apiDetail ? `api ${details.apiDetail}` : "";
  return [`${localPreset} preset`, apiDetail, dimensions, size, details.resized ? "resized" : "original"].filter(Boolean).join(", ");
}

function legacyLocalPreset(detail: LegacyImageDetail | undefined): LocalImagePreset | undefined {
  if (detail === "original") return "preserve";
  return detail;
}

function firstLines(text: string, maxLines: number): { text: string; truncated: boolean } {
  let lines = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 10) continue;
    lines += 1;
    if (lines >= maxLines) return { text: text.slice(0, index), truncated: true };
  }
  return { text, truncated: false };
}

async function findVisionModel(ctx: ExtensionContext): Promise<{ provider: string; model: string } | null> {
  // Load config from file
  const config = loadConfig();

  // getAvailable() returns Model[] directly, each model has a provider property
  const available = ctx.modelRegistry.getAvailable() as VisionModelInfo[];

  if (config.model) {
    // Find the model in the registry
    const found = available.find((m) => m.id === config.model && m.input.includes("image"));
    if (found) {
      return { provider: config.provider ?? found.provider, model: found.id };
    }
    // Fall through to auto-detect if config model not found
  }

  // Find first available vision model (prefer GLM-5V, then faster/cheaper models)
  const preferredPatterns = ["GLM-5V", "claude-3-5-haiku", "gpt-4o-mini", "gemini-2.0-flash", "haiku", "flash"];
  for (const pattern of preferredPatterns) {
    const found = available.find((m) => m.id.includes(pattern) && m.input.includes("image"));
    if (found) {
      return { provider: found.provider, model: found.id };
    }
  }

  // Fall back to any vision model
  const anyVision = available.find((m) => m.input.includes("image"));
  if (anyVision) {
    return { provider: anyVision.provider, model: anyVision.id };
  }

  return null;
}

export function registerImageVision(pi: ExtensionAPI): void {
  // Register the tool once at startup
  pi.registerTool({
    name: TOOL_NAME,
    label: "Read Image",
    description:
      "Analyze an image file using a vision-capable model. Use this when you need to understand, describe, or answer questions about an image.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the image file (relative or absolute)" }),
      prompt: Type.String({
        description: 'What you want to know about the image, e.g., "Describe this image" or "What text is shown?"',
      }),
    }),

    async execute(
      _toolCallId: string,
      params: { path: string; prompt: string },
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const visionConfig = await findVisionModel(ctx);

      if (!visionConfig) {
        return readImageErrorResult(
          `No vision-capable model available. Configure a vision model in ${visionConfigPath()} or switch to a model that supports images using /model.`,
          {
            visionModel: "none",
            visionProvider: "none",
            imagePath: params.path,
            prompt: params.prompt,
          },
        );
      }

      const { provider, model: visionModelId } = visionConfig;
      const model = ctx.modelRegistry.find(provider, visionModelId);

      if (!model) {
        return readImageErrorResult(`Vision model ${provider}/${visionModelId} not found in registry.`, {
          visionModel: visionModelId,
          visionProvider: provider,
          imagePath: params.path,
          prompt: params.prompt,
        });
      }

      // Resolve path
      const imagePath = params.path.startsWith("@") ? params.path.slice(1) : params.path;
      const absolutePath = imagePath.startsWith("/") ? imagePath : path.join(ctx.cwd, imagePath);

      // Check file exists
      if (!fs.existsSync(absolutePath)) {
        return readImageErrorResult(`Image file not found: ${params.path}`, {
          visionModel: visionModelId,
          visionProvider: provider,
          imagePath: params.path,
          prompt: params.prompt,
        });
      }

      // Get API key & headers before doing potentially expensive local resize work.
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) {
        return readImageErrorResult(
          auth.ok
            ? `No API key available for vision model ${provider}/${visionModelId}. Run /login or set the appropriate environment variable.`
            : `Auth error for vision model ${provider}/${visionModelId}: ${auth.error}`,
          {
            visionModel: visionModelId,
            visionProvider: provider,
            imagePath: params.path,
            prompt: params.prompt,
          },
        );
      }

      // Prepare image payload. The model would resize server-side, but doing the
      // same obvious resize locally avoids giant base64 bodies and slow uploads.
      let preparedImage: PreparedImage;

      try {
        preparedImage = await prepareImageForVision(absolutePath, loadConfig(), signal);
      } catch (err) {
        return readImageErrorResult(`Failed to prepare image: ${err instanceof Error ? err.message : String(err)}`, {
          visionModel: visionModelId,
          visionProvider: provider,
          imagePath: params.path,
          prompt: params.prompt,
        });
      }

      const imageBuffer = preparedImage.buffer;
      const mimeType = preparedImage.mimeType;
      const imageContent: Record<string, unknown> = {
        type: "image",
        data: imageBuffer.toString("base64"),
        mimeType,
      };
      if (preparedImage.apiDetail) imageContent.detail = preparedImage.apiDetail;

      // Build message for vision model
      const userMessage: Message = {
        role: "user",
        content: [
          { type: "text", text: params.prompt },
          imageContent as any,
        ],
        timestamp: Date.now(),
      };

      // Call vision model
      try {
        const response = await complete(model, { messages: [userMessage] }, { apiKey: auth.apiKey, headers: auth.headers, signal });

        if (response.stopReason === "aborted") {
          return {
            content: [{ type: "text", text: "Image analysis was cancelled." }],
            details: imageDetails({
              visionModel: visionModelId,
              visionProvider: provider,
              imagePath: params.path,
              prompt: params.prompt,
            }, preparedImage) as ReadImageDetails,
          };
        }

        // Handle error stop reason
        if (response.stopReason === "error") {
          const errorMsg = response.errorMessage || "Unknown error from vision model";
          return readImageErrorResult(`Vision model error: ${errorMsg}`, imageDetails({
            visionModel: visionModelId,
            visionProvider: provider,
            imagePath: params.path,
            prompt: params.prompt,
          }, preparedImage));
        }

        // Extract text response
        const textContent = response.content
          .filter((c: any): c is { type: "text"; text: string } => c.type === "text")
          .map((c: { text: string }) => c.text)
          .join("\n");

        return {
          content: [{ type: "text", text: textContent || "(no response from vision model)" }],
          details: imageDetails({
            visionModel: visionModelId,
            visionProvider: provider,
            imagePath: params.path,
            prompt: params.prompt,
          }, preparedImage) as ReadImageDetails,
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return readImageErrorResult(`Vision model error: ${errorMsg}`, imageDetails({
          visionModel: visionModelId,
          visionProvider: provider,
          imagePath: params.path,
          prompt: params.prompt,
        }, preparedImage));
      }
    },

    renderCall(args: { path: string; prompt: string }, theme: any) {
      const pathPreview = args.path.length > 50 ? `...${args.path.slice(-47)}` : args.path;
      const promptPreview = args.prompt.length > 60 ? `${args.prompt.slice(0, 60)}...` : args.prompt;
      return new Text(
        theme.fg("toolTitle", theme.bold("read_image ")) +
          theme.fg("accent", pathPreview) +
          "\n  " +
          theme.fg("dim", promptPreview),
        0,
        0,
      );
    },

    renderResult(result: any, { expanded }: { expanded: boolean }, theme: any, context: any) {
      const details = result.details as ReadImageDetails | undefined;
      const text = result.content[0]?.type === "text" ? result.content[0].text : "(no output)";

      if (context?.isError || result.isError || isReadImageErrorDetails(details)) {
        return new Text(theme.fg("error", "✗ ") + theme.fg("toolOutput", text), 0, 0);
      }

      if (expanded) {
        const prep = imagePreparationSummary(details);
        const via = details
          ? ` (via ${details.visionProvider}/${details.visionModel}${prep ? `, ${prep}` : ""})`
          : "";
        return new Text(theme.fg("success", "✓") + theme.fg("muted", via) + "\n\n" + theme.fg("toolOutput", text), 0, 0);
      }

      // Collapsed view
      const previewLines = firstLines(text, 3);
      const preview = previewLines.text + (previewLines.truncated ? "\n..." : "");
      const via = details ? ` ${theme.fg("muted", `(${details.visionProvider}/${details.visionModel})`)}` : "";
      return new Text(theme.fg("success", "✓") + via + "\n" + theme.fg("toolOutput", preview), 0, 0);
    },
  });

  // Helper to update tool activation based on model
  const updateToolActivation = (ctx: ExtensionContext, silent = false) => {
    const model = ctx.model;
    if (!model) return;

    const supportsVision = model.input.includes("image");
    const activeTools = pi.getActiveTools();
    const toolInActive = activeTools.includes(TOOL_NAME);

    if (!supportsVision && !toolInActive) {
      // Non-vision model and tool not active - activate it
      pi.setActiveTools([...activeTools, TOOL_NAME]);
      if (!silent) ctx.ui.notify("read_image tool enabled (non-vision model)", "info");
    } else if (supportsVision && toolInActive) {
      // Vision model and tool is active - deactivate it
      pi.setActiveTools(activeTools.filter((t: string) => t !== TOOL_NAME));
      if (!silent) ctx.ui.notify("read_image tool disabled (vision model active)", "info");
    }
  };

  // Check on session start
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    updateToolActivation(ctx, true); // silent on startup
  });

  // Check when model changes
  pi.on("model_select", async (_event: unknown, ctx: ExtensionContext) => {
    updateToolActivation(ctx);
  });

  // Also check before each agent turn to ensure correct state
  pi.on("before_agent_start", async (_event: unknown, ctx: ExtensionContext) => {
    updateToolActivation(ctx, true);
  });

  // Intercept read tool results with images
  pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
    if (event.toolName === TOOL_NAME && isReadImageErrorDetails(event.details)) return { isError: true };

    // Only interested in read tool results
    if (event.toolName !== "read") return;

    // Check if result contains an image
    const hasImage = event.content.some((c) => c.type === "image");
    if (!hasImage) return;

    // Check if current model supports images
    const model = ctx.model;
    if (!model) return;

    const supportsImages = model.input.includes("image");
    if (supportsImages) return;

    // Model doesn't support images - tell the model to use read_image
    const imagePath = (event.input.path as string) || "the image file";

    // Remove image content and replace with instructions
    event.content = [
      {
        type: "text",
        text: `[The current model (${model.provider}/${model.id}) cannot view images. The image has been loaded but cannot be displayed to this model.\n\nTo analyze this image, use the read_image tool:\n\nread_image(path: "${imagePath}", prompt: "Your question about the image")\n\nThe read_image tool will use a vision-capable model to analyze the image and return the result to you.]`,
      },
    ];

    // Return the modified content
    return { content: event.content };
  });
}

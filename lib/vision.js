/**
 * Core vision client: turn an image (local path or URL) into a text answer
 * through Volcano Ark's OpenAI-compatible chat completions endpoint.
 *
 * The module is transport-agnostic on purpose: the DSH tool (index.js) and the
 * MCP stdio server (bin/mcp-server.js) both call analyzeImage().
 */
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export const DEFAULT_MODEL = 'doubao-seed-2-0-pro-260215';
export const DEFAULT_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3';
export const DEFAULT_PROMPT =
  'Describe this image in detail. If it contains text, read the text out. If it is a screenshot, ' +
  'explain what the interface shows and any errors or numbers visible.';
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Failure with a stable code the callers can branch on. */
export class VisionError extends Error {
  /**
   * @param {'E_CONFIG' | 'E_IMAGE' | 'E_AUTH' | 'E_UPSTREAM' | 'E_ALL_FAILED' | 'E_ABORTED'} code
   * @param {string} message
   * @param {{ status?: number, attempts?: unknown[], cause?: unknown }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = 'VisionError';
    this.code = code;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.attempts !== undefined) this.attempts = extra.attempts;
  }
}

const MIME_BY_MAGIC = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] },
  { mime: 'image/bmp', bytes: [0x42, 0x4d] },
];

const MIME_BY_EXTENSION = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

function detectMime(buffer, filePath) {
  for (const entry of MIME_BY_MAGIC) {
    if (entry.bytes.every((byte, index) => buffer[index] === byte)) return entry.mime;
  }
  const lower = filePath.toLowerCase();
  for (const [extension, mime] of Object.entries(MIME_BY_EXTENSION)) {
    if (lower.endsWith(extension)) return mime;
  }
  return undefined;
}

/**
 * Resolve the image argument into either a data URL (local file) or the
 * original http(s) URL / data URL (passed to the provider as-is).
 * @param {string} image
 * @param {{ cwd?: string }} [options]
 * @returns {Promise<string>}
 */
export async function resolveImageUrl(image, options = {}) {
  if (typeof image !== 'string' || image.trim() === '') {
    throw new VisionError('E_IMAGE', 'image must be a non-empty local path or http(s) URL');
  }
  const value = image.trim();
  if (/^https?:\/\//i.test(value) || /^data:image\//i.test(value)) return value;

  const filePath = resolve(options.cwd ?? process.cwd(), value);
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new VisionError('E_IMAGE', `image file not found: ${filePath}`);
  }
  if (!info.isFile()) throw new VisionError('E_IMAGE', `not a regular file: ${filePath}`);
  if (info.size > MAX_IMAGE_BYTES) {
    throw new VisionError(
      'E_IMAGE',
      `image is ${(info.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_IMAGE_BYTES / 1024 / 1024} MB`,
    );
  }
  const buffer = await readFile(filePath);
  const mime = detectMime(buffer, filePath);
  if (!mime) {
    throw new VisionError(
      'E_IMAGE',
      `unsupported image type for ${filePath}; use png, jpeg, webp, gif or bmp`,
    );
  }
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

/**
 * Parse VISION_MODELS. Entries are model ids, optionally prefixed with the
 * provider ("ark:"); the provider prefix only matters for the 401 rule.
 * @param {string | undefined} raw
 * @returns {{ provider: string, model: string }[]}
 */
export function parseModelChain(raw) {
  const text = typeof raw === 'string' && raw.trim() !== '' ? raw : DEFAULT_MODEL;
  const seen = new Set();
  const chain = [];
  for (const part of text.split(',')) {
    const entry = part.trim();
    if (entry === '') continue;
    const colon = entry.indexOf(':');
    const provider = colon > 0 ? entry.slice(0, colon).trim().toLowerCase() : 'ark';
    const model = colon > 0 ? entry.slice(colon + 1).trim() : entry;
    if (model === '') continue;
    const key = `${provider}:${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    chain.push({ provider: provider === 'volcano' || provider === 'volces' ? 'ark' : provider, model });
  }
  if (chain.length === 0) {
    throw new VisionError('E_CONFIG', 'VISION_MODELS is set but contains no usable model id');
  }
  return chain;
}

/**
 * One attempt against the Ark chat completions endpoint.
 * Throws VisionError with `retryable` set on transient failures, or code
 * E_AUTH for provider-wide authentication failures.
 */
async function requestModel({ model, endpoint, apiKey, imageUrl, prompt, signal, fetchImpl }) {
  const url = `${endpoint.replace(/\/+$/, '')}/chat/completions`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt || DEFAULT_PROMPT },
              { type: 'image_url', image_url: { url: imageUrl } },
            ],
          },
        ],
        temperature: 0.1,
        max_tokens: 2048,
        stream: false,
      }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new VisionError('E_ABORTED', 'vision request aborted', { cause: error });
    const retryable = error instanceof TypeError || error?.name === 'AbortError';
    throw Object.assign(
      new VisionError('E_UPSTREAM', `request to ${model} failed: ${error?.message ?? error}`, {
        cause: error,
      }),
      { retryable },
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const detail = body.slice(0, 300).replace(/\s+/g, ' ');
    const status = response.status;
    const authError = status === 401 || status === 403;
    const retryable =
      !authError && (status === 404 || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500);
    const error = new VisionError(
      authError ? 'E_AUTH' : 'E_UPSTREAM',
      `Ark rejected ${model} with HTTP ${status}${detail ? `: ${detail}` : ''}`,
      { status },
    );
    error.retryable = retryable;
    throw error;
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw Object.assign(
      new VisionError('E_UPSTREAM', `${model} returned a body that is not JSON`, { cause: error }),
      { retryable: true },
    );
  }
  let text = payload?.choices?.[0]?.message?.content;
  if (Array.isArray(text)) {
    text = text.map((part) => (typeof part === 'string' ? part : (part?.text ?? ''))).join('');
  }
  if (typeof text !== 'string' || text.trim() === '') {
    throw Object.assign(
      new VisionError('E_UPSTREAM', `${model} returned no text content`, { cause: payload }),
      { retryable: true },
    );
  }
  return { text: text.trim(), model, usage: payload?.usage };
}

/**
 * Ask a vision model about an image, walking VISION_MODELS on transient
 * failures. A 401/403 kills that provider for the rest of the call.
 *
 * @param {{
 *   image: string,
 *   prompt?: string,
 *   env?: Record<string, string | undefined>,
 *   fetchImpl?: typeof fetch,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   cwd?: string,
 * }} options
 * @returns {Promise<{ text: string, model: string, usage?: unknown }>}
 */
export async function analyzeImage(options) {
  const {
    image,
    prompt,
    env = process.env,
    fetchImpl = globalThis.fetch,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cwd,
  } = options ?? {};
  if (typeof fetchImpl !== 'function') {
    throw new VisionError('E_CONFIG', 'no fetch implementation available (Node 18+ required)');
  }
  const apiKey = env.VOLCANO_API_KEY ?? env.ARK_API_KEY;
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new VisionError(
      'E_CONFIG',
      'VOLCANO_API_KEY is not set. Create an API key in the Volcano Ark console and set it in the environment.',
    );
  }
  const endpoint = env.VOLCANO_ARK_BASE_URL ?? env.ARK_BASE_URL ?? DEFAULT_ENDPOINT;
  const chain = parseModelChain(env.VISION_MODELS);
  const imageUrl = await resolveImageUrl(image, { cwd });

  const deadProviders = new Set();
  const attempts = [];
  let authError;
  let hadNonAuthFailure = false;

  for (const candidate of chain) {
    if (deadProviders.has(candidate.provider)) continue;
    if (signal?.aborted) throw new VisionError('E_ABORTED', 'vision request aborted');
    const attemptSignal =
      typeof AbortSignal.any === 'function'
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean))
        : signal;
    try {
      return await requestModel({
        model: candidate.model,
        endpoint,
        apiKey,
        imageUrl,
        prompt,
        signal: attemptSignal,
        fetchImpl,
      });
    } catch (error) {
      if (error?.code === 'E_ABORTED') throw error;
      if (!(error instanceof VisionError)) throw error;
      if (error.code === 'E_AUTH') {
        deadProviders.add(candidate.provider);
        authError = error;
        attempts.push({ model: candidate.model, status: error.status, reason: 'auth' });
        continue;
      }
      const timedOut = attemptSignal?.aborted && !signal?.aborted;
      const retryable = error.retryable || timedOut;
      attempts.push({
        model: candidate.model,
        status: error.status,
        reason: timedOut ? 'timeout' : retryable ? 'transient' : 'fatal',
      });
      if (!retryable) throw error;
      hadNonAuthFailure = true;
    }
  }

  if (hadNonAuthFailure && deadProviders.size === 0) {
    throw new VisionError(
      'E_ALL_FAILED',
      `every model in VISION_MODELS failed: ${attempts.map((a) => `${a.model}(${a.reason}${a.status ? ` ${a.status}` : ''})`).join(', ')}`,
      { attempts },
    );
  }
  if (authError) {
    throw new VisionError(
      'E_AUTH',
      `Volcano Ark rejected the API key (${authError.status ?? 401}). Check VOLCANO_API_KEY. Tried: ${attempts
        .map((a) => a.model)
        .join(', ')}`,
      { status: authError.status, attempts, cause: authError },
    );
  }
  throw new VisionError('E_ALL_FAILED', 'no vision model could answer', { attempts });
}

export const TOOL_NAME = 'analyze_image';
export const TOOL_DESCRIPTION =
  'Look at an image and answer a question about what it shows. Use this whenever the answer depends on ' +
  'visual content that text alone cannot carry: screenshots, photos, diagrams, charts, UI mockups or scans. ' +
  'Accepts an absolute local file path or an http(s) URL. Returns the vision model\'s textual answer.';

export const TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    image: {
      type: 'string',
      description:
        'Image to analyze: an absolute path to a local file (png, jpeg, webp, gif, bmp) or an http(s) URL.',
    },
    prompt: {
      type: 'string',
      description:
        'What to ask about the image, e.g. "What error is shown?" or "Transcribe the table". Omit for a detailed description.',
    },
  },
  required: ['image'],
  additionalProperties: false,
};

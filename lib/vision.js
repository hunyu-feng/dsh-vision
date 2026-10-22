/**
 * Core vision client: turn an image (local path or URL) into a text answer.
 *
 * Two provider families are supported behind one OpenAI-compatible request
 * shape:
 * - `ollama`  — a local Ollama server (default http://127.0.0.1:11434/v1),
 *               free and offline, no API key needed;
 * - `ark`     — Volcano Ark (Doubao vision models), needs an API key;
 * - `openai`  — any other OpenAI-compatible endpoint, configured explicitly.
 *
 * The module is transport-agnostic on purpose: the DSH tool (index.js) and the
 * MCP stdio server (bin/mcp-server.js) both call analyzeImage().
 */
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const DEFAULT_LOCAL_MODEL = 'qwen2.5vl:3b';
export const DEFAULT_ARK_MODEL = 'doubao-seed-2-0-pro-260215';
export const DEFAULT_MODEL = DEFAULT_LOCAL_MODEL;
export const DEFAULT_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3';
export const DEFAULT_OLLAMA_ENDPOINT = 'http://127.0.0.1:11434/v1';
export const DEFAULT_PROMPT =
  'Describe this image in detail. If it contains text, read the text out. If it is a screenshot, ' +
  'explain what the interface shows and any errors or numbers visible.';
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Provider definitions. Everything a provider needs to build a request lives
 * here so a new provider is one table entry, not a new code path.
 */
export const PROVIDERS = {
  ollama: {
    label: 'Ollama (local)',
    defaultBaseUrl: DEFAULT_OLLAMA_ENDPOINT,
    baseUrlEnv: ['OLLAMA_BASE_URL'],
    keyEnv: ['OLLAMA_API_KEY'],
    keyRequired: false,
    placeholderKey: 'ollama',
  },
  ark: {
    label: 'Volcano Ark',
    defaultBaseUrl: DEFAULT_ENDPOINT,
    baseUrlEnv: ['ARK_BASE_URL', 'VOLCANO_ARK_BASE_URL'],
    keyEnv: ['VOLCANO_API_KEY', 'ARK_API_KEY'],
    keyRequired: true,
    placeholderKey: undefined,
  },
  openai: {
    label: 'OpenAI-compatible endpoint',
    defaultBaseUrl: DEFAULT_OLLAMA_ENDPOINT,
    baseUrlEnv: ['VISION_BASE_URL'],
    keyEnv: ['VISION_API_KEY'],
    keyRequired: true,
    placeholderKey: undefined,
  },
};

const PROVIDER_ALIASES = {
  volces: 'ark',
  volcano: 'ark',
  local: 'ollama',
};

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
 * Path of the optional settings file: `$DSH_VISION_HOME/config.json`, defaulting
 * to `~/.dsh-vision/config.json`. This is the "plug in your provider" spot.
 * @param {Record<string, string | undefined>} [env]
 */
export function configPath(env = process.env) {
  const home = env.DSH_VISION_HOME ?? join(homedir(), '.dsh-vision');
  return join(home, 'config.json');
}

/**
 * Read the settings file. A missing or malformed file is not fatal: env vars
 * and defaults take over, so the tool still works out of the box.
 * @param {Record<string, string | undefined>} [env]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function loadSettingsFile(env = process.env) {
  try {
    const text = await readFile(configPath(env), 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeProvider(name, fallback) {
  const value = String(name ?? '').trim().toLowerCase();
  if (value === '') return fallback;
  const mapped = PROVIDER_ALIASES[value] ?? value;
  if (!PROVIDERS[mapped]) {
    throw new VisionError(
      'E_CONFIG',
      `unknown vision provider "${name}"; use one of ${Object.keys(PROVIDERS).join(', ')}`,
    );
  }
  return mapped;
}

/**
 * Parse a model chain. Entries look like `ollama:qwen2.5vl:3b` or a bare model
 * id, which adopts the default provider. Provider aliases (volcano/volces)
 * are normalized; duplicates are dropped.
 * @param {string | string[] | undefined} raw
 * @param {{ defaultProvider?: string }} [options]
 * @returns {{ provider: string, model: string }[]}
 */
export function parseModelChain(raw, options = {}) {
  const defaultProvider = normalizeProvider(options.defaultProvider ?? 'ollama', 'ollama');
  let parts;
  if (Array.isArray(raw)) parts = raw;
  else if (typeof raw === 'string' && raw.trim() !== '') parts = raw.split(',');
  else parts = [`${defaultProvider}:${DEFAULT_LOCAL_MODEL}`, `ark:${DEFAULT_ARK_MODEL}`];

  const seen = new Set();
  const chain = [];
  for (const part of parts) {
    const entry = String(part ?? '').trim();
    if (entry === '') continue;
    const colon = entry.indexOf(':');
    let provider = defaultProvider;
    let model = entry;
    if (colon > 0) {
      const head = entry.slice(0, colon).trim().toLowerCase();
      const normalized = PROVIDER_ALIASES[head] ?? head;
      if (PROVIDERS[normalized]) {
        provider = normalized;
        model = entry.slice(colon + 1).trim();
      }
    }
    if (model === '') continue;
    const key = `${provider}:${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    chain.push({ provider, model });
  }
  if (chain.length === 0) {
    throw new VisionError('E_CONFIG', 'VISION_MODELS is set but contains no usable model id');
  }
  return chain;
}

function pickEnv(env, names) {
  for (const name of names ?? []) {
    const value = env[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/**
 * Resolve the effective settings: settings file first, env vars override it.
 * @param {Record<string, string | undefined>} [env]
 */
export async function resolveSettings(env = process.env) {
  const file = await loadSettingsFile(env);
  const defaultProvider = normalizeProvider(
    env.VISION_PROVIDER ?? file.provider ?? 'ollama',
    'ollama',
  );
  const fileModels =
    typeof file.models === 'string' && file.models.trim() !== '' ? file.models : undefined;
  const chain = parseModelChain(
    env.VISION_MODELS ?? fileModels,
    { defaultProvider },
  );
  const timeoutRaw = env.VISION_TIMEOUT_MS ?? file.timeoutMs;
  const timeout = Number(timeoutRaw);
  return {
    defaultProvider,
    chain,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
    filePath: configPath(env),
  };
}

/**
 * Resolve base URL and key for one provider. `missingKey` is true when the
 * provider needs a key and none is configured, so the chain can skip it
 * instead of failing the whole call.
 */
export function resolveProvider(provider, env = process.env, file = {}) {
  const def = PROVIDERS[provider];
  const overrides = file.baseUrls && typeof file.baseUrls === 'object' ? file.baseUrls : {};
  const baseUrl =
    pickEnv(env, def.baseUrlEnv) ?? overrides[provider] ?? def.defaultBaseUrl;
  const envKey = pickEnv(env, def.keyEnv);
  const fileKeys = file.apiKeys && typeof file.apiKeys === 'object' ? file.apiKeys : {};
  const fileKey = typeof fileKeys[provider] === 'string' ? fileKeys[provider].trim() : undefined;
  const apiKey = envKey ?? (fileKey && fileKey !== '' ? fileKey : undefined) ?? def.placeholderKey;
  return {
    provider,
    label: def.label,
    baseUrl,
    apiKey,
    missingKey: def.keyRequired && !apiKey,
  };
}

/**
 * One attempt against an OpenAI-compatible chat completions endpoint.
 * Throws VisionError with `retryable` set on transient failures, or code
 * E_AUTH for provider-wide authentication failures.
 */
async function requestModel({ provider, model, endpoint, apiKey, imageUrl, prompt, signal, fetchImpl }) {
  const url = `${endpoint.replace(/\/+$/, '')}/chat/completions`;
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
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
    const hint =
      provider === 'ollama'
        ? ' Is Ollama running? Start it with `ollama serve`.'
        : '';
    throw Object.assign(
      new VisionError(
        'E_UPSTREAM',
        `request to ${PROVIDERS[provider].label} (${model}) failed: ${error?.message ?? error}.${hint}`,
        { cause: error },
      ),
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
      `${PROVIDERS[provider].label} rejected ${model} with HTTP ${status}${detail ? `: ${detail}` : ''}`,
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
  return { text: text.trim(), model, provider, usage: payload?.usage };
}

/**
 * Ask a vision model about an image, walking the configured chain on transient
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
 * @returns {Promise<{ text: string, model: string, provider: string, usage?: unknown }>}
 */
export async function analyzeImage(options) {
  const {
    image,
    prompt,
    env = process.env,
    fetchImpl = globalThis.fetch,
    signal,
    timeoutMs,
    cwd,
  } = options ?? {};
  if (typeof fetchImpl !== 'function') {
    throw new VisionError('E_CONFIG', 'no fetch implementation available (Node 18+ required)');
  }
  const settings = await resolveSettings(env);
  const file = await loadSettingsFile(env);
  const effectiveTimeout = timeoutMs ?? settings.timeoutMs;
  const imageUrl = await resolveImageUrl(image, { cwd });

  const deadProviders = new Set();
  const attempts = [];
  const skipped = [];
  let authError;
  let hadNonAuthFailure = false;
  let attempted = 0;

  for (const candidate of settings.chain) {
    if (deadProviders.has(candidate.provider)) continue;
    if (signal?.aborted) throw new VisionError('E_ABORTED', 'vision request aborted');
    const runtime = resolveProvider(candidate.provider, env, file);
    if (runtime.missingKey) {
      skipped.push({ provider: candidate.provider, model: candidate.model, reason: 'no-key' });
      continue;
    }
    attempted += 1;
    const attemptSignal =
      typeof AbortSignal.any === 'function'
        ? AbortSignal.any([signal, AbortSignal.timeout(effectiveTimeout)].filter(Boolean))
        : signal;
    try {
      return await requestModel({
        provider: candidate.provider,
        model: candidate.model,
        endpoint: runtime.baseUrl,
        apiKey: runtime.apiKey,
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
        attempts.push({ provider: candidate.provider, model: candidate.model, status: error.status, reason: 'auth' });
        continue;
      }
      const timedOut = attemptSignal?.aborted && !signal?.aborted;
      const retryable = error.retryable || timedOut;
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        status: error.status,
        reason: timedOut ? 'timeout' : retryable ? 'transient' : 'fatal',
      });
      if (!retryable) throw error;
      hadNonAuthFailure = true;
    }
  }

  if (attempted === 0) {
    const needsKey = skipped[0]?.provider ?? 'ark';
    throw new VisionError(
      'E_CONFIG',
      `no vision provider is ready. Local mode: install Ollama and pull a model ` +
        `(\`ollama pull ${DEFAULT_LOCAL_MODEL}\`). Cloud mode: set VOLCANO_API_KEY for ${PROVIDERS.ark.label}. ` +
        `Skipped: ${skipped.map((s) => `${s.provider}/${s.model} (${s.reason})`).join(', ')}. ` +
        `Settings file: ${configPath(env)}.`,
      { attempts: skipped },
    );
  }
  if (hadNonAuthFailure && deadProviders.size === 0) {
    throw new VisionError(
      'E_ALL_FAILED',
      `every configured vision model failed: ${attempts
        .map((a) => `${a.model}(${a.reason}${a.status ? ` ${a.status}` : ''})`)
        .join(', ')}`,
      { attempts },
    );
  }
  if (authError) {
    throw new VisionError(
      'E_AUTH',
      `${authError.message}. Check the API key for that provider. Tried: ${attempts
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
  'Accepts an absolute local file path or an http(s) URL. Runs locally through Ollama by default (free, no API key); ' +
  'configured cloud providers are used as a fallback. Returns the vision model\'s textual answer.';

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

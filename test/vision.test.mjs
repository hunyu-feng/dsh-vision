import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  DEFAULT_ARK_MODEL,
  DEFAULT_LOCAL_MODEL,
  VisionError,
  analyzeImage,
  configPath,
  parseModelChain,
  resolveImageUrl,
  resolveProvider,
  resolveSettings,
} from '../lib/vision.js';

// 1x1 transparent PNG.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function okResponse(text, model) {
  return jsonResponse(200, {
    model,
    choices: [{ message: { role: 'assistant', content: text } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
}

/** Record every provider call and answer from a queue of statuses. */
function fakeFetch(sequence = []) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const step = sequence.shift() ?? 'ok';
    if (typeof step === 'function') return step(calls.length);
    if (step === 'ok') return okResponse('a cat sitting on a keyboard', 'mock-model');
    if (step === 'rate') return jsonResponse(429, { error: { message: 'rate limited' } });
    if (step === 'server') return jsonResponse(503, { error: { message: 'busy' } });
    if (step === 'auth') return jsonResponse(401, { error: { message: 'bad key' } });
    if (step === 'notfound') return jsonResponse(404, { error: { message: 'no such model' } });
    if (step === 'bad') return jsonResponse(400, { error: { message: 'invalid request' } });
    throw new Error(`unknown step ${step}`);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

describe('vision core', () => {
  let dir;
  let imagePath;
  let home;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-vision-test-'));
    home = join(dir, 'home');
    imagePath = join(dir, 'sample.png');
    await writeFile(imagePath, PNG_1X1);
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parses VISION_MODELS into a provider chain', () => {
    assert.deepEqual(parseModelChain(undefined), [
      { provider: 'ollama', model: DEFAULT_LOCAL_MODEL },
      { provider: 'ark', model: DEFAULT_ARK_MODEL },
    ]);
    assert.deepEqual(parseModelChain(' a, ark:b ,volcano:c, a ', { defaultProvider: 'ark' }), [
      { provider: 'ark', model: 'a' },
      { provider: 'ark', model: 'b' },
      { provider: 'ark', model: 'c' },
    ]);
    assert.deepEqual(parseModelChain('ollama:qwen2.5vl:3b, openai:gpt-5-mini'), [
      { provider: 'ollama', model: 'qwen2.5vl:3b' },
      { provider: 'openai', model: 'gpt-5-mini' },
    ]);
    assert.throws(() => parseModelChain('  ,  '), VisionError);
  });

  it('defaults to the local Ollama provider', async () => {
    const settings = await resolveSettings({ DSH_VISION_HOME: home });
    assert.equal(settings.defaultProvider, 'ollama');
    assert.equal(settings.chain[0].provider, 'ollama');
    assert.equal(settings.chain[0].model, DEFAULT_LOCAL_MODEL);
    assert.equal(configPath({ DSH_VISION_HOME: home }), join(home, 'config.json'));
  });

  it('inlines a local image as a data URL', async () => {
    const url = await resolveImageUrl(imagePath);
    assert.match(url, /^data:image\/png;base64,/);
  });

  it('rejects a missing image file', async () => {
    await assert.rejects(() => resolveImageUrl(join(dir, 'nope.png')), (error) => {
      assert.equal(error.code, 'E_IMAGE');
      return true;
    });
  });

  it('accepts a remote URL without downloading it', async () => {
    const url = await resolveImageUrl('https://example.com/cat.png');
    assert.equal(url, 'https://example.com/cat.png');
  });

  it('analyzes a local file through the local Ollama provider without a key', async () => {
    const fetchImpl = fakeFetch(['ok']);
    const result = await analyzeImage({
      image: imagePath,
      prompt: 'what is this?',
      env: { DSH_VISION_HOME: home },
      fetchImpl,
    });
    assert.equal(result.text, 'a cat sitting on a keyboard');
    assert.equal(result.model, DEFAULT_LOCAL_MODEL);
    assert.equal(result.provider, 'ollama');
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, 'http://127.0.0.1:11434/v1/chat/completions');
    assert.equal(fetchImpl.calls[0].headers.authorization, 'Bearer ollama');
    const parts = fetchImpl.calls[0].body.messages[0].content;
    assert.equal(parts[0].text, 'what is this?');
    assert.match(parts[1].image_url.url, /^data:image\/png;base64,/);
  });

  it('honors a custom Ollama base URL', async () => {
    const fetchImpl = fakeFetch(['ok']);
    await analyzeImage({
      image: imagePath,
      env: { DSH_VISION_HOME: home, OLLAMA_BASE_URL: 'http://10.0.0.5:11434/v1/' },
      fetchImpl,
    });
    assert.equal(fetchImpl.calls[0].url, 'http://10.0.0.5:11434/v1/chat/completions');
  });

  it('passes a remote URL to the provider unchanged', async () => {
    const fetchImpl = fakeFetch(['ok']);
    await analyzeImage({
      image: 'https://example.com/cat.png',
      env: { DSH_VISION_HOME: home },
      fetchImpl,
    });
    assert.equal(
      fetchImpl.calls[0].body.messages[0].content[1].image_url.url,
      'https://example.com/cat.png',
    );
  });

  it('falls back to the next model on 429 and 5xx', async () => {
    const fetchImpl = fakeFetch(['rate', 'server', 'ok']);
    const result = await analyzeImage({
      image: imagePath,
      env: { DSH_VISION_HOME: home, VISION_MODELS: 'model-a,model-b,model-c' },
      fetchImpl,
    });
    assert.equal(result.model, 'model-c');
    assert.deepEqual(
      fetchImpl.calls.map((call) => call.body.model),
      ['model-a', 'model-b', 'model-c'],
    );
  });

  it('aborts the provider on 401 without trying other models', async () => {
    const fetchImpl = fakeFetch(['auth']);
    await assert.rejects(
      analyzeImage({
        image: imagePath,
        env: { DSH_VISION_HOME: home, VOLCANO_API_KEY: 'bad', VISION_MODELS: 'ark:model-a,ark:model-b' },
        fetchImpl,
      }),
      (error) => {
        assert.equal(error.code, 'E_AUTH');
        return true;
      },
    );
    assert.equal(fetchImpl.calls.length, 1);
  });

  it('surfaces a non-retryable 400 as an upstream error', async () => {
    const fetchImpl = fakeFetch(['bad']);
    await assert.rejects(
      analyzeImage({
        image: imagePath,
        env: { DSH_VISION_HOME: home, VISION_MODELS: 'model-a,model-b' },
        fetchImpl,
      }),
      (error) => {
        assert.equal(error.code, 'E_UPSTREAM');
        assert.equal(error.status, 400);
        return true;
      },
    );
    assert.equal(fetchImpl.calls.length, 1);
  });

  it('reports every transient failure when the chain is exhausted', async () => {
    const fetchImpl = fakeFetch(['rate', 'notfound']);
    await assert.rejects(
      analyzeImage({
        image: imagePath,
        env: { DSH_VISION_HOME: home, VISION_MODELS: 'model-a,model-b' },
        fetchImpl,
      }),
      (error) => {
        assert.equal(error.code, 'E_ALL_FAILED');
        assert.equal(error.attempts.length, 2);
        return true;
      },
    );
  });

  it('skips a cloud provider with no key instead of failing the call', async () => {
    const fetchImpl = fakeFetch(['ok']);
    const result = await analyzeImage({
      image: imagePath,
      env: { DSH_VISION_HOME: home, VISION_MODELS: 'ollama:qwen2.5vl:3b,ark:doubao-seed-2-0-pro-260215' },
      fetchImpl,
    });
    assert.equal(result.provider, 'ollama');
    assert.equal(fetchImpl.calls.length, 1);
  });

  it('explains how to configure a provider when none is ready', async () => {
    await assert.rejects(
      analyzeImage({
        image: imagePath,
        env: { DSH_VISION_HOME: home, VISION_MODELS: 'ark:doubao-seed-2-0-pro-260215' },
        fetchImpl: fakeFetch(),
      }),
      (error) => {
        assert.equal(error.code, 'E_CONFIG');
        assert.match(error.message, /Ollama/);
        assert.match(error.message, /VOLCANO_API_KEY/);
        return true;
      },
    );
  });

  it('reads base URL and key from the settings file', async () => {
    const customHome = join(dir, 'custom-home');
    await mkdir(customHome, { recursive: true });
    await writeFile(
      join(customHome, 'config.json'),
      JSON.stringify({ baseUrls: { ark: 'http://ark.local/v3' }, apiKeys: { ark: 'file-key' } }),
    );
    const fetchImpl = fakeFetch(['ok']);
    const result = await analyzeImage({
      image: imagePath,
      env: {
        DSH_VISION_HOME: customHome,
        VISION_MODELS: 'ark:seed-pro',
      },
      fetchImpl,
    });
    assert.equal(result.provider, 'ark');
    assert.equal(fetchImpl.calls[0].url, 'http://ark.local/v3/chat/completions');
    assert.equal(fetchImpl.calls[0].headers.authorization, 'Bearer file-key');
  });

  it('exposes provider defaults', () => {
    const ollama = resolveProvider('ollama', {}, {});
    assert.equal(ollama.baseUrl, 'http://127.0.0.1:11434/v1');
    assert.equal(ollama.missingKey, false);
    const ark = resolveProvider('ark', {}, {});
    assert.equal(ark.missingKey, true);
    assert.equal(ark.baseUrl, 'https://ark.cn-beijing.volces.com/api/v3');
  });
});

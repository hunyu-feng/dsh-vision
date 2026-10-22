import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  DEFAULT_MODEL,
  VisionError,
  analyzeImage,
  parseModelChain,
  resolveImageUrl,
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

/** Record every Ark call and answer from a queue of statuses. */
function fakeFetch(sequence = []) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const step = sequence.shift() ?? 'ok';
    if (typeof step === 'function') return step(calls.length);
    if (step === 'ok') return okResponse('a cat sitting on a keyboard', 'doubao-mock');
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

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-vision-test-'));
    imagePath = join(dir, 'sample.png');
    await writeFile(imagePath, PNG_1X1);
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parses VISION_MODELS into a provider chain', () => {
    assert.deepEqual(parseModelChain(undefined), [{ provider: 'ark', model: DEFAULT_MODEL }]);
    assert.deepEqual(parseModelChain(' a, ark:b ,volcano:c, a '), [
      { provider: 'ark', model: 'a' },
      { provider: 'ark', model: 'b' },
      { provider: 'ark', model: 'c' },
    ]);
    assert.throws(() => parseModelChain('  ,  '), VisionError);
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

  it('analyzes a local file through Ark', async () => {
    const fetchImpl = fakeFetch(['ok']);
    const result = await analyzeImage({
      image: imagePath,
      prompt: 'what is this?',
      env: { VOLCANO_API_KEY: 'test-key' },
      fetchImpl,
    });
    assert.equal(result.text, 'a cat sitting on a keyboard');
    assert.equal(result.model, DEFAULT_MODEL);
    assert.equal(fetchImpl.calls.length, 1);
    const body = fetchImpl.calls[0].body;
    assert.equal(body.model, DEFAULT_MODEL);
    const parts = body.messages[0].content;
    assert.equal(parts[0].text, 'what is this?');
    assert.match(parts[1].image_url.url, /^data:image\/png;base64,/);
    assert.equal(fetchImpl.calls[0].headers.authorization, 'Bearer test-key');
  });

  it('passes a remote URL to the provider unchanged', async () => {
    const fetchImpl = fakeFetch(['ok']);
    await analyzeImage({
      image: 'https://example.com/cat.png',
      env: { VOLCANO_API_KEY: 'k' },
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
      env: { VOLCANO_API_KEY: 'k', VISION_MODELS: 'model-a,model-b,model-c' },
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
        env: { VOLCANO_API_KEY: 'bad', VISION_MODELS: 'model-a,model-b' },
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
        env: { VOLCANO_API_KEY: 'k', VISION_MODELS: 'model-a,model-b' },
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
        env: { VOLCANO_API_KEY: 'k', VISION_MODELS: 'model-a,model-b' },
        fetchImpl,
      }),
      (error) => {
        assert.equal(error.code, 'E_ALL_FAILED');
        assert.equal(error.attempts.length, 2);
        return true;
      },
    );
  });

  it('requires VOLCANO_API_KEY', async () => {
    await assert.rejects(
      analyzeImage({ image: imagePath, env: {}, fetchImpl: fakeFetch() }),
      (error) => {
        assert.equal(error.code, 'E_CONFIG');
        assert.match(error.message, /VOLCANO_API_KEY/);
        return true;
      },
    );
  });
});

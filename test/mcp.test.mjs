import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

const SERVER = fileURLToPath(new URL('../bin/mcp-server.js', import.meta.url));

/** Minimal JSON-RPC stdio client for one server process. */
function startServer(env = {}) {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, VOLCANO_API_KEY: '', VISION_MODELS: 'ark:doubao-seed-2-0-pro-260215', ...env },
  });
  let buffer = '';
  const pending = new Map();
  let nextId = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === '') continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    }
  });
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 10_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const notify = (method, params) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  return { child, call, notify };
}

describe('mcp stdio server', () => {
  let server;

  before(async () => {
    server = startServer();
    const init = await server.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
    });
    assert.equal(init.serverInfo.name, 'dsh-vision');
    server.notify('notifications/initialized', {});
  });

  after(() => {
    server.child.kill();
  });

  it('lists analyze_image with a JSON Schema input', async () => {
    const result = await server.call('tools/list', {});
    const tool = result.tools.find((entry) => entry.name === 'analyze_image');
    assert.ok(tool, 'analyze_image must be listed');
    assert.equal(tool.inputSchema.type, 'object');
    assert.deepEqual(tool.inputSchema.required, ['image']);
    assert.equal(tool.inputSchema.properties.image.type, 'string');
    assert.equal(tool.inputSchema.properties.prompt.type, 'string');
  });

  it('returns an actionable tool error when no provider is configured', async () => {
    const result = await server.call('tools/call', {
      name: 'analyze_image',
      arguments: { image: 'https://example.com/cat.png' },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Ollama|VOLCANO_API_KEY/);
  });
});

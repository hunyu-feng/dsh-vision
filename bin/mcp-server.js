#!/usr/bin/env node
/**
 * MCP stdio server exposing the same `analyze_image` tool to any MCP client
 * (Claude Desktop, Cursor, DSH's own MCP client, ...).
 *
 * Run:  npx -y dsh-vision-ark        (local Ollama, no key)
 *       VOLCANO_API_KEY=... npx -y dsh-vision-ark   (Volcano Ark fallback)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import {
  TOOL_DESCRIPTION,
  TOOL_INPUT_SCHEMA,
  TOOL_NAME,
  analyzeImage,
  parseModelChain,
} from '../lib/vision.js';

const VERSION = process.env.npm_package_version ?? '1.0.0';

if (process.argv.includes('--selftest')) {
  let chain;
  try {
    chain = parseModelChain(process.env.VISION_MODELS);
  } catch (error) {
    console.error(`invalid VISION_MODELS: ${error.message}`);
    process.exit(1);
  }
  console.log(
    JSON.stringify({
      ok: true,
      server: 'dsh-vision',
      tool: TOOL_NAME,
      models: chain.map((entry) => `${entry.provider}:${entry.model}`),
      apiKeyConfigured: Boolean(process.env.VOLCANO_API_KEY ?? process.env.ARK_API_KEY),
      ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1',
    }),
  );
  process.exit(0);
}

const server = new Server(
  { name: 'dsh-vision', version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      inputSchema: TOOL_INPUT_SCHEMA,
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name !== TOOL_NAME) {
    return {
      content: [{ type: 'text', text: `unknown tool: ${name}` }],
      isError: true,
    };
  }
  try {
    const result = await analyzeImage({
      image: /** @type {string} */ (args?.image),
      prompt: /** @type {string | undefined} */ (args?.prompt),
    });
    return {
      content: [{ type: 'text', text: `[${result.provider}/${result.model}]
${result.text}` }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `${TOOL_NAME} failed: ${error?.message ?? error}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

/**
 * DSH host plugin entry. Registers the native `analyze_image` tool.
 *
 * The tool is fiber-scoped: when this plugin is disabled or removed, the
 * registry tears the tool down with the plugin, so apply() has no cleanup code.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

import { TOOL_DESCRIPTION, TOOL_NAME, analyzeImage } from './lib/vision.js';

export const name = 'dsh-vision';

export const inject = ['tools'];

const analyzeImageTool = defineTool({
  name: TOOL_NAME,
  description: TOOL_DESCRIPTION,
  parameters: {
    image: {
      type: 'string',
      required: true,
      description:
        'Image to analyze: an absolute local file path (png, jpeg, webp, gif, bmp) or an http(s) URL. ' +
        'Prefer an absolute path for files on this machine.',
    },
    prompt: {
      type: 'string',
      description:
        'The question to ask about the image, e.g. "What error is shown?" or "Transcribe this table". ' +
        'Omit for a detailed description of the image.',
    },
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        model: { type: 'string' },
      },
      additionalProperties: false,
    },
    render(_args, value) {
      return [{ type: 'text', text: value.text }];
    },
  },
  timeoutMs: 180_000,
  async execute(args, exec) {
    const result = await analyzeImage({ image: args.image, prompt: args.prompt, signal: exec?.signal });
    return { text: result.text, model: result.model };
  },
});

/**
 * Register the vision tool. `inject: ['tools']` guarantees the registry exists
 * before apply() runs.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.tools.register(analyzeImageTool);
}

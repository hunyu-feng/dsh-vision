import { analyzeImage } from './lib/vision.js';
const t0 = Date.now();
const out = await analyzeImage({
  image: 'C:/Users/wang7/Documents/deepseek-harness/default-workspace/.tmp-shot/avatar-300-preview.png',
  prompt: '用一句中文描述这张图。',
  env: { DSH_VISION_HOME: 'C:/Users/wang7/Documents/deepseek-harness/default-workspace/.tmp-shot/vhome' },
});
console.log(JSON.stringify({ provider: out.provider, model: out.model, ms: Date.now() - t0, text: out.text.slice(0, 200) }, null, 2));

// Which models run, and where. Swapping either model is a deploy setting, not
// a code change. The judge must answer OpenRouter's Decisions format (see
// js/questions.js); the screenshot model must read images.
export const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
export const JUDGE_MODEL = process.env.JUDGE_MODEL ?? '~typesafe/jev-latest';
export const SCREENSHOT_MODEL = process.env.SCREENSHOT_MODEL ?? 'openai/gpt-6-luna';

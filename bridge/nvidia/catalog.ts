export const NVIDIA_CHAT_MODEL_IDS = [
  'meta/llama-3.1-8b-instruct',
  'meta/llama3-70b',
  'nvidia/llama3-chatqa-1.5-70b',
  'nvidia-nemotron-4-340b-instruct',
  'deepseek-ai/deepseek-r1',
  'mistralai/mistral-large-2-instruct',
  'moonshotai/kimi-k2-thinking',
  'qwen/qwen2-7b-instruct',
  'minimaxai/minimax-m2.7'
] as const;

export function listNvidiaChatModels() {
  return NVIDIA_CHAT_MODEL_IDS.map((name) => ({
    name,
    size: null,
    digest: null
  }));
}

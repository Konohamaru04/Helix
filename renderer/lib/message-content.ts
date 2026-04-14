export interface ParsedAssistantContent {
  thinkingBlocks: string[];
  answer: string;
}

const THINKING_PATTERNS = [
  /<think\b[^>]*>([\s\S]*?)<\/think>/gi,
  /<thinking\b[^>]*>([\s\S]*?)<\/thinking>/gi,
  /<reasoning\b[^>]*>([\s\S]*?)<\/reasoning>/gi
];
const OPEN_THINKING_PATTERN = /<(think|thinking|reasoning)\b[^>]*>([\s\S]*)$/i;
const LABELED_THINKING_PATTERN =
  /^\s*(?:thinking|reasoning)\s*:?\s*\n+([\s\S]*?)\n+(?:final answer|answer|response)\s*:?\s*\n+([\s\S]*)$/i;

export function parseAssistantContent(content: string): ParsedAssistantContent {
  const thinkingBlocks: string[] = [];
  let answer = content;

  for (const pattern of THINKING_PATTERNS) {
    answer = answer.replace(pattern, (_match, thinking) => {
      const normalizedThinking = String(thinking).trim();

      if (normalizedThinking) {
        thinkingBlocks.push(normalizedThinking);
      }

      return '';
    });
  }

  if (thinkingBlocks.length === 0) {
    const labeledThinkingMatch = answer.match(LABELED_THINKING_PATTERN);

    if (labeledThinkingMatch) {
      const [, thinking, finalAnswer] = labeledThinkingMatch;

      if (thinking?.trim()) {
        thinkingBlocks.push(thinking.trim());
      }

      answer = finalAnswer ?? '';
    }
  }

  if (thinkingBlocks.length === 0) {
    const openThinkingMatch = answer.match(OPEN_THINKING_PATTERN);

    if (openThinkingMatch?.[2]?.trim()) {
      thinkingBlocks.push(openThinkingMatch[2].trim());
      answer = answer.replace(OPEN_THINKING_PATTERN, '').trim();
    }
  }

  return {
    thinkingBlocks,
    answer: answer.replace(/\n{3,}/g, '\n\n').trim()
  };
}

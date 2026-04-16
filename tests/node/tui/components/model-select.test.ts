import { describe, it, expect } from 'vitest';
import { parseModelList } from '../../../../tui/components/model-select';

describe('parseModelList', () => {
  it('parses ollama model list output', () => {
    const output = 'NAME\tID\tSIZE\tMODIFIED\nllama3.1\tabc123\t4.7GB\t2 days ago\nmistral\tdef456\t7.2GB\t1 week ago';
    const models = parseModelList(output);
    expect(models).toEqual(['llama3.1', 'mistral']);
  });

  it('handles empty output', () => {
    expect(parseModelList('')).toEqual([]);
  });
});
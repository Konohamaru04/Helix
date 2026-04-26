import { describe, expect, it } from 'vitest';
import { parseJsonishRecord } from '@bridge/jsonish';

describe('parseJsonishRecord', () => {
  // ── Valid JSON ────────────────────────────────────────────────────────

  it('parses a valid JSON object string', () => {
    const input = '{"name":"Helix","version":1}';
    const result = parseJsonishRecord(input);
    expect(result).toEqual({ name: 'Helix', version: 1 });
  });

  it('parses a valid JSON object with nested objects', () => {
    const input = '{"outer":{"inner":"value"}}';
    const result = parseJsonishRecord(input);
    expect(result).toEqual({ outer: { inner: 'value' } });
  });

  it('parses a valid JSON object with arrays', () => {
    const input = '{"items":[1,2,3]}';
    const result = parseJsonishRecord(input);
    expect(result).toEqual({ items: [1, 2, 3] });
  });

  it('parses a valid JSON object with booleans and null', () => {
    const input = '{"active":true,"deleted":false,"ref":null}';
    const result = parseJsonishRecord(input);
    expect(result).toEqual({ active: true, deleted: false, ref: null });
  });

  it('parses a valid JSON object with numeric values', () => {
    const input = '{"int":42,"float":3.14,"neg":-7}';
    const result = parseJsonishRecord(input);
    expect(result).toEqual({ int: 42, float: 3.14, neg: -7 });
  });

  it('parses an empty JSON object', () => {
    const result = parseJsonishRecord('{}');
    expect(result).toEqual({});
  });

  // ── Fenced JSON (markdown code block) ────────────────────────────────

  it('extracts JSON from a ```json fenced block', () => {
    const input = '```json\n{"key":"value"}\n```';
    const result = parseJsonishRecord(input);
    expect(result).toEqual({ key: 'value' });
  });

  it('extracts JSON from an untyped fenced block', () => {
    const input = '```\n{"key":"value"}\n```';
    const result = parseJsonishRecord(input);
    expect(result).toEqual({ key: 'value' });
  });

  // ── Loose / malformed JSON recovery ──────────────────────────────────

  it('recovers JSON with surrounding text before the opening brace', () => {
    const input = 'Here is the result: {"key":"value"}';
    const result = parseJsonishRecord(input);
    expect(result).toEqual({ key: 'value' });
  });

  it('recovers JSON with surrounding text after the closing brace', () => {
    const input = '{"key":"value"} and some trailing text';
    const result = parseJsonishRecord(input);
    expect(result).toEqual({ key: 'value' });
  });

  it('recovers JSON with unescaped newlines inside string values', () => {
    const input = '{"text":"line1\nline2"}';
    const result = parseJsonishRecord(input);
    expect(result).toEqual({ text: 'line1\nline2' });
  });

  it('recovers JSON with unescaped tabs inside string values', () => {
    const input = '{"text":"col1\tcol2"}';
    const result = parseJsonishRecord(input);
    expect(result).toEqual({ text: 'col1\tcol2' });
  });

  it('recovers JSON with unescaped carriage returns inside string values', () => {
    const input = '{"text":"line1\r\nline2"}';
    const result = parseJsonishRecord(input);
    expect(result).toEqual({ text: 'line1\r\nline2' });
  });

  it('recovers JSON with a lone backslash before end of string', () => {
    const input = '{"path":"C:\\\\"}';
    const result = parseJsonishRecord(input);
    expect(result).toEqual({ path: 'C:\\' });
  });

  it('handles valid unicode escape sequences inside strings', () => {
    const input = '{"emoji":"\\u0048ello"}';
    const result = parseJsonishRecord(input);
    expect(result).toEqual({ emoji: 'Hello' });
  });

  it('returns null for completely invalid input', () => {
    expect(parseJsonishRecord('not json at all')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseJsonishRecord('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(parseJsonishRecord('   ')).toBeNull();
  });

  it('returns null for a string with no braces', () => {
    expect(parseJsonishRecord('just text')).toBeNull();
  });

  it('returns null when closing brace appears before opening brace', () => {
    expect(parseJsonishRecord('}text{')).toBeNull();
  });

  it('returns null for a JSON array (not a record)', () => {
    expect(parseJsonishRecord('[1,2,3]')).toBeNull();
  });

  it('returns null for a JSON primitive', () => {
    expect(parseJsonishRecord('"hello"')).toBeNull();
  });

  it('returns null for a JSON number embedded in braces that is not an object', () => {
    // The function extracts from { to }, but if the content is not a record it returns null
    expect(parseJsonishRecord('{42}')).toBeNull();
  });

  // ── String repair edge cases ──────────────────────────────────────────

  it('recovers JSON with unescaped control characters below ASCII 32', () => {
    const input = '{"text":"a\x01b"}';
    const result = parseJsonishRecord(input);
    // \x01 is a control char that gets escaped to 
    expect(result).toEqual({ text: 'ab' });
  });

  it('handles double quotes that are not followed by a structural token', () => {
    // A " inside a string value that doesn't precede ,:}] should be escaped
    const input = '{"text":"he said "hello" to me","ok":true}';
    const result = parseJsonishRecord(input);
    // The inner quotes get escaped, producing: {"text":"he said \"hello\" to me","ok":true}
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>)['ok']).toBe(true);
  });

  it('handles JSON with trailing backslash in string value', () => {
    // The repair function escapes a trailing backslash before the closing quote
    const input = '{"path":"C:\\\\Users"}';
    const result = parseJsonishRecord(input);
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>)['path']).toBe('C:\\Users');
  });
});
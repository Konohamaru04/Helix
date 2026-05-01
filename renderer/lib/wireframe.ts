export interface WireframeQuestionOption {
  id: string;
  label: string;
}

export interface WireframeQuestion {
  id: string;
  label: string;
  selection: 'single' | 'multi';
  options: WireframeQuestionOption[];
}

export interface WireframeQuestionsArtifact {
  type: 'questions';
  questions: WireframeQuestion[];
}

export interface WireframeDesignArtifact {
  type: 'design';
  title: string;
  html: string;
  css: string;
  js: string;
}

export type WireframeArtifact = WireframeQuestionsArtifact | WireframeDesignArtifact;

export interface WireframeDesignIteration {
  id: string;
  design: WireframeDesignArtifact;
  createdAt: string;
  sourceMessageId: string;
}

const WIREFRAME_BLOCK_PATTERN = /```wireframe\s*([\s\S]*?)```/gi;
const GENERIC_CODE_BLOCK_PATTERN = /```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)```/g;
const BARE_WIREFRAME_OBJECT_PATTERN = /\{\s*"type"\s*:\s*"(?:design|questions)"/g;
const HTML_BLOCK_PATTERN = /```html[^\n]*\n([\s\S]*?)```/i;
const CSS_BLOCK_PATTERN = /```css[^\n]*\n([\s\S]*?)```/i;
const JS_BLOCK_PATTERN = /```(?:js|javascript)[^\n]*\n([\s\S]*?)```/i;
const THINKING_BLOCK_PATTERN = /<(think|thinking|reasoning)\b[^>]*>[\s\S]*?<\/\1>/gi;
const MARKDOWN_OPTION_PATTERN = /^\s*(?:[-*]\s*)?([A-Ha-h])[\).:-]\s+(.+?)\s*$/;
const MARKDOWN_QUESTION_PATTERN =
  /^\s*(?:#{1,6}\s*)?(?:\d+[\).:-]\s*)?(.+\?)\s*(?:\((single|multi)[^)]+\))?\s*$/i;
const INLINE_CHOICE_QUESTION_PATTERN =
  /^\s*(?:#{1,6}\s*)?(?:\d+[\).:-]\s*)?(?:\*\*(.+?)\*\*|(.+?))\s*(?:\s[-—:]\s|\s[—]\s)\s*(.+\?)\s*(?:\((single|multi)[^)]+\))?\s*$/i;
const FILE_REFERENCE_PATTERN =
  /^(?:see|open|refer to|view)?\s*(?:the\s+)?(?:file\s+)?(?:index|app|main)\.(?:html|css|js)\s*\.?$/i;

function stripThinking(content: string): string {
  return content.replace(THINKING_BLOCK_PATTERN, '\n').trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function normalizeIdentifier(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmedValue = value.trim();
  return trimmedValue || fallback;
}

function isPreviewableHtml(value: string): boolean {
  const trimmedValue = value.trim();

  return trimmedValue.includes('<') && !FILE_REFERENCE_PATTERN.test(trimmedValue);
}

function parseQuestion(value: unknown, index: number): WireframeQuestion | null {
  const record = asRecord(value);

  if (!record) {
    return null;
  }

  const label = typeof record.label === 'string' ? record.label.trim() : '';
  const selection = record.selection === 'multi' ? 'multi' : 'single';
  const rawOptions = Array.isArray(record.options) ? record.options : [];
  const options = rawOptions.flatMap((option, optionIndex) => {
    const optionRecord = asRecord(option);
    const optionLabel =
      typeof optionRecord?.label === 'string' ? optionRecord.label.trim() : '';

    if (!optionLabel) {
      return [];
    }

    return [
      {
        id: normalizeIdentifier(optionRecord?.id, String.fromCharCode(65 + optionIndex)),
        label: optionLabel
      }
    ];
  });

  if (!label || options.length < 2) {
    return null;
  }

  return {
    id: normalizeIdentifier(record.id, `q${index + 1}`),
    label,
    selection,
    options
  };
}

function tryParseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

function jsonStringUnescape(raw: string): string {
  let out = '';
  let i = 0;

  while (i < raw.length) {
    const ch = raw[i];

    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1];

      switch (next) {
        case 'n':
          out += '\n';
          i += 2;
          continue;
        case 'r':
          out += '\r';
          i += 2;
          continue;
        case 't':
          out += '\t';
          i += 2;
          continue;
        case '"':
          out += '"';
          i += 2;
          continue;
        case '\\':
          out += '\\';
          i += 2;
          continue;
        case '/':
          out += '/';
          i += 2;
          continue;
        case 'b':
          out += '\b';
          i += 2;
          continue;
        case 'f':
          out += '\f';
          i += 2;
          continue;
        case 'u': {
          const hex = raw.slice(i + 2, i + 6);

          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 6;
            continue;
          }
          break;
        }
        default:
          break;
      }
    }

    out += ch;
    i += 1;
  }

  return out;
}

function extractLenientDesignFields(
  body: string
): { title: string; html: string; css: string; js: string } | null {
  const htmlAnchor = '"html":"';
  const cssAnchor = '","css":"';
  const jsAnchor = '","js":"';
  const closingAnchor = '"}';
  const htmlStart = body.indexOf(htmlAnchor);
  const cssStart = body.indexOf(cssAnchor, htmlStart + htmlAnchor.length);

  if (htmlStart === -1 || cssStart === -1) {
    return null;
  }

  const jsStart = body.indexOf(jsAnchor, cssStart + cssAnchor.length);
  const tailEnd = body.lastIndexOf(closingAnchor);

  if (tailEnd <= cssStart) {
    return null;
  }

  const htmlRaw = body.slice(htmlStart + htmlAnchor.length, cssStart);
  const cssRaw =
    jsStart === -1
      ? body.slice(cssStart + cssAnchor.length, tailEnd)
      : body.slice(cssStart + cssAnchor.length, jsStart);
  const jsRaw =
    jsStart === -1 ? '' : body.slice(jsStart + jsAnchor.length, tailEnd);

  const titleMatch = body.match(/"title"\s*:\s*"((?:\\.|[^"\\])*)"/);
  const title = titleMatch ? jsonStringUnescape(titleMatch[1] ?? '').trim() : '';

  return {
    title: title || 'Wireframe',
    html: jsonStringUnescape(htmlRaw),
    css: jsonStringUnescape(cssRaw),
    js: jsonStringUnescape(jsRaw)
  };
}

function parseArtifactJson(rawJson: string): WireframeArtifact | null {
  try {
    const trimmed = rawJson.trim();
    let parsed = tryParseJsonRecord(trimmed);

    if (!parsed) {
      const start = trimmed.indexOf('{');

      if (start !== -1) {
        const balanced = findBalancedJsonObject(trimmed, start);

        if (balanced) {
          parsed = tryParseJsonRecord(balanced);
        }
      }
    }

    if (!parsed && /"type"\s*:\s*"design"/.test(trimmed)) {
      const lenient = extractLenientDesignFields(trimmed);

      if (lenient && isPreviewableHtml(lenient.html)) {
        return {
          type: 'design',
          title: lenient.title,
          html: lenient.html.trim(),
          css: lenient.css,
          js: lenient.js
        };
      }
    }

    if (!parsed) {
      return null;
    }

    if (parsed.type === 'questions') {
      const questions = (Array.isArray(parsed.questions) ? parsed.questions : [])
        .map(parseQuestion)
        .filter((question): question is WireframeQuestion => question !== null);

      return questions.length > 0
        ? {
            type: 'questions',
            questions
          }
        : null;
    }

    if (parsed.type === 'design') {
      const html = typeof parsed.html === 'string' ? parsed.html.trim() : '';

      if (!isPreviewableHtml(html)) {
        return null;
      }

      return {
        type: 'design',
        title:
          typeof parsed.title === 'string' && parsed.title.trim()
            ? parsed.title.trim()
            : 'Wireframe',
        html,
        css: typeof parsed.css === 'string' ? parsed.css : '',
        js: typeof parsed.js === 'string' ? parsed.js : ''
      };
    }
  } catch {
    return null;
  }

  return null;
}

function parseMarkdownQuestions(content: string): WireframeQuestionsArtifact | null {
  const questions: WireframeQuestion[] = [];
  let currentQuestion:
    | {
        label: string;
        selection: WireframeQuestion['selection'];
        options: WireframeQuestionOption[];
      }
    | null = null;

  function flushQuestion() {
    if (!currentQuestion || currentQuestion.options.length < 2) {
      currentQuestion = null;
      return;
    }

    questions.push({
      id: `q${questions.length + 1}`,
      label: currentQuestion.label,
      selection: currentQuestion.selection,
      options: currentQuestion.options
    });
    currentQuestion = null;
  }

  function stripMarkdownFormatting(value: string): string {
    return value
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/__(.*?)__/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .trim();
  }

  function parseInlineOptions(value: string): WireframeQuestionOption[] {
    const normalizedValue = value
      .replace(/\?+\s*$/, '')
      .replace(/\s+or\s+/gi, ', ')
      .replace(/\s+and\s+/gi, ', ');

    return normalizedValue
      .split(/\s*,\s*/)
      .map((option) => stripMarkdownFormatting(option))
      .filter((option) => option.length > 0)
      .slice(0, 8)
      .map((option, index) => ({
        id: String.fromCharCode(65 + index),
        label: option.charAt(0).toUpperCase() + option.slice(1)
      }));
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line) {
      continue;
    }

    const inlineChoiceMatch = line.match(INLINE_CHOICE_QUESTION_PATTERN);

    if (inlineChoiceMatch) {
      const options = parseInlineOptions(inlineChoiceMatch[3] ?? '');

      if (options.length >= 2) {
        flushQuestion();
        questions.push({
          id: `q${questions.length + 1}`,
          label: stripMarkdownFormatting(
            inlineChoiceMatch[1] ?? inlineChoiceMatch[2] ?? ''
          ),
          selection:
            inlineChoiceMatch[4]?.toLowerCase() === 'multi' ? 'multi' : 'single',
          options
        });
        currentQuestion = null;
        continue;
      }
    }

    const questionMatch = line.match(MARKDOWN_QUESTION_PATTERN);

    if (questionMatch) {
      flushQuestion();
      currentQuestion = {
        label: stripMarkdownFormatting(questionMatch[1] ?? ''),
        selection: questionMatch[2]?.toLowerCase() === 'multi' ? 'multi' : 'single',
        options: []
      };
      continue;
    }

    const optionMatch = line.match(MARKDOWN_OPTION_PATTERN);

    if (optionMatch && currentQuestion) {
      const optionId = optionMatch[1]?.toUpperCase() ?? '';
      const optionLabel = optionMatch[2]?.trim() ?? '';

      if (optionId && optionLabel) {
        currentQuestion.options.push({
          id: optionId,
          label: optionLabel
        });
      }
    }
  }

  flushQuestion();

  return questions.length > 0
    ? {
        type: 'questions',
        questions
      }
    : null;
}

function findBalancedJsonObject(source: string, startIndex: number): string | null {
  if (source[startIndex] !== '{') {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIndex; i < source.length; i += 1) {
    const ch = source[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\') {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;

      if (depth === 0) {
        return source.slice(startIndex, i + 1);
      }
    }
  }

  return null;
}

function extractWireframeArtifactsFromText(source: string): WireframeArtifact[] {
  const artifacts: WireframeArtifact[] = [];
  const seen = new Set<string>();

  function pushIfNew(candidate: string | null | undefined) {
    if (!candidate) {
      return;
    }

    const normalized = candidate.trim();

    if (!normalized || seen.has(normalized)) {
      return;
    }

    const artifact = parseArtifactJson(normalized);

    if (artifact) {
      seen.add(normalized);
      artifacts.push(artifact);
    }
  }

  for (const match of source.matchAll(WIREFRAME_BLOCK_PATTERN)) {
    pushIfNew(match[1]);
  }

  if (artifacts.length > 0) {
    return artifacts;
  }

  for (const match of source.matchAll(GENERIC_CODE_BLOCK_PATTERN)) {
    pushIfNew(match[1]);
  }

  if (artifacts.length > 0) {
    return artifacts;
  }

  for (const match of source.matchAll(BARE_WIREFRAME_OBJECT_PATTERN)) {
    if (match.index === undefined) {
      continue;
    }

    const json = findBalancedJsonObject(source, match.index);
    pushIfNew(json);
  }

  return artifacts;
}

export function parseWireframeArtifacts(content: string): WireframeArtifact[] {
  const withoutThinking = stripThinking(content);
  const fromAnswer = extractWireframeArtifactsFromText(withoutThinking);

  if (fromAnswer.length > 0) {
    return fromAnswer;
  }

  const fromThinking = extractWireframeArtifactsFromText(content);

  if (fromThinking.length > 0) {
    return fromThinking;
  }

  const markdownQuestions = parseMarkdownQuestions(withoutThinking);

  if (markdownQuestions) {
    return [markdownQuestions];
  }

  const html = withoutThinking.match(HTML_BLOCK_PATTERN)?.[1]?.trim();

  if (!html || !isPreviewableHtml(html)) {
    return [];
  }

  return [
    {
      type: 'design',
      title: 'Wireframe',
      html,
      css: withoutThinking.match(CSS_BLOCK_PATTERN)?.[1] ?? '',
      js: withoutThinking.match(JS_BLOCK_PATTERN)?.[1] ?? ''
    }
  ];
}

export function parseWireframeArtifact(content: string): WireframeArtifact | null {
  return parseWireframeArtifacts(content).at(-1) ?? null;
}

export function stripWireframeBlocks(content: string): string {
  return content
    .replace(WIREFRAME_BLOCK_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const WIREFRAME_SCAFFOLD_DESIGN: WireframeDesignArtifact = {
  type: 'design',
  title: 'Wireframe scaffold',
  html: [
    '<main class="screen-set">',
    '  <figure class="frame">',
    '    <figcaption>Screen 1</figcaption>',
    '    <section class="phone-screen">',
    '      <header class="screen-header">Screen title</header>',
    '      <div class="screen-body">Replace this placeholder with real content.</div>',
    '      <nav class="bottom-nav">Tab · Tab · Tab</nav>',
    '    </section>',
    '  </figure>',
    '  <figure class="frame">',
    '    <figcaption>Screen 2</figcaption>',
    '    <section class="phone-screen">',
    '      <header class="screen-header">Screen title</header>',
    '      <div class="screen-body">Replace this placeholder with real content.</div>',
    '      <nav class="bottom-nav">Tab · Tab · Tab</nav>',
    '    </section>',
    '  </figure>',
    '</main>'
  ].join('\n'),
  css: [
    'html, body { margin: 0; background: transparent; overflow: hidden; }',
    '.screen-set { display: grid; grid-template-columns: repeat(4, minmax(260px, 1fr)); gap: 32px 24px; padding: 32px; max-width: 1280px; background: transparent; }',
    '.frame { margin: 0; background: transparent; }',
    '.frame figcaption { color: #94a3b8; font: 12px/1.4 ui-sans-serif, system-ui, sans-serif; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.12em; }',
    '.phone-screen { width: 100%; max-width: 280px; height: 560px; border-radius: 32px; background: #0f172a; color: #e2e8f0; padding: 20px; box-shadow: 0 16px 40px rgba(0,0,0,0.4); overflow: hidden; display: flex; flex-direction: column; }',
    '.screen-header { font-size: 16px; font-weight: 600; margin-bottom: 12px; }',
    '.screen-body { flex: 1; font-size: 13px; line-height: 1.5; color: #cbd5e1; }',
    '.bottom-nav { margin-top: auto; padding: 12px 0; border-top: 1px solid #1e293b; font-size: 12px; color: #94a3b8; }'
  ].join('\n'),
  js: ''
};

export function buildWireframeScaffoldPrompt(userRequest: string): string {
  return [
    'Wireframe scaffold to extend (do NOT start from scratch — edit this base):',
    '```wireframe',
    JSON.stringify(WIREFRAME_SCAFFOLD_DESIGN),
    '```',
    '',
    'Scaffold rules:',
    '- Keep `<main class="screen-set">` as the only top-level wrapper.',
    '- Preserve the existing `html, body { background: transparent }` reset and the `.screen-set` CSS grid (`repeat(4, minmax(260px, 1fr))`); only the screen content inside `.phone-screen` gets visible chrome.',
    '- Replace the placeholder screens with at least 4 sibling `.phone-screen` frames (typical 5-8) covering the brief, each inside its own `<figure class="frame"><figcaption>Name</figcaption>...</figure>`.',
    '- Add new CSS rules below the scaffold base; do not remove the transparent wrapper rules.',
    '- Output exactly one fenced ```wireframe JSON `type:"design"` artifact when generating, or one `type:"questions"` artifact when more requirements are needed.',
    '',
    'User request:',
    userRequest
  ].join('\n');
}

export function buildWireframeAnswerPrompt(input: {
  questions: WireframeQuestion[];
  answers: Record<string, string[]>;
}): string {
  const lines = [
    'Wireframe questionnaire answers:',
    '',
    ...input.questions.flatMap((question, index) => {
      const selectedLabels = question.options
        .filter((option) => (input.answers[question.id] ?? []).includes(option.id))
        .map((option) => option.label);

      return [
        `${index + 1}. ${question.label}`,
        `Answer: ${selectedLabels.length > 0 ? selectedLabels.join(', ') : 'No selection'}`
      ];
    }),
    '',
    'Continue the wireframe workflow. Ask more multiple-choice questions only if critical requirements are still missing. Otherwise generate or revise the design using the wireframe JSON design contract.'
  ];

  return lines.join('\n');
}

export function buildWireframePreviewDocument(design: WireframeDesignArtifact): string {
  const safeScript = design.js.replace(/<\/script/gi, '<\\/script');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; font-src data:; frame-src 'none'; form-action 'none'; base-uri 'none';">
  <style>
    html,
    body {
      margin: 0;
      width: 100%;
      height: 100%;
      min-width: max-content;
      min-height: max-content;
      overflow: visible !important;
      overscroll-behavior: none;
      scrollbar-width: none;
      touch-action: none;
    }

    body::-webkit-scrollbar,
    *::-webkit-scrollbar {
      display: none !important;
    }

    ${design.css}

    html,
    body {
      background: transparent !important;
    }

    [class*="canvas" i],
    [class*="stage" i],
    [class*="artboard" i],
    [class*="workspace" i],
    [class*="preview" i],
    [class*="prototype" i],
    [class*="mockup" i],
    [class*="screen-set" i],
    [class*="screens" i],
    [class*="layout" i],
    [class*="wrapper" i],
    [class*="container" i] {
      background: transparent !important;
      background-color: transparent !important;
      background-image: none !important;
    }

    body > [class*="canvas" i],
    body > [class*="stage" i],
    body > [class*="artboard" i],
    body > [class*="workspace" i],
    body > [class*="preview" i],
    body > [class*="prototype" i],
    body > [class*="mockup" i],
    body > [class*="screen-set" i],
    body > [class*="screens" i],
    body > [class*="layout" i],
    body > [class*="wrapper" i],
    body > [class*="container" i],
    body > [id*="canvas" i],
    body > [id*="stage" i],
    body > [id*="artboard" i],
    body > [id*="workspace" i],
    body > [id*="preview" i],
    body > [id*="prototype" i],
    body > [id*="mockup" i],
    body > [id*="screen-set" i],
    body > [id*="screens" i],
    body > [id*="layout" i],
    body > [id*="wrapper" i],
    body > [id*="container" i] {
      background: transparent !important;
      background-color: transparent !important;
      background-image: none !important;
    }
  </style>
</head>
<body>
  ${design.html}
  <script>
    window.addEventListener('wheel', function (event) {
      event.preventDefault();
      event.stopPropagation();
      window.parent.postMessage({
        source: 'helix-wireframe-preview',
        type: 'wheel',
        deltaY: event.deltaY,
        clientX: event.clientX,
        clientY: event.clientY
      }, '*');
    }, { capture: true, passive: false });

    function reportHelixWireframeContentSize() {
      var doc = document.documentElement;
      window.parent.postMessage({
        source: 'helix-wireframe-preview',
        type: 'resize',
        width: Math.max(doc.scrollWidth, document.body.scrollWidth),
        height: Math.max(doc.scrollHeight, document.body.scrollHeight)
      }, '*');
    }

    try {
      ${safeScript}
    } catch (error) {
      var warning = document.createElement('pre');
      warning.textContent = 'Wireframe script error: ' + (error && error.message ? error.message : String(error));
      warning.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;margin:0;padding:10px;border:1px solid #fecaca;background:#450a0a;color:#fee2e2;font:12px/1.4 ui-monospace,monospace;white-space:pre-wrap;';
      document.body.appendChild(warning);
    }

    window.addEventListener('load', reportHelixWireframeContentSize);
    if (typeof ResizeObserver === 'function') {
      var resizeObserver = new ResizeObserver(reportHelixWireframeContentSize);
      resizeObserver.observe(document.body);
    }
  </script>
</body>
</html>`;
}

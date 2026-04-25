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

function parseArtifactJson(rawJson: string): WireframeArtifact | null {
  try {
    const parsed = asRecord(JSON.parse(rawJson));

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

export function parseWireframeArtifacts(content: string): WireframeArtifact[] {
  const withoutThinking = stripThinking(content);
  const artifacts: WireframeArtifact[] = [];

  for (const match of withoutThinking.matchAll(WIREFRAME_BLOCK_PATTERN)) {
    const artifact = parseArtifactJson(match[1] ?? '');

    if (artifact) {
      artifacts.push(artifact);
    }
  }

  if (artifacts.length > 0) {
    return artifacts;
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
    function clearHelixWireframeStageBackgrounds() {
      const stageNamePattern = /canvas|stage|artboard|workspace|preview|prototype|mockup|viewport|board|screen-set|screens|layout|wrapper|container|shell/i;
      const productFramePattern = /phone|mobile|screen|device|app-screen|appScreen/i;
      const elements = Array.from(document.body.querySelectorAll('*')).filter(function (element) {
        const tagName = element.tagName.toLowerCase();
        return element instanceof HTMLElement && tagName !== 'script' && tagName !== 'style';
      });

      for (const element of elements) {
        const name = [
          element.id,
          element.className,
          element.getAttribute('aria-label') || ''
        ].join(' ');

        const rect = element.getBoundingClientRect();
        const parentArea = rect.width * rect.height;
        const childRects = Array.from(element.children)
          .filter(function (child) {
            return child instanceof HTMLElement;
          })
          .map(function (child) {
            return child.getBoundingClientRect();
          });
        const hasSmallerProductChild = childRects.some(function (childRect) {
          const childArea = childRect.width * childRect.height;

          return childArea > 5000 && parentArea > 0 && childArea < parentArea * 0.82;
        });
        const isNamedProductFrame =
          productFramePattern.test(name) && !stageNamePattern.test(name);

        if (isNamedProductFrame) {
          continue;
        }

        const looksLikeStage =
          stageNamePattern.test(name) ||
          (rect.width >= 420 && rect.height >= 260 && hasSmallerProductChild);

        if (!looksLikeStage) {
          continue;
        }

        element.style.setProperty('background', 'transparent', 'important');
        element.style.setProperty('background-color', 'transparent', 'important');
        element.style.setProperty('background-image', 'none', 'important');
      }
    }

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
      const docElement = document.documentElement;
      const body = document.body;
      const widestChildren = Array.from(body.children)
        .filter(function (child) { return child instanceof HTMLElement; })
        .reduce(function (acc, child) {
          const rect = child.getBoundingClientRect();
          return {
            width: Math.max(acc.width, rect.right),
            height: Math.max(acc.height, rect.bottom)
          };
        }, { width: 0, height: 0 });
      const width = Math.max(
        docElement.scrollWidth,
        body.scrollWidth,
        docElement.offsetWidth,
        body.offsetWidth,
        widestChildren.width
      );
      const height = Math.max(
        docElement.scrollHeight,
        body.scrollHeight,
        docElement.offsetHeight,
        body.offsetHeight,
        widestChildren.height
      );
      window.parent.postMessage({
        source: 'helix-wireframe-preview',
        type: 'resize',
        width: Math.ceil(width),
        height: Math.ceil(height)
      }, '*');
    }

    try {
      clearHelixWireframeStageBackgrounds();
      window.requestAnimationFrame(clearHelixWireframeStageBackgrounds);
      ${safeScript}
    } catch (error) {
      const warning = document.createElement('pre');
      warning.textContent = 'Wireframe script error: ' + (error && error.message ? error.message : String(error));
      warning.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;margin:0;padding:10px;border:1px solid #fecaca;background:#450a0a;color:#fee2e2;font:12px/1.4 ui-monospace,monospace;white-space:pre-wrap;';
      document.body.appendChild(warning);
    }

    reportHelixWireframeContentSize();
    window.requestAnimationFrame(reportHelixWireframeContentSize);
    window.addEventListener('load', reportHelixWireframeContentSize);
    setTimeout(reportHelixWireframeContentSize, 100);
    setTimeout(reportHelixWireframeContentSize, 400);
    setTimeout(reportHelixWireframeContentSize, 1000);
    if (typeof ResizeObserver === 'function') {
      const resizeObserver = new ResizeObserver(reportHelixWireframeContentSize);
      resizeObserver.observe(document.body);
      resizeObserver.observe(document.documentElement);
    }
    if (typeof MutationObserver === 'function') {
      const mutationObserver = new MutationObserver(reportHelixWireframeContentSize);
      mutationObserver.observe(document.body, { childList: true, subtree: true, attributes: true });
    }
  </script>
</body>
</html>`;
}

import { describe, expect, it } from 'vitest';
import {
  buildWireframeAnswerPrompt,
  buildWireframePreviewDocument,
  parseWireframeArtifact,
  parseWireframeArtifacts,
  stripWireframeBlocks
} from '@renderer/lib/wireframe';

describe('wireframe helpers', () => {
  it('parses structured multiple-choice questions', () => {
    const artifact = parseWireframeArtifact(`Pick a direction.

\`\`\`wireframe
{"type":"questions","questions":[{"id":"tone","label":"What tone should the app use?","selection":"multi","options":[{"id":"A","label":"Operational"},{"id":"B","label":"Playful"}]}]}
\`\`\``);

    expect(artifact).toEqual({
      type: 'questions',
      questions: [
        {
          id: 'tone',
          label: 'What tone should the app use?',
          selection: 'multi',
          options: [
            { id: 'A', label: 'Operational' },
            { id: 'B', label: 'Playful' }
          ]
        }
      ]
    });
  });

  it('falls back to parsing markdown multiple-choice questions', () => {
    const artifact = parseWireframeArtifact(`Before I generate the wireframe:

1. Who is the primary user?
A. Casual listener
B. Playlist curator
C. Artist manager

2. Which flows should be interactive? (multi select)
A. Playback controls
B. Playlist creation
C. Search filters`);

    expect(artifact).toEqual({
      type: 'questions',
      questions: [
        {
          id: 'q1',
          label: 'Who is the primary user?',
          selection: 'single',
          options: [
            { id: 'A', label: 'Casual listener' },
            { id: 'B', label: 'Playlist curator' },
            { id: 'C', label: 'Artist manager' }
          ]
        },
        {
          id: 'q2',
          label: 'Which flows should be interactive?',
          selection: 'multi',
          options: [
            { id: 'A', label: 'Playback controls' },
            { id: 'B', label: 'Playlist creation' },
            { id: 'C', label: 'Search filters' }
          ]
        }
      ]
    });
  });

  it('falls back to parsing inline numbered choice questions', () => {
    const artifact = parseWireframeArtifact(`I've laid out questions:

1. **Visual theme** — dark, light, adaptive, or warm minimal?
2. **Mini-player behavior** — persistent, compact, expandable, or hidden?`);

    expect(artifact).toEqual({
      type: 'questions',
      questions: [
        {
          id: 'q1',
          label: 'Visual theme',
          selection: 'single',
          options: [
            { id: 'A', label: 'Dark' },
            { id: 'B', label: 'Light' },
            { id: 'C', label: 'Adaptive' },
            { id: 'D', label: 'Warm minimal' }
          ]
        },
        {
          id: 'q2',
          label: 'Mini-player behavior',
          selection: 'single',
          options: [
            { id: 'A', label: 'Persistent' },
            { id: 'B', label: 'Compact' },
            { id: 'C', label: 'Expandable' },
            { id: 'D', label: 'Hidden' }
          ]
        }
      ]
    });
  });

  it('parses a design artifact and strips the machine block from markdown', () => {
    const content = `Here is the first wireframe.

\`\`\`wireframe
{"type":"design","title":"Task Board","html":"<main><h1>Tasks</h1></main>","css":"main { padding: 24px; }","js":""}
\`\`\``;

    expect(parseWireframeArtifact(content)).toMatchObject({
      type: 'design',
      title: 'Task Board',
      html: '<main><h1>Tasks</h1></main>'
    });
    expect(stripWireframeBlocks(content)).toBe('Here is the first wireframe.');
  });

  it('keeps every structured design artifact for version history', () => {
    const artifacts = parseWireframeArtifacts(`Two iterations.

\`\`\`wireframe
{"type":"design","title":"V1","html":"<main>One</main>","css":"","js":""}
\`\`\`

\`\`\`wireframe
{"type":"design","title":"V2","html":"<main>Two</main>","css":"","js":""}
\`\`\``);

    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]).toMatchObject({ type: 'design', title: 'V1' });
    expect(artifacts[1]).toMatchObject({ type: 'design', title: 'V2' });
  });

  it('rejects design artifacts that point to external project files', () => {
    const artifact = parseWireframeArtifact(`Here is the file.

\`\`\`wireframe
{"type":"design","title":"Broken","html":"See index.html","css":"","js":""}
\`\`\``);

    expect(artifact).toBeNull();
  });

  it('parses file-labeled HTML, CSS, and JS fences as a preview design fallback', () => {
    const artifact = parseWireframeArtifact(`Here is the inline preview source.

\`\`\`html filename="index.html"
<main><section class="phone-screen"><button id="play">Play</button></section></main>
\`\`\`

\`\`\`css filename="styles.css"
.phone-screen { background: #101827; }
\`\`\`

\`\`\`js filename="app.js"
document.getElementById('play')?.setAttribute('aria-pressed', 'true');
\`\`\``);

    expect(artifact).toMatchObject({
      type: 'design',
      title: 'Wireframe',
      html: '<main><section class="phone-screen"><button id="play">Play</button></section></main>',
      css: '.phone-screen { background: #101827; }\n',
      js: "document.getElementById('play')?.setAttribute('aria-pressed', 'true');\n"
    });
  });

  it('builds a compact answer prompt from selected options', () => {
    const prompt = buildWireframeAnswerPrompt({
      questions: [
        {
          id: 'color',
          label: 'What color scheme should it use?',
          selection: 'single',
          options: [
            { id: 'A', label: 'Neutral' },
            { id: 'B', label: 'Bright' }
          ]
        }
      ],
      answers: {
        color: ['B']
      }
    });

    expect(prompt).toContain('What color scheme should it use?');
    expect(prompt).toContain('Answer: Bright');
    expect(prompt).toContain('Continue the wireframe workflow.');
  });

  it('injects safeguards against top-level stage backgrounds', () => {
    const document = buildWireframePreviewDocument({
      type: 'design',
      title: 'Background Guard',
      html: '<main class="artboard"><section class="phone-screen">App</section></main>',
      css: '.artboard { background: #fff; } .phone-screen { background: #111; }',
      js: ''
    });

    expect(document).toContain('body > [class*="artboard" i]');
    expect(document).toContain('body > [class*="screen-set" i]');
    expect(document).toContain('background: transparent !important');
    expect(document).toContain('background-color: transparent !important');
  });
});

import type blessed from 'blessed';
import type { DesktopAppContext } from '@bridge/app-context';
import type { GenerationStreamEvent } from '@bridge/ipc/contracts';
import { tags, boxStyle, inputStyle } from '@tui/theme';
import { colors } from '@tui/theme';

export class GenerationScreen {
  private panel: blessed.Widgets.BoxElement;
  private input: blessed.Widgets.TextareaElement;
  private jobList: blessed.Widgets.ListElement;
  private unsubGeneration: (() => void) | null = null;

  constructor(
    private screen: blessed.Widgets.Screen,
    private ctx: DesktopAppContext
  ) {
    this.jobList = blessed.list({
      parent: screen,
      top: 0,
      left: 0,
      width: '50%',
      bottom: 1,
      style: {
        ...boxStyle,
        selected: { fg: colors.accent, bg: colors.bg }
      },
      border: { type: 'line' },
      label: ' Image Jobs ',
      keys: true,
      vi: true,
      mouse: true,
      tags: true
    });

    this.panel = blessed.box({
      parent: screen,
      top: 0,
      left: '50%',
      right: 0,
      bottom: 1,
      style: boxStyle,
      border: { type: 'line' },
      label: ' Job Details ',
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      mouse: true,
      tags: true
    });

    this.input = blessed.textarea({
      parent: screen,
      bottom: 1,
      left: 0,
      right: 0,
      height: 3,
      style: inputStyle,
      border: { type: 'line' },
      label: ' Prompt (Enter to submit) ',
      inputOnFocus: true
    });

    this.input.key('enter', () => {
      const prompt = this.input.getValue().trim();
      if (prompt) {
        void this.submitJob(prompt);
        this.input.clearValue();
        this.screen.render();
      }
    });

    this.jobList.on('select', (_item: unknown, index: number) => {
      this.showJobDetail(index);
    });
  }

  init(): void {
    this.refreshJobs();
    this.unsubGeneration = this.ctx.generationService.subscribe((event: GenerationStreamEvent) => {
      this.handleGenerationEvent(event);
    });
    this.screen.render();
  }

  private refreshJobs(): void {
    const jobs = this.ctx.generationService.listJobs();
    const items = jobs.map(j => {
      const status = j.status === 'completed'
        ? tags.success(j.status)
        : j.status === 'failed'
          ? tags.error(j.status)
          : j.status === 'running'
            ? tags.warning(j.status)
            : tags.muted(j.status);
      return `${status} ${(j.prompt ?? '').substring(0, 30)}...`;
    });
    this.jobList.setItems(items);
  }

  private async submitJob(prompt: string): Promise<void> {
    try {
      const settings = this.ctx.settingsService.get();
      await this.ctx.generationService.startImageJob({
        prompt,
        model: settings.imageModel,
        width: settings.imageWidth,
        height: settings.imageHeight,
        steps: settings.imageSteps,
        guidanceScale: settings.imageGuidanceScale
      });
      this.refreshJobs();
    } catch (err) {
      this.panel.setContent(tags.error(`Failed: ${(err as Error).message}`));
      this.screen.render();
    }
  }

  private handleGenerationEvent(event: GenerationStreamEvent): void {
    if (event.type === 'job-updated') {
      this.refreshJobs();
      this.screen.render();
    }
  }

  private showJobDetail(index: number): void {
    const jobs = this.ctx.generationService.listJobs();
    const job = jobs[index];
    if (!job) return;

    const lines = [
      `${tags.bold('ID:')} ${job.id}`,
      `${tags.bold('Status:')} ${job.status}`,
      `${tags.bold('Prompt:')} ${job.prompt}`,
      `${tags.bold('Model:')} ${job.model}`,
      `${tags.bold('Progress:')} ${Math.round(job.progress * 100)}%`,
      `${tags.bold('Created:')} ${job.createdAt}`,
      job.errorMessage ? `${tags.bold('Error:')} ${tags.error(job.errorMessage)}` : ''
    ].filter(Boolean);

    this.panel.setContent(lines.join('\n'));
    this.screen.render();
  }

  focus(): void {
    this.input.focus();
    this.screen.render();
  }

  destroy(): void {
    this.unsubGeneration?.();
  }
}
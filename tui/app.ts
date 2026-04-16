import blessed from 'blessed';
import type { DesktopAppContext } from '@bridge/app-context';
import { ChatScreen } from '@tui/screens/chat';
import { WorkspaceScreen } from '@tui/screens/workspace';
import { GenerationScreen } from '@tui/screens/generation';
import { CapabilitiesScreen } from '@tui/screens/capabilities';
import { createStatusBar, updateStatusBar, type StatusBarState } from '@tui/components/status-bar';
import { keybindings } from '@tui/keybindings';
import { screenDefaults } from '@tui/theme';

export type ScreenName = 'chat' | 'workspace' | 'generation' | 'capabilities';

export class TuiApp {
  private screen: blessed.Widgets.Screen;
  private statusBar: blessed.Widgets.BoxElement;
  private chatScreen: ChatScreen;
  private workspaceScreen: WorkspaceScreen;
  private generationScreen: GenerationScreen;
  private capabilitiesScreen: CapabilitiesScreen;
  private activeScreen: ScreenName = 'chat';
  private ollamaStatus: 'connected' | 'disconnected' = 'disconnected';

  constructor(private ctx: DesktopAppContext) {
    this.screen = blessed.screen({
      ...screenDefaults,
      title: 'Helix TUI'
    });

    this.statusBar = createStatusBar(this.screen);

    this.chatScreen = new ChatScreen(this.screen, ctx);
    this.workspaceScreen = new WorkspaceScreen(this.screen, ctx, (wsId) => {
      this.chatScreen.setWorkspace(wsId);
    });
    this.generationScreen = new GenerationScreen(this.screen, ctx);
    this.capabilitiesScreen = new CapabilitiesScreen(this.screen, ctx);

    this.bindKeys();
    this.updateStatus();
  }

  async init(): Promise<void> {
    await this.chatScreen.init();
    this.workspaceScreen.init();
    this.generationScreen.init();
    this.capabilitiesScreen.init();

    this.switchScreen('chat');
    this.checkOllamaStatus();
  }

  private bindKeys(): void {
    this.screen.key(keybindings.quit, () => {
      this.screen.destroy();
      process.exit(0);
    });

    this.screen.key(keybindings.screenChat, () => this.switchScreen('chat'));
    this.screen.key(keybindings.screenWorkspace, () => this.switchScreen('workspace'));
    this.screen.key(keybindings.screenGeneration, () => this.switchScreen('generation'));
    this.screen.key(keybindings.screenCapabilities, () => this.switchScreen('capabilities'));

    this.screen.key(keybindings.newConversation, () => {
      this.chatScreen.setWorkspace(this.chatScreen.getWorkspaceId());
    });

    this.screen.key(keybindings.cancelStream, () => {
      if (this.activeScreen === 'chat') {
        this.chatScreen.getInput().focus();
      }
    });
  }

  private switchScreen(name: ScreenName): void {
    this.activeScreen = name;

    switch (name) {
      case 'chat':
        this.chatScreen.focus();
        break;
      case 'workspace':
        this.workspaceScreen.focus();
        break;
      case 'generation':
        this.generationScreen.focus();
        break;
      case 'capabilities':
        this.capabilitiesScreen.focus();
        break;
    }

    this.updateStatus();
  }

  private updateStatus(): void {
    updateStatusBar(this.statusBar, {
      model: this.chatScreen.getModel() || 'none',
      workspace: this.chatScreen.getWorkspaceId() ? 'active' : 'default',
      ollamaStatus: this.ollamaStatus,
      screen: this.activeScreen
    });
  }

  private async checkOllamaStatus(): Promise<void> {
    try {
      const settings = this.ctx.settingsService.get();
      const status = await this.ctx.ollamaClient.getStatus(settings.ollamaBaseUrl);
      this.ollamaStatus = status.isRunning ? 'connected' : 'disconnected';
    } catch {
      this.ollamaStatus = 'disconnected';
    }
    this.updateStatus();
  }

  getScreen(): blessed.Widgets.Screen {
    return this.screen;
  }
}
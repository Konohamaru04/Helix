import path from 'node:path';
import { shell } from 'electron';
import { CapabilityRepository, CapabilityService } from '@bridge/capabilities';
import { DatabaseManager } from '@bridge/db/database';
import { GenerationRepository } from '@bridge/generation/repository';
import { GenerationService } from '@bridge/generation/service';
import { type SystemStatus, systemStatusSchema } from '@bridge/ipc/contracts';
import { createLogger } from '@bridge/logging/logger';
import { MemoryService } from '@bridge/memory';
import { getMcpCapabilitySurface } from '@bridge/mcp';
import { NvidiaClient } from '@bridge/nvidia/client';
import { OllamaClient } from '@bridge/ollama/client';
import { getDeferredPythonSitePackagesPath } from '@bridge/python/deferred-runtime';
import { PythonServerManager } from '@bridge/python/lifecycle';
import { BridgeQueue } from '@bridge/queue';
import { RagService } from '@bridge/rag';
import { ChatRouter } from '@bridge/router';
import { SettingsService, defaultUserSettings } from '@bridge/settings/service';
import { SkillRegistry, listBuiltinSkills } from '@bridge/skills';
import { ToolDispatcher, listBuiltinTools } from '@bridge/tools';
import type { Logger } from 'pino';
import { ChatRepository } from './chat/repository';
import { ChatService } from './chat/service';
import { TurnMetadataService } from './chat/turn-metadata';

export interface DesktopAppContextOptions {
  appPath: string;
  appVersion: string;
  userDataPath: string;
}

export class DesktopAppContext {
  readonly logger: Logger;
  readonly logDirectory: string;
  readonly database: DatabaseManager;
  readonly settingsService: SettingsService;
  readonly queue: BridgeQueue;
  readonly ollamaClient: OllamaClient;
  readonly nvidiaClient: NvidiaClient;
  readonly pythonManager: PythonServerManager;
  readonly repository: ChatRepository;
  readonly capabilityRepository: CapabilityRepository;
  readonly capabilityService: CapabilityService;
  readonly turnMetadataService: TurnMetadataService;
  readonly router: ChatRouter;
  readonly skillRegistry: SkillRegistry;
  readonly ragService: RagService;
  readonly toolDispatcher: ToolDispatcher;
  readonly memoryService: MemoryService;
  readonly generationRepository: GenerationRepository;
  readonly generationService: GenerationService;
  readonly chatService: ChatService;

  constructor(private readonly options: DesktopAppContextOptions) {
    this.logDirectory = path.join(options.userDataPath, 'logs');
    this.logger = createLogger('app', {
      logDirectory: this.logDirectory
    });
    this.queue = new BridgeQueue();
    this.ollamaClient = new OllamaClient(this.logger.child({ scope: 'ollama' }));
    this.nvidiaClient = new NvidiaClient(this.logger.child({ scope: 'nvidia' }));
    this.router = new ChatRouter(this.logger.child({ scope: 'router' }));
    const databasePath = path.join(options.userDataPath, 'data', 'ollama-desktop.sqlite');
    const skillsDirectory = path.join(options.appPath, 'skills');
    this.database = new DatabaseManager(
      databasePath,
      this.logger.child({ scope: 'database' })
    );
    this.settingsService = new SettingsService(
      this.database,
      this.logger.child({ scope: 'settings' })
    );
    this.repository = new ChatRepository(this.database);
    this.capabilityRepository = new CapabilityRepository(this.database);
    this.turnMetadataService = new TurnMetadataService(this.database);
    this.pythonManager = new PythonServerManager(
      options.appPath,
      this.logger.child({ scope: 'python' }),
      defaultUserSettings.pythonPort,
      path.join(options.userDataPath, 'python-worker'),
      [getDeferredPythonSitePackagesPath(options.userDataPath)]
    );
    this.skillRegistry = new SkillRegistry(
      skillsDirectory,
      this.database,
      this.logger.child({ scope: 'skills' })
    );
    this.ragService = new RagService(this.database, this.logger.child({ scope: 'rag' }));
    this.generationRepository = new GenerationRepository(this.database);
    this.capabilityService = new CapabilityService(
      options.appPath,
      this.capabilityRepository,
      this.repository,
      this.skillRegistry,
      this.settingsService,
      this.ollamaClient,
      this.nvidiaClient,
      this.logger.child({ scope: 'capabilities' }),
      path.join(options.userDataPath, 'capability-data')
    );
    this.toolDispatcher = new ToolDispatcher(
      options.appPath,
      this.repository,
      this.ragService,
      async (targetPath) => shell.openPath(targetPath),
      undefined,
      this.capabilityService
    );
    this.memoryService = new MemoryService(this.repository, this.turnMetadataService);
    this.generationService = new GenerationService(
      this.generationRepository,
      this.repository,
      this.settingsService,
      this.pythonManager,
      this.logger.child({ scope: 'generation' }),
      path.join(options.userDataPath, 'generated', 'images')
    );
    this.chatService = new ChatService(
      this.repository,
      this.turnMetadataService,
      this.settingsService,
      this.ollamaClient,
      this.nvidiaClient,
      this.router,
      this.queue,
      this.logger.child({ scope: 'chat' }),
      this.memoryService,
      this.ragService,
      this.toolDispatcher,
      this.skillRegistry,
      this.generationRepository,
      this.generationService
    );
  }

  async initialize(): Promise<void> {
    this.database.initialize();
    const settings = this.settingsService.ensureDefaults();
    this.repository.ensureDefaultWorkspace();
    this.skillRegistry.load();
    this.capabilityService.initialize();

    this.logger.info(
      {
        appVersion: this.options.appVersion,
        logDirectory: this.logDirectory,
        builtinToolCount: listBuiltinTools().length,
        builtinSkillCount: listBuiltinSkills(path.join(this.options.appPath, 'skills')).length,
        mcpSurface: getMcpCapabilitySurface()
      },
      'Desktop app context initialized'
    );

    try {
      await this.pythonManager.restart(settings.pythonPort);
      await this.generationService.initialize();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown Python startup failure';
      this.logger.warn({ error: message }, 'Python server failed to start during app boot');
    }
  }

  async dispose(): Promise<void> {
    await this.pythonManager.stop();
    this.database.close();
  }

  disposeSync(): void {
    this.pythonManager.forceStopSync();
    this.database.close();
  }

  async getSystemStatus(): Promise<SystemStatus> {
    const settings = this.settingsService.get();

    return systemStatusSchema.parse({
      appVersion: this.options.appVersion,
      database: {
        ready: true,
        path: this.database.databasePath
      },
      activeTextBackend: settings.textInferenceBackend,
      ollama: await this.ollamaClient.getStatus(settings.ollamaBaseUrl),
      nvidia: await this.nvidiaClient.getStatus(
        settings.nvidiaBaseUrl,
        settings.nvidiaApiKey
      ),
      python: await this.pythonManager.getStatus(),
      pendingRequestCount: this.queue.getPendingRequestCount()
    });
  }
}

export async function createDesktopAppContext(
  options: DesktopAppContextOptions
): Promise<DesktopAppContext> {
  const context = new DesktopAppContext(options);
  await context.initialize();
  return context;
}

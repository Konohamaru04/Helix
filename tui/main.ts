import { createDesktopAppContext, type DesktopAppContext } from '@bridge/app-context';
import { APP_DISPLAY_NAME } from '@bridge/branding';
import { TuiApp } from '@tui/app';

async function main(): Promise<void> {
  console.log(`Starting ${APP_DISPLAY_NAME} TUI...`);

  let ctx: DesktopAppContext;
  try {
    ctx = await createDesktopAppContext({
      appPath: process.cwd(),
      appVersion: process.env.npm_package_version ?? '0.0.0',
      userDataPath: process.env.APPDATA ?? process.env.HOME ?? '.'
    });
  } catch (err) {
    console.error(`Failed to initialize: ${(err as Error).message}`);
    process.exit(1);
  }

  const app = new TuiApp(ctx);
  await app.init();

  const shutdown = async (): Promise<void> => {
    app.getScreen().destroy();
    await ctx.dispose();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
  });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
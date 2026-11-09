import { loadConfig } from './config';
import { createDb, migrateDb } from './db/client';
import { buildApp } from './http/app';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const { db, close } = createDb(config.databaseUrl);
  await migrateDb(db);
  const { app, io } = await buildApp({ config, db, now: () => Date.now(), fetch });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, 'shutting down');
    try {
      await io.close();
      await app.close();
      await close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: '0.0.0.0', port: config.port });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

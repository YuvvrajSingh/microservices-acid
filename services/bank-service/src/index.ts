import path from 'path';
import { Express } from 'express';
import { createBankDatabase, BankDatabase } from './db';
import { BankOutboxWorker } from './outboxWorker';
import { BankEventConsumer } from './eventConsumer';
import { createBankApp } from './api';
import { eventBus } from '../../../shared/eventBus';

export * from './db';
export * from './outboxWorker';
export * from './eventConsumer';
export * from './api';

export interface BankServiceInstance {
  db: BankDatabase;
  outboxWorker: BankOutboxWorker;
  eventConsumer: BankEventConsumer;
  app: Express;
  server?: import('http').Server;
  close: () => Promise<void>;
}

export function startBankService(options: {
  dbPath?: string;
  port?: number;
  startWorker?: boolean;
} = {}): BankServiceInstance {
  const dbPath = options.dbPath || path.resolve(__dirname, '../bank.db');
  const db = createBankDatabase(dbPath);

  const outboxWorker = new BankOutboxWorker(db, eventBus);
  const eventConsumer = new BankEventConsumer(db, eventBus, outboxWorker);

  if (options.startWorker !== false) {
    outboxWorker.start();
  }

  eventConsumer.start();

  const app = createBankApp({ db, outboxWorker, eventConsumer });

  let server: import('http').Server | undefined;
  if (options.port) {
    server = app.listen(options.port, () => {
      console.log(`[BankService] Server running on http://localhost:${options.port}`);
    });
  }

  const close = async (): Promise<void> => {
    outboxWorker.stop();
    eventConsumer.stop();
    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
      });
    }
    db.close();
  };

  return {
    db,
    outboxWorker,
    eventConsumer,
    app,
    server,
    close,
  };
}

// Auto-run if executed directly via CLI
if (require.main === module) {
  const port = parseInt(process.env.BANK_SERVICE_PORT || process.env.PORT || '3002', 10);
  const instance = startBankService({ port });

  const shutdown = async () => {
    console.log('[BankService] Shutting down gracefully...');
    await instance.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

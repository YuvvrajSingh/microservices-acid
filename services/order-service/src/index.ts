import path from 'path';
import { createOrderDatabase, OrderDatabase } from './db';
import { OrderOutboxWorker } from './outboxWorker';
import { OrderEventConsumer } from './eventConsumer';
import { createOrderApp } from './app';
import { eventBus } from '../../../shared/eventBus';

export * from './db';
export * from './outboxWorker';
export * from './eventConsumer';
export * from './app';

export interface OrderServiceInstance {
  db: OrderDatabase;
  outboxWorker: OrderOutboxWorker;
  eventConsumer: OrderEventConsumer;
  app: ReturnType<typeof createOrderApp>;
  server?: import('http').Server;
  close: () => Promise<void>;
}

export function startOrderService(options: {
  dbPath?: string;
  port?: number;
  startWorker?: boolean;
} = {}): OrderServiceInstance {
  const dbPath = options.dbPath || path.resolve(__dirname, '../order.db');
  const db = createOrderDatabase(dbPath);

  const outboxWorker = new OrderOutboxWorker(db, eventBus);
  const eventConsumer = new OrderEventConsumer(db, eventBus);

  if (options.startWorker !== false) {
    outboxWorker.start();
  }

  eventConsumer.start();

  const app = createOrderApp({ db, outboxWorker, eventConsumer });

  let server: import('http').Server | undefined;
  if (options.port) {
    server = app.listen(options.port, () => {
      console.log(`[OrderService] Server running on http://localhost:${options.port}`);
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
  const port = parseInt(process.env.ORDER_SERVICE_PORT || process.env.PORT || '3001', 10);
  const instance = startOrderService({ port });

  const shutdown = async () => {
    console.log('[OrderService] Shutting down gracefully...');
    await instance.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

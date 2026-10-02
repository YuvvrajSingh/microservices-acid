import express, { Request, Response, NextFunction } from 'express';
import { OrderDatabase } from './db';
import { OrderOutboxWorker } from './outboxWorker';
import { OrderEventConsumer } from './eventConsumer';

export interface CreateOrderAppOptions {
  db: OrderDatabase;
  outboxWorker?: OrderOutboxWorker;
  eventConsumer?: OrderEventConsumer;
  consumer?: OrderEventConsumer;
}

export function createOrderApp(options: CreateOrderAppOptions): express.Express {
  const { db, outboxWorker } = options;
  const app = express();

  app.use(express.json());

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'OK',
      service: 'order-service',
      timestamp: new Date().toISOString(),
    });
  });

  // Create an order
  app.post('/orders', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { userId, user_id, amount, currency } = req.body || {};
      const targetUserId = userId || user_id;

      if (!targetUserId || typeof targetUserId !== 'string' || targetUserId.trim() === '') {
        res.status(400).json({
          success: false,
          error: 'Field "userId" (string) is required.',
        });
        return;
      }

      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
        res.status(400).json({
          success: false,
          error: 'Field "amount" must be a positive number.',
        });
        return;
      }

      // Execute local ACID transaction (insert order + insert outbox)
      const order = db.createOrderWithOutbox({
        userId: targetUserId.trim(),
        amount,
        currency: currency || 'USD',
      });

      // Trigger outbox worker immediately in the background
      if (outboxWorker) {
        setImmediate(() => {
          outboxWorker.processPending().catch((err) => {
            console.error('[OrderApp] Background outbox dispatch error:', err);
          });
        });
      }

      res.status(201).json({
        success: true,
        order,
      });
    } catch (err: any) {
      next(err);
    }
  });

  // Get order by ID
  app.get('/orders/:id', (req: Request, res: Response, next: NextFunction): void => {
    try {
      const id = req.params.id as string;
      const order = db.getOrder(id);

      if (!order) {
        res.status(404).json({
          success: false,
          error: `Order with id "${id}" not found.`,
        });
        return;
      }

      res.status(200).json({
        success: true,
        order,
      });
    } catch (err) {
      next(err);
    }
  });

  // List orders
  app.get('/orders', (req: Request, res: Response, next: NextFunction): void => {
    try {
      const limit = parseInt(req.query.limit as string, 10) || 50;
      const orders = db.listOrders(Math.min(limit, 100));

      res.status(200).json({
        success: true,
        orders,
      });
    } catch (err) {
      next(err);
    }
  });

  // List inbox records
  app.get('/inbox', (req: Request, res: Response): void => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const inbox = db.listInbox(limit);
      res.status(200).json({ inbox });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // List outbox records
  app.get('/outbox', (req: Request, res: Response): void => {
    try {
      const status = req.query.status as any;
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const outbox = db.listOutbox(status, limit);
      res.status(200).json({ outbox });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Trigger outbox processing
  app.post('/outbox/process', async (_req: Request, res: Response): Promise<void> => {
    try {
      if (!outboxWorker) {
        res.status(400).json({ error: 'OutboxWorker not configured on this instance' });
        return;
      }
      const publishedCount = await outboxWorker.processPending();
      res.json({ success: true, publishedCount });
    } catch (err: any) {
      console.error('[OrderApp] Error processing outbox:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Global error handler
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[OrderApp] Internal server error:', err);
    res.status(500).json({
      success: false,
      error: err.message || 'Internal Server Error',
    });
  });

  return app;
}

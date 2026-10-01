import express, { Request, Response, Express } from 'express';
import { BankDatabase } from './db';
import { BankOutboxWorker } from './outboxWorker';
import { BankEventConsumer } from './eventConsumer';

export interface BankAppOptions {
  db: BankDatabase;
  outboxWorker?: BankOutboxWorker;
  eventConsumer?: BankEventConsumer;
}

export function createBankApp(options: BankAppOptions): Express {
  const { db, outboxWorker } = options;
  const app = express();

  app.use(express.json());

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'bank-service' });
  });

  // Create account
  app.post('/accounts', (req: Request, res: Response): void => {
    try {
      const { userId, initialBalance } = req.body;

      if (!userId || typeof userId !== 'string' || userId.trim() === '') {
        res.status(400).json({ error: 'userId is required and must be a non-empty string' });
        return;
      }

      const balance = initialBalance !== undefined ? Number(initialBalance) : 0;
      if (isNaN(balance) || balance < 0) {
        res.status(400).json({ error: 'initialBalance must be a non-negative number' });
        return;
      }

      const existing = db.getAccountByUserId(userId);
      if (existing) {
        res.status(409).json({ error: `Account already exists for user ${userId}`, account: existing });
        return;
      }

      const account = db.createAccount({ userId: userId.trim(), initialBalance: balance });
      res.status(201).json({ success: true, account });
    } catch (err: any) {
      console.error('[Bank API] Error creating account:', err);
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // List all accounts
  app.get('/accounts', (req: Request, res: Response): void => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const accounts = db.listAccounts(limit);
      res.json({ accounts });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get account by userId
  app.get('/accounts/:userId', (req: Request, res: Response): void => {
    try {
      const userId = (Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId) as string;
      const account = db.getAccountByUserId(userId);
      if (!account) {
        res.status(404).json({ error: `Account not found for user ${userId}` });
        return;
      }
      res.json({ account });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Deposit funds to account via /accounts/:userId/deposit
  app.post('/accounts/:userId/deposit', (req: Request, res: Response): void => {
    try {
      const userId = (Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId) as string;
      const { amount } = req.body;

      const numAmount = Number(amount);
      if (isNaN(numAmount) || numAmount <= 0) {
        res.status(400).json({ error: 'amount must be a number greater than 0' });
        return;
      }

      const account = db.getAccountByUserId(userId);
      if (!account) {
        res.status(404).json({ error: `Account not found for user ${userId}` });
        return;
      }

      const result = db.deposit(userId, numAmount);
      res.json({
        success: true,
        account: result.account,
        transaction: result.transaction,
      });
    } catch (err: any) {
      console.error('[Bank API] Error depositing:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Convenience deposit endpoint: POST /deposit { userId, amount }
  app.post('/deposit', (req: Request, res: Response): void => {
    try {
      const { userId, amount } = req.body;

      if (!userId || typeof userId !== 'string') {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const numAmount = Number(amount);
      if (isNaN(numAmount) || numAmount <= 0) {
        res.status(400).json({ error: 'amount must be a number greater than 0' });
        return;
      }

      const account = db.getAccountByUserId(userId);
      if (!account) {
        res.status(404).json({ error: `Account not found for user ${userId}` });
        return;
      }

      const result = db.deposit(userId, numAmount);
      res.json({
        success: true,
        account: result.account,
        transaction: result.transaction,
      });
    } catch (err: any) {
      console.error('[Bank API] Error depositing:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Get transactions for account by userId
  app.get('/accounts/:userId/transactions', (req: Request, res: Response): void => {
    try {
      const userId = (Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId) as string;
      const account = db.getAccountByUserId(userId);
      if (!account) {
        res.status(404).json({ error: `Account not found for user ${userId}` });
        return;
      }

      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const transactions = db.getTransactions(account.id, limit);
      res.json({ transactions });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // List all transactions
  app.get('/transactions', (req: Request, res: Response): void => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const transactions = db.listTransactions(limit);
      res.json({ transactions });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // List inbox records
  app.get('/inbox', (req: Request, res: Response): void => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const inbox = db.listInbox(limit);
      res.json({ inbox });
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
      res.json({ outbox });
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
      console.error('[Bank API] Error processing outbox:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}

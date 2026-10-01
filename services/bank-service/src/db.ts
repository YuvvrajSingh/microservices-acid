import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface AccountRecord {
  id: string;
  user_id: string;
  balance: number;
  created_at: string;
  updated_at: string;
}

export type TransactionType = 'DEPOSIT' | 'DEBIT';

export interface TransactionRecord {
  id: string;
  account_id: string;
  amount: number;
  type: TransactionType;
  created_at: string;
}

export type OutboxStatus = 'PENDING' | 'PUBLISHED' | 'FAILED';

export interface OutboxRow {
  id: string;
  topic: string;
  payload: string;
  status: OutboxStatus;
  created_at: string;
  processed_at?: string | null;
}

export interface InboxRow {
  event_id: string;
  processed_at: string;
}

export type DebitStatus = 'PAYMENT_SUCCEEDED' | 'PAYMENT_FAILED' | 'ALREADY_PROCESSED';

export interface DebitResult {
  status: DebitStatus;
  orderId: string;
  userId: string;
  amount: number;
  transactionId?: string;
  newBalance?: number;
  reason?: string;
}

export interface CreateAccountParams {
  id?: string;
  userId: string;
  initialBalance?: number;
}

export class BankDatabase {
  private db: Database.Database;

  constructor(dbPath: string = './bank.db') {
    this.db = new Database(dbPath);
    this.configurePragmas();
    this.initSchema();
  }

  private configurePragmas(): void {
    // Enable Write-Ahead Logging (WAL) for concurrent reads and writes with ACID durability
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        user_id TEXT UNIQUE NOT NULL,
        balance REAL NOT NULL DEFAULT 0.0 CHECK (balance >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        amount REAL NOT NULL CHECK (amount > 0),
        type TEXT NOT NULL CHECK (type IN ('DEPOSIT', 'DEBIT')),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS inbox (
        event_id TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED')),
        created_at TEXT NOT NULL,
        processed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at);
      CREATE INDEX IF NOT EXISTS idx_outbox_status_created ON outbox(status, created_at);
    `);
  }

  /**
   * Creates a new bank account with optional initial deposit.
   */
  public createAccount(params: CreateAccountParams): AccountRecord {
    const { userId, initialBalance = 0 } = params;
    if (initialBalance < 0) {
      throw new Error(`Initial balance cannot be negative: ${initialBalance}`);
    }

    const accountId = params.id || randomUUID();
    const now = new Date().toISOString();

    const insertAccountStmt = this.db.prepare(`
      INSERT INTO accounts (id, user_id, balance, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    const insertTxStmt = this.db.prepare(`
      INSERT INTO transactions (id, account_id, amount, type, created_at)
      VALUES (?, ?, ?, 'DEPOSIT', ?)
    `);

    const tx = this.db.transaction(() => {
      insertAccountStmt.run(accountId, userId, initialBalance, now, now);
      if (initialBalance > 0) {
        insertTxStmt.run(randomUUID(), accountId, initialBalance, now);
      }
    });

    tx();

    return {
      id: accountId,
      user_id: userId,
      balance: initialBalance,
      created_at: now,
      updated_at: now,
    };
  }

  /**
   * Retrieves an account by unique user ID.
   */
  public getAccountByUserId(userId: string): AccountRecord | null {
    const stmt = this.db.prepare(`
      SELECT id, user_id, balance, created_at, updated_at
      FROM accounts
      WHERE user_id = ?
    `);
    const row = stmt.get(userId) as AccountRecord | undefined;
    return row || null;
  }

  /**
   * Retrieves an account by its primary key ID.
   */
  public getAccountById(id: string): AccountRecord | null {
    const stmt = this.db.prepare(`
      SELECT id, user_id, balance, created_at, updated_at
      FROM accounts
      WHERE id = ?
    `);
    const row = stmt.get(id) as AccountRecord | undefined;
    return row || null;
  }

  /**
   * Lists all accounts ordered by created_at DESC.
   */
  public listAccounts(limit: number = 50): AccountRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, user_id, balance, created_at, updated_at
      FROM accounts
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return stmt.all(limit) as AccountRecord[];
  }

  /**
   * Deposits funds into an account atomically.
   */
  public deposit(userId: string, amount: number): { account: AccountRecord; transaction: TransactionRecord } {
    if (amount <= 0) {
      throw new Error(`Deposit amount must be greater than zero: ${amount}`);
    }

    const now = new Date().toISOString();
    const txId = randomUUID();

    const getAccountStmt = this.db.prepare(`SELECT * FROM accounts WHERE user_id = ?`);
    const updateAccountStmt = this.db.prepare(`
      UPDATE accounts
      SET balance = balance + ?, updated_at = ?
      WHERE id = ?
    `);
    const insertTxStmt = this.db.prepare(`
      INSERT INTO transactions (id, account_id, amount, type, created_at)
      VALUES (?, ?, ?, 'DEPOSIT', ?)
    `);

    let updatedAccount: AccountRecord | null = null;
    let txRecord: TransactionRecord | null = null;

    const tx = this.db.transaction(() => {
      const account = getAccountStmt.get(userId) as AccountRecord | undefined;
      if (!account) {
        throw new Error(`Account not found for user: ${userId}`);
      }

      updateAccountStmt.run(amount, now, account.id);
      insertTxStmt.run(txId, account.id, amount, now);

      updatedAccount = {
        ...account,
        balance: account.balance + amount,
        updated_at: now,
      };

      txRecord = {
        id: txId,
        account_id: account.id,
        amount,
        type: 'DEPOSIT',
        created_at: now,
      };
    });

    tx();

    return { account: updatedAccount!, transaction: txRecord! };
  }

  /**
   * Retrieves transaction ledger history for an account.
   */
  public getTransactions(accountId: string, limit: number = 50): TransactionRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, account_id, amount, type, created_at
      FROM transactions
      WHERE account_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return stmt.all(accountId, limit) as TransactionRecord[];
  }

  /**
   * Lists all transactions across accounts.
   */
  public listTransactions(limit: number = 50): TransactionRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, account_id, amount, type, created_at
      FROM transactions
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return stmt.all(limit) as TransactionRecord[];
  }

  /**
   * Checks whether an event has been processed (Inbox idempotency check).
   */
  public isEventProcessed(eventId: string): boolean {
    const stmt = this.db.prepare(`SELECT 1 FROM inbox WHERE event_id = ?`);
    return !!stmt.get(eventId);
  }

  /**
   * Lists inbox records.
   */
  public listInbox(limit: number = 50): InboxRow[] {
    const stmt = this.db.prepare(`
      SELECT event_id, processed_at
      FROM inbox
      ORDER BY processed_at DESC
      LIMIT ?
    `);
    return stmt.all(limit) as InboxRow[];
  }

  /**
   * Retrieves pending outbox events for publishing.
   */
  public getPendingOutbox(limit: number = 50): OutboxRow[] {
    const stmt = this.db.prepare(`
      SELECT id, topic, payload, status, created_at, processed_at
      FROM outbox
      WHERE status = 'PENDING'
      ORDER BY created_at ASC
      LIMIT ?
    `);
    return stmt.all(limit) as OutboxRow[];
  }

  /**
   * Lists outbox records with optional status filter.
   */
  public listOutbox(status?: OutboxStatus, limit: number = 50): OutboxRow[] {
    if (status) {
      const stmt = this.db.prepare(`
        SELECT id, topic, payload, status, created_at, processed_at
        FROM outbox
        WHERE status = ?
        ORDER BY created_at DESC
        LIMIT ?
      `);
      return stmt.all(status, limit) as OutboxRow[];
    }
    const stmt = this.db.prepare(`
      SELECT id, topic, payload, status, created_at, processed_at
      FROM outbox
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return stmt.all(limit) as OutboxRow[];
  }

  /**
   * Marks an outbox message as PUBLISHED.
   */
  public markOutboxPublished(id: string, processedAt?: string): void {
    const now = processedAt || new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE outbox
      SET status = 'PUBLISHED', processed_at = ?
      WHERE id = ?
    `);
    stmt.run(now, id);
  }

  /**
   * Marks an outbox message as FAILED.
   */
  public markOutboxFailed(id: string): void {
    const stmt = this.db.prepare(`
      UPDATE outbox
      SET status = 'FAILED'
      WHERE id = ?
    `);
    stmt.run(id);
  }

  /**
   * Local ACID Transaction:
   * Debits an account checking inbox for idempotency, verifies balance, inserts
   * transaction log, records outbox event ('payment.succeeded' or 'payment.failed'),
   * and marks inbox, all inside a single database transaction.
   */
  public debitAccountTx(
    eventId: string,
    orderId: string,
    userId: string,
    amount: number
  ): DebitResult {
    const now = new Date().toISOString();

    const checkInboxStmt = this.db.prepare(`SELECT 1 FROM inbox WHERE event_id = ?`);
    const insertInboxStmt = this.db.prepare(`INSERT OR IGNORE INTO inbox (event_id, processed_at) VALUES (?, ?)`);
    const getAccountStmt = this.db.prepare(`SELECT * FROM accounts WHERE user_id = ?`);
    const updateBalanceStmt = this.db.prepare(`
      UPDATE accounts
      SET balance = balance - ?, updated_at = ?
      WHERE id = ?
    `);
    const insertTxStmt = this.db.prepare(`
      INSERT INTO transactions (id, account_id, amount, type, created_at)
      VALUES (?, ?, ?, 'DEBIT', ?)
    `);
    const insertOutboxStmt = this.db.prepare(`
      INSERT INTO outbox (id, topic, payload, status, created_at)
      VALUES (?, ?, ?, 'PENDING', ?)
    `);

    let result: DebitResult;

    const markInbox = () => {
      insertInboxStmt.run(eventId, now);
      if (orderId && orderId !== 'unknown_order' && orderId !== eventId) {
        insertInboxStmt.run(orderId, now);
      }
    };

    const tx = this.db.transaction(() => {
      // 1. Idempotency check: verify if this event or order was already processed
      const alreadyProcessed =
        checkInboxStmt.get(eventId) ||
        (orderId && orderId !== 'unknown_order' ? checkInboxStmt.get(orderId) : null);

      if (alreadyProcessed) {
        result = {
          status: 'ALREADY_PROCESSED',
          orderId,
          userId,
          amount,
        };
        return;
      }

      // 2. Fetch target account
      const account = getAccountStmt.get(userId) as AccountRecord | undefined;

      // Case A: Account does not exist
      if (!account) {
        const outboxId = randomUUID();
        const payload = JSON.stringify({
          orderId,
          order_id: orderId,
          userId,
          user_id: userId,
          amount,
          reason: `Account not found for user: ${userId}`,
          failedAt: now,
        });

        // Atomic: Record failure in outbox and mark inbox to preserve idempotency
        insertOutboxStmt.run(outboxId, 'payment.failed', payload, now);
        markInbox();

        result = {
          status: 'PAYMENT_FAILED',
          orderId,
          userId,
          amount,
          reason: `Account not found for user: ${userId}`,
        };
        return;
      }

      // Case B: Insufficient balance
      if (account.balance < amount) {
        const outboxId = randomUUID();
        const payload = JSON.stringify({
          orderId,
          order_id: orderId,
          userId,
          user_id: userId,
          amount,
          currentBalance: account.balance,
          reason: `Insufficient balance: required ${amount}, available ${account.balance}`,
          failedAt: now,
        });

        // Atomic: Record failure in outbox and mark inbox to preserve idempotency
        insertOutboxStmt.run(outboxId, 'payment.failed', payload, now);
        markInbox();

        result = {
          status: 'PAYMENT_FAILED',
          orderId,
          userId,
          amount,
          reason: `Insufficient balance: required ${amount}, available ${account.balance}`,
        };
        return;
      }

      // Case C: Sufficient balance -> Debit account
      // CHECK (balance >= 0) constraint guarantees consistency at the SQLite engine level
      const txId = randomUUID();
      const outboxId = randomUUID();
      const newBalance = account.balance - amount;

      // 1. Debit account balance
      updateBalanceStmt.run(amount, now, account.id);

      // 2. Record ledger transaction
      insertTxStmt.run(txId, account.id, amount, now);

      // 3. Record outbox event payment.succeeded
      const payload = JSON.stringify({
        orderId,
        order_id: orderId,
        userId,
        user_id: userId,
        amount,
        accountId: account.id,
        transactionId: txId,
        remainingBalance: newBalance,
        processedAt: now,
      });
      insertOutboxStmt.run(outboxId, 'payment.succeeded', payload, now);

      // 4. Mark inbox to guarantee idempotency
      markInbox();

      result = {
        status: 'PAYMENT_SUCCEEDED',
        orderId,
        userId,
        amount,
        transactionId: txId,
        newBalance,
      };
    });

    tx();

    return result!;
  }

  /**
   * Closes the database connection.
   */
  public close(): void {
    if (this.db.open) {
      this.db.close();
    }
  }

  /**
   * Access raw better-sqlite3 database instance.
   */
  public getRawDb(): Database.Database {
    return this.db;
  }
}

export function createBankDatabase(dbPath?: string): BankDatabase {
  return new BankDatabase(dbPath);
}

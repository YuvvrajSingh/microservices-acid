import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export type OrderStatus = 'PENDING' | 'COMPLETED' | 'CANCELLED';

export interface OrderRecord {
  id: string;
  user_id: string;
  amount: number;
  status: OrderStatus;
  created_at: string;
  updated_at: string;
}

export interface OutboxRow {
  id: string;
  topic: string;
  payload: string;
  status: 'PENDING' | 'PUBLISHED' | 'FAILED';
  created_at: string;
  processed_at?: string | null;
}

export interface InboxRow {
  event_id: string;
  processed_at: string;
}

export interface CreateOrderParams {
  id?: string;
  userId: string;
  amount: number;
  currency?: string;
}

export class OrderDatabase {
  private db: Database.Database;

  constructor(dbPath: string = './order.db') {
    this.db = new Database(dbPath);
    this.configurePragmas();
    this.initSchema();
  }

  private configurePragmas(): void {
    // Enable Write-Ahead Logging (WAL) for concurrent reads and writes with durability
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        amount REAL NOT NULL CHECK (amount > 0),
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'CANCELLED')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED')),
        created_at TEXT NOT NULL,
        processed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS inbox (
        event_id TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_outbox_status_created ON outbox(status, created_at);
    `);
  }

  /**
   * Local ACID Transaction:
   * Inserts into `orders` (status: PENDING) and inserts into `outbox` (topic: 'order.created')
   * inside a single database transaction. If either fails, the entire transaction rolls back.
   */
  public createOrderWithOutbox(params: CreateOrderParams): OrderRecord {
    const { userId, amount, currency = 'USD' } = params;
    const orderId = params.id || randomUUID();
    const outboxId = randomUUID();
    const now = new Date().toISOString();

    const insertOrderStmt = this.db.prepare(`
      INSERT INTO orders (id, user_id, amount, status, created_at, updated_at)
      VALUES (?, ?, ?, 'PENDING', ?, ?)
    `);

    const insertOutboxStmt = this.db.prepare(`
      INSERT INTO outbox (id, topic, payload, status, created_at)
      VALUES (?, 'order.created', ?, 'PENDING', ?)
    `);

    const payload = JSON.stringify({
      orderId,
      order_id: orderId,
      userId,
      user_id: userId,
      amount,
      currency,
      status: 'PENDING',
      createdAt: now
    });

    // Execute both inside an ACID transaction
    const transaction = this.db.transaction(() => {
      insertOrderStmt.run(orderId, userId, amount, now, now);
      insertOutboxStmt.run(outboxId, payload, now);
    });

    transaction();

    return {
      id: orderId,
      user_id: userId,
      amount,
      status: 'PENDING',
      created_at: now,
      updated_at: now,
    };
  }

  /**
   * Retrieves an order by its ID.
   */
  public getOrder(id: string): OrderRecord | null {
    const stmt = this.db.prepare(`
      SELECT id, user_id, amount, status, created_at, updated_at
      FROM orders
      WHERE id = ?
    `);
    const row = stmt.get(id) as OrderRecord | undefined;
    return row || null;
  }

  /**
   * Lists orders ordered by created_at DESC.
   */
  public listOrders(limit: number = 50): OrderRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, user_id, amount, status, created_at, updated_at
      FROM orders
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return stmt.all(limit) as OrderRecord[];
  }

  /**
   * Retrieves pending outbox messages in chronological order.
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
  public listOutbox(status?: 'PENDING' | 'PUBLISHED' | 'FAILED', limit: number = 50): OutboxRow[] {
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
   * Marks an outbox record as PUBLISHED.
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
   * Marks an outbox record as FAILED.
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
   * Checks if an event has already been processed (idempotency check).
   */
  public isEventProcessed(eventId: string): boolean {
    const stmt = this.db.prepare(`
      SELECT 1 FROM inbox WHERE event_id = ?
    `);
    return !!stmt.get(eventId);
  }

  /**
   * Local ACID Transaction:
   * Handles payment success event. Idempotently marks event in inbox and updates
   * order status to COMPLETED within a single database transaction.
   * Returns true if status was updated, false if event was already processed.
   */
  public completeOrder(orderId: string, eventId: string): boolean {
    const now = new Date().toISOString();

    const checkInboxStmt = this.db.prepare(`
      SELECT 1 FROM inbox WHERE event_id = ?
    `);
    const insertInboxStmt = this.db.prepare(`
      INSERT INTO inbox (event_id, processed_at) VALUES (?, ?)
    `);
    const updateOrderStmt = this.db.prepare(`
      UPDATE orders
      SET status = 'COMPLETED', updated_at = ?
      WHERE id = ? AND status = 'PENDING'
    `);

    let updated = false;

    const transaction = this.db.transaction(() => {
      const alreadyProcessed = checkInboxStmt.get(eventId);
      if (alreadyProcessed) {
        return;
      }

      insertInboxStmt.run(eventId, now);
      const result = updateOrderStmt.run(now, orderId);
      updated = result.changes > 0;
    });

    transaction();
    return updated;
  }

  /**
   * Local ACID Transaction:
   * Handles payment failed event (Saga compensation). Idempotently marks event in inbox
   * and updates order status to CANCELLED within a single database transaction.
   * Returns true if status was updated, false if event was already processed.
   */
  public cancelOrder(orderId: string, eventId: string): boolean {
    const now = new Date().toISOString();

    const checkInboxStmt = this.db.prepare(`
      SELECT 1 FROM inbox WHERE event_id = ?
    `);
    const insertInboxStmt = this.db.prepare(`
      INSERT INTO inbox (event_id, processed_at) VALUES (?, ?)
    `);
    const updateOrderStmt = this.db.prepare(`
      UPDATE orders
      SET status = 'CANCELLED', updated_at = ?
      WHERE id = ? AND status = 'PENDING'
    `);

    let updated = false;

    const transaction = this.db.transaction(() => {
      const alreadyProcessed = checkInboxStmt.get(eventId);
      if (alreadyProcessed) {
        return;
      }

      insertInboxStmt.run(eventId, now);
      const result = updateOrderStmt.run(now, orderId);
      updated = result.changes > 0;
    });

    transaction();
    return updated;
  }

  /**
   * Closes the database connection cleanly.
   */
  public close(): void {
    if (this.db.open) {
      this.db.close();
    }
  }

  /**
   * Returns underlying better-sqlite3 database instance.
   */
  public getRawDb(): Database.Database {
    return this.db;
  }
}

export function createOrderDatabase(dbPath?: string): OrderDatabase {
  return new OrderDatabase(dbPath);
}

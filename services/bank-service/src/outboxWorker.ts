import { BankDatabase, OutboxRow } from './db';
import { EventBus, eventBus as defaultEventBus } from '../../../shared/eventBus';

export interface OutboxWorkerOptions {
  pollIntervalMs?: number;
  batchSize?: number;
}

export class BankOutboxWorker {
  private db: BankDatabase;
  private eventBus: EventBus;
  private pollIntervalMs: number;
  private batchSize: number;
  private timer: NodeJS.Timeout | null = null;
  private isProcessing: boolean = false;

  constructor(
    db: BankDatabase,
    bus: EventBus = defaultEventBus,
    options: OutboxWorkerOptions = {}
  ) {
    this.db = db;
    this.eventBus = bus;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.batchSize = options.batchSize ?? 50;
  }

  /**
   * Processes all pending outbox records and publishes them to the event bus.
   * Returns the count of published events.
   */
  public async processPending(): Promise<number> {
    if (this.isProcessing) {
      return 0;
    }

    this.isProcessing = true;
    let publishedCount = 0;

    try {
      const pendingRows: OutboxRow[] = this.db.getPendingOutbox(this.batchSize);

      for (const row of pendingRows) {
        try {
          let parsedPayload: any;
          try {
            parsedPayload = JSON.parse(row.payload);
          } catch {
            parsedPayload = row.payload;
          }

          const aggregateId =
            parsedPayload?.orderId ||
            parsedPayload?.order_id ||
            parsedPayload?.userId ||
            parsedPayload?.user_id ||
            row.id;

          // Dispatch to event bus
          await this.eventBus.publish({
            id: row.id,
            topic: row.topic,
            aggregateId,
            aggregateType: 'Payment',
            payload: parsedPayload,
            occurredAt: row.created_at,
          });

          // Mark outbox record as PUBLISHED
          this.db.markOutboxPublished(row.id);
          publishedCount++;
        } catch (dispatchError) {
          console.error(`[BankOutboxWorker] Failed to publish event ${row.id}:`, dispatchError);
          this.db.markOutboxFailed(row.id);
        }
      }
    } finally {
      this.isProcessing = false;
    }

    return publishedCount;
  }

  /**
   * Starts periodic polling worker for background event publishing.
   */
  public start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(async () => {
      try {
        await this.processPending();
      } catch (err) {
        console.error('[BankOutboxWorker] Polling loop error:', err);
      }
    }, this.pollIntervalMs);

    // Ensure timer does not prevent process exit
    this.timer.unref();
  }

  /**
   * Stops the background worker timer.
   */
  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Triggers an immediate execution cycle.
   */
  public async trigger(): Promise<number> {
    return this.processPending();
  }

  /**
   * Alias for processPending to support batch execution conventions.
   */
  public async processOutboxBatch(): Promise<number> {
    return this.processPending();
  }
}

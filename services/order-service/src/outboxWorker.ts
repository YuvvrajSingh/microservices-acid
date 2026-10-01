import { OrderDatabase, OutboxRow } from './db';
import { EventBus, eventBus as defaultEventBus } from '../../../shared/eventBus';

export interface OutboxWorkerOptions {
  pollIntervalMs?: number;
  batchSize?: number;
}

export class OrderOutboxWorker {
  private db: OrderDatabase;
  private eventBus: EventBus;
  private pollIntervalMs: number;
  private batchSize: number;
  private timer: NodeJS.Timeout | null = null;
  private isProcessing: boolean = false;

  constructor(
    db: OrderDatabase,
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
   * Returns the number of events published.
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

          const aggregateId = parsedPayload?.orderId || parsedPayload?.order_id || row.id;

          // Dispatch to event bus
          await this.eventBus.publish({
            id: row.id,
            topic: row.topic,
            aggregateId,
            aggregateType: 'Order',
            payload: parsedPayload,
            occurredAt: row.created_at,
          });

          // Mark outbox row as published upon successful dispatch
          this.db.markOutboxPublished(row.id);
          publishedCount++;
        } catch (dispatchError) {
          console.error(`[OrderOutboxWorker] Failed to publish event ${row.id}:`, dispatchError);
          // Keep as pending or update retry count, or mark failed if needed
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
        console.error('[OrderOutboxWorker] Polling loop error:', err);
      }
    }, this.pollIntervalMs);

    // Ensure timer does not prevent process exit in node
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
}

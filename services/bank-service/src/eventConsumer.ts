import { BankDatabase, DebitResult } from './db';
import { BankOutboxWorker } from './outboxWorker';
import { EventBus, eventBus as defaultEventBus, Unsubscribe } from '../../../shared/eventBus';
import { DomainEvent } from '../../../shared/types';

export class BankEventConsumer {
  private db: BankDatabase;
  private eventBus: EventBus;
  private outboxWorker?: BankOutboxWorker;
  private unsubscribers: Unsubscribe[] = [];
  private isRunning: boolean = false;

  constructor(
    db: BankDatabase,
    bus: EventBus = defaultEventBus,
    outboxWorker?: BankOutboxWorker
  ) {
    this.db = db;
    this.eventBus = bus;
    this.outboxWorker = outboxWorker;
  }

  /**
   * Registers event bus subscriptions for order creation events.
   */
  public start(): void {
    if (this.isRunning) {
      return;
    }

    // Subscribe to order.created
    const unsub = this.eventBus.subscribe('order.created', async (event: DomainEvent<any>) => {
      await this.handleOrderCreated(event);
    });
    this.unsubscribers.push(unsub);

    this.isRunning = true;
  }

  /**
   * Unregisters all event bus subscriptions.
   */
  public stop(): void {
    for (const unsub of this.unsubscribers) {
      try {
        unsub();
      } catch (err) {
        console.error('[BankEventConsumer] Error unsubscribing:', err);
      }
    }
    this.unsubscribers = [];
    this.isRunning = false;
  }

  /**
   * Handles order.created event:
   * Triggers local ACID debit transaction.
   * If an OutboxWorker is configured, immediately triggers outbox dispatch.
   */
  public async handleOrderCreated(event: any): Promise<DebitResult> {
    const payload = event?.payload || event || {};
    const orderId = payload.orderId || payload.order_id || event?.aggregateId || 'unknown_order';
    const eventId =
      event?.id ||
      payload.eventId ||
      payload.id ||
      orderId;
    const userId = payload.userId || payload.user_id || payload.customerId;
    const amount = Number(payload.amount);

    if (!userId || isNaN(amount) || amount <= 0) {
      console.warn(`[BankEventConsumer] Invalid order.created payload for event ${eventId}:`, payload);
      // Still execute debitAccountTx with invalid or missing params so outbox records payment.failed
      const result = this.db.debitAccountTx(eventId, orderId, userId || 'unknown_user', isNaN(amount) ? 0 : amount);
      if (this.outboxWorker) {
        await this.outboxWorker.trigger();
      }
      return result;
    }

    const result = this.db.debitAccountTx(eventId, orderId, userId, amount);

    if (result.status === 'PAYMENT_SUCCEEDED') {
      console.log(`[BankEventConsumer] Payment succeeded for order ${orderId} (user: ${userId}, amount: ${amount})`);
    } else if (result.status === 'PAYMENT_FAILED') {
      console.log(`[BankEventConsumer] Payment failed for order ${orderId}: ${result.reason}`);
    } else if (result.status === 'ALREADY_PROCESSED') {
      console.log(`[BankEventConsumer] Duplicate order.created event ignored for order ${orderId} (event: ${eventId})`);
    }

    // Immediately trigger outbox worker if provided to dispatch payment.succeeded / payment.failed
    if (this.outboxWorker && result.status !== 'ALREADY_PROCESSED') {
      await this.outboxWorker.trigger();
    }

    return result;
  }
}

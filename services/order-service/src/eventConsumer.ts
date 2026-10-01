import { OrderDatabase } from './db';
import { EventBus, eventBus as defaultEventBus, Unsubscribe } from '../../../shared/eventBus';
import { DomainEvent } from '../../../shared/types';

export class OrderEventConsumer {
  private db: OrderDatabase;
  private eventBus: EventBus;
  private unsubscribers: Unsubscribe[] = [];
  private isRunning: boolean = false;

  constructor(db: OrderDatabase, bus: EventBus = defaultEventBus) {
    this.db = db;
    this.eventBus = bus;
  }

  /**
   * Registers event bus subscriptions for payment events.
   */
  public start(): void {
    if (this.isRunning) {
      return;
    }

    // 1. Listen for payment.succeeded
    const unsubSuccess = this.eventBus.subscribe('payment.succeeded', async (event: DomainEvent<any>) => {
      await this.handlePaymentSucceeded(event);
    });
    this.unsubscribers.push(unsubSuccess);

    // 2. Listen for payment.failed
    const unsubFailed = this.eventBus.subscribe('payment.failed', async (event: DomainEvent<any>) => {
      await this.handlePaymentFailed(event);
    });
    this.unsubscribers.push(unsubFailed);

    // 3. Listen for payment.processed (compatibility with shared types)
    const unsubProcessed = this.eventBus.subscribe('payment.processed', async (event: DomainEvent<any>) => {
      await this.handlePaymentProcessed(event);
    });
    this.unsubscribers.push(unsubProcessed);

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
        console.error('[OrderEventConsumer] Error unsubscribing:', err);
      }
    }
    this.unsubscribers = [];
    this.isRunning = false;
  }

  /**
   * Handles payment.succeeded event:
   * Transitions order from PENDING to COMPLETED idempotently.
   */
  public async handlePaymentSucceeded(event: DomainEvent<any>): Promise<boolean> {
    const payload = event.payload || {};
    const orderId = payload.orderId || payload.order_id || event.aggregateId;

    if (!orderId) {
      console.warn('[OrderEventConsumer] Received payment.succeeded event without orderId:', event);
      return false;
    }

    const updated = this.db.completeOrder(orderId, event.id);
    if (updated) {
      console.log(`[OrderEventConsumer] Order ${orderId} marked COMPLETED (event: ${event.id})`);
    } else {
      console.log(`[OrderEventConsumer] Duplicate or non-pending payment.succeeded ignored for order ${orderId} (event: ${event.id})`);
    }

    return updated;
  }

  /**
   * Handles payment.failed event (Saga compensation):
   * Transitions order from PENDING to CANCELLED idempotently.
   */
  public async handlePaymentFailed(event: DomainEvent<any>): Promise<boolean> {
    const payload = event.payload || {};
    const orderId = payload.orderId || payload.order_id || event.aggregateId;

    if (!orderId) {
      console.warn('[OrderEventConsumer] Received payment.failed event without orderId:', event);
      return false;
    }

    const updated = this.db.cancelOrder(orderId, event.id);
    if (updated) {
      console.log(`[OrderEventConsumer] Order ${orderId} marked CANCELLED [Compensated] (event: ${event.id})`);
    } else {
      console.log(`[OrderEventConsumer] Duplicate or non-pending payment.failed ignored for order ${orderId} (event: ${event.id})`);
    }

    return updated;
  }

  /**
   * Handles generic payment.processed event (from shared/types.ts).
   */
  private async handlePaymentProcessed(event: DomainEvent<any>): Promise<void> {
    const payload = event.payload || {};
    const status = payload.status;

    if (status === 'SUCCESS' || status === 'COMPLETED' || !status) {
      await this.handlePaymentSucceeded(event);
    } else if (status === 'FAILED') {
      await this.handlePaymentFailed(event);
    }
  }
}

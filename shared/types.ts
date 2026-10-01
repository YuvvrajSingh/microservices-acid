/**
 * Domain models and event definitions for transactional microservices
 * adhering to Outbox/Inbox patterns.
 */

// ---------------------------------------------------------------------------
// Order Domain Types
// ---------------------------------------------------------------------------

export const OrderStatus = {
  PENDING: 'PENDING',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const;

export type OrderStatus = typeof OrderStatus[keyof typeof OrderStatus];

export interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Payment Domain Types
// ---------------------------------------------------------------------------

export const PaymentStatus = {
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
} as const;

export type PaymentStatus = typeof PaymentStatus[keyof typeof PaymentStatus];

export interface Payment {
  id: string;
  orderId: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  failureReason?: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Event Topics & Base Event Definitions
// ---------------------------------------------------------------------------

export const EventTopics = {
  ORDER_CREATED: 'order.created',
  PAYMENT_PROCESSED: 'payment.processed',
  PAYMENT_FAILED: 'payment.failed',
} as const;

export type EventTopic = typeof EventTopics[keyof typeof EventTopics] | string;

export interface DomainEvent<TPayload = unknown> {
  id: string;              // Unique event ID (UUID v4)
  topic: string;           // Routing topic (e.g., 'order.created')
  aggregateId: string;     // ID of entity emitting event (e.g. orderId)
  aggregateType: string;   // Aggregate entity type (e.g. 'Order', 'Payment')
  payload: TPayload;
  occurredAt: string;      // ISO 8601 timestamp
}

// ---------------------------------------------------------------------------
// Specific Domain Events
// ---------------------------------------------------------------------------

export interface OrderCreatedPayload {
  orderId: string;
  customerId: string;
  amount: number;
  currency: string;
  createdAt: string;
}

export interface OrderCreatedEvent extends DomainEvent<OrderCreatedPayload> {
  topic: typeof EventTopics.ORDER_CREATED;
  aggregateType: 'Order';
}

export interface PaymentProcessedPayload {
  paymentId: string;
  orderId: string;
  amount: number;
  currency: string;
  transactionRef: string;
  processedAt: string;
}

export interface PaymentProcessedEvent extends DomainEvent<PaymentProcessedPayload> {
  topic: typeof EventTopics.PAYMENT_PROCESSED;
  aggregateType: 'Payment';
}

export interface PaymentFailedPayload {
  paymentId: string;
  orderId: string;
  amount: number;
  currency: string;
  reason: string;
  failedAt: string;
}

export interface PaymentFailedEvent extends DomainEvent<PaymentFailedPayload> {
  topic: typeof EventTopics.PAYMENT_FAILED;
  aggregateType: 'Payment';
}

export type AppEvent = OrderCreatedEvent | PaymentProcessedEvent | PaymentFailedEvent;

// ---------------------------------------------------------------------------
// Transactional Outbox Pattern
// ---------------------------------------------------------------------------

export const OutboxStatus = {
  PENDING: 'PENDING',
  PUBLISHED: 'PUBLISHED',
  FAILED: 'FAILED',
} as const;

export type OutboxStatus = typeof OutboxStatus[keyof typeof OutboxStatus];

export interface OutboxRecord {
  id: string;              // UUID
  aggregateType: string;   // Aggregate entity name ('Order', 'Payment')
  aggregateId: string;     // Aggregate root ID
  eventType: string;       // Event topic ('order.created', etc.)
  payload: string;         // Serialized JSON event payload
  status: OutboxStatus;    // 'PENDING' | 'PUBLISHED' | 'FAILED'
  retryCount: number;      // Dispatch retry attempts
  createdAt: string;       // ISO 8601 timestamp
  processedAt?: string | null;
  lastError?: string | null;
}

// ---------------------------------------------------------------------------
// Transactional Inbox Pattern (Idempotent Consumer)
// ---------------------------------------------------------------------------

export const InboxStatus = {
  RECEIVED: 'RECEIVED',
  PROCESSED: 'PROCESSED',
  FAILED: 'FAILED',
} as const;

export type InboxStatus = typeof InboxStatus[keyof typeof InboxStatus];

export interface InboxRecord {
  id: string;              // Event ID used as deduplication/idempotency key
  eventType: string;       // Topic/event type name
  payload: string;         // Serialized JSON event payload
  status: InboxStatus;     // 'RECEIVED' | 'PROCESSED' | 'FAILED'
  receivedAt: string;      // ISO 8601 timestamp
  processedAt?: string | null;
  lastError?: string | null;
}

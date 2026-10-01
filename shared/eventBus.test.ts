import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryEventBus } from './eventBus';
import { DomainEvent, EventTopics, OrderCreatedEvent } from './types';

test('EventBus publishes to exact topic subscriber', async () => {
  const bus = new InMemoryEventBus();
  const received: DomainEvent[] = [];

  bus.subscribe('order.created', async (evt) => {
    received.push(evt);
  });

  const event: OrderCreatedEvent = {
    id: 'evt-1',
    topic: EventTopics.ORDER_CREATED,
    aggregateId: 'order-123',
    aggregateType: 'Order',
    occurredAt: new Date().toISOString(),
    payload: {
      orderId: 'order-123',
      customerId: 'cust-456',
      amount: 99.99,
      currency: 'USD',
      createdAt: new Date().toISOString(),
    },
  };

  await bus.publish(event);

  assert.equal(received.length, 1);
  assert.equal(received[0].id, 'evt-1');
  assert.equal(received[0].aggregateId, 'order-123');
});

test('EventBus handles wildcard topic subscriptions (e.g. order.*)', async () => {
  const bus = new InMemoryEventBus();
  const received: string[] = [];

  bus.subscribe('order.*', (evt) => {
    received.push(evt.topic);
  });

  await bus.publish({
    id: '1',
    topic: 'order.created',
    aggregateId: 'order-1',
    aggregateType: 'Order',
    occurredAt: new Date().toISOString(),
    payload: {},
  });

  await bus.publish({
    id: '2',
    topic: 'order.cancelled',
    aggregateId: 'order-2',
    aggregateType: 'Order',
    occurredAt: new Date().toISOString(),
    payload: {},
  });

  await bus.publish({
    id: '3',
    topic: 'payment.processed',
    aggregateId: 'pay-1',
    aggregateType: 'Payment',
    occurredAt: new Date().toISOString(),
    payload: {},
  });

  assert.deepEqual(received, ['order.created', 'order.cancelled']);
});

test('EventBus handles subscribeAll and unsubscription', async () => {
  const bus = new InMemoryEventBus();
  let count = 0;

  const unsubscribe = bus.subscribeAll(() => {
    count++;
  });

  await bus.publish({
    id: '1',
    topic: 'order.created',
    aggregateId: 'order-1',
    aggregateType: 'Order',
    occurredAt: new Date().toISOString(),
    payload: {},
  });

  assert.equal(count, 1);

  unsubscribe();

  await bus.publish({
    id: '2',
    topic: 'payment.processed',
    aggregateId: 'pay-1',
    aggregateType: 'Payment',
    occurredAt: new Date().toISOString(),
    payload: {},
  });

  assert.equal(count, 1);
});

test('EventBus isolates subscriber errors and allows other handlers to finish', async () => {
  const errorsCaptured: string[] = [];
  const bus = new InMemoryEventBus({
    onError: (err, event) => {
      errorsCaptured.push((err as Error).message);
    },
  });

  let handler2Ran = false;

  bus.subscribe('order.created', async () => {
    throw new Error('Subscriber failure');
  });

  bus.subscribe('order.created', async () => {
    handler2Ran = true;
  });

  await bus.publish({
    id: '1',
    topic: 'order.created',
    aggregateId: 'order-1',
    aggregateType: 'Order',
    occurredAt: new Date().toISOString(),
    payload: {},
  });

  assert.equal(handler2Ran, true);
  assert.equal(errorsCaptured.length, 1);
  assert.equal(errorsCaptured[0], 'Subscriber failure');
});

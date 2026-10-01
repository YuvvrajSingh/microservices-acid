import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { createOrderDatabase, OrderDatabase } from '../src/db';
import { OrderOutboxWorker } from '../src/outboxWorker';
import { OrderEventConsumer } from '../src/eventConsumer';
import { createOrderApp } from '../src/app';
import { InMemoryEventBus } from '../../../shared/eventBus';
import { DomainEvent } from '../../../shared/types';

describe('Order Service - Transactional Outbox & ACID Guarantees', () => {
  const testDbPath = path.resolve(__dirname, './test-order.db');
  let db: OrderDatabase;
  let eventBus: InMemoryEventBus;
  let outboxWorker: OrderOutboxWorker;
  let consumer: OrderEventConsumer;

  const cleanupDbFiles = () => {
    for (const suffix of ['', '-wal', '-shm']) {
      const file = testDbPath + suffix;
      if (fs.existsSync(file)) {
        try {
          fs.unlinkSync(file);
        } catch {
          // ignore cleanup errors
        }
      }
    }
  };

  beforeEach(() => {
    cleanupDbFiles();
    db = createOrderDatabase(testDbPath);
    eventBus = new InMemoryEventBus();
    outboxWorker = new OrderOutboxWorker(db, eventBus);
    consumer = new OrderEventConsumer(db, eventBus);
    consumer.start();
  });

  afterEach(() => {
    consumer.stop();
    outboxWorker.stop();
    db.close();
    cleanupDbFiles();
  });

  test('Local ACID Transaction: Atomically creates order and outbox record', () => {
    const order = db.createOrderWithOutbox({
      userId: 'user-123',
      amount: 49.99,
      currency: 'USD',
    });

    assert.equal(order.user_id, 'user-123');
    assert.equal(order.amount, 49.99);
    assert.equal(order.status, 'PENDING');

    // Verify order was persisted
    const fetchedOrder = db.getOrder(order.id);
    assert.ok(fetchedOrder);
    assert.equal(fetchedOrder.status, 'PENDING');

    // Verify outbox record was inserted atomically
    const pendingOutbox = db.getPendingOutbox();
    assert.equal(pendingOutbox.length, 1);
    assert.equal(pendingOutbox[0].topic, 'order.created');
    assert.equal(pendingOutbox[0].status, 'PENDING');

    const payload = JSON.parse(pendingOutbox[0].payload);
    assert.equal(payload.orderId, order.id);
    assert.equal(payload.userId, 'user-123');
    assert.equal(payload.amount, 49.99);
  });

  test('Local ACID Transaction Rollback: Database constraint failure rolls back entire transaction', () => {
    assert.throws(
      () => {
        // Amount must be > 0 due to CHECK constraint
        db.createOrderWithOutbox({
          userId: 'user-123',
          amount: -10,
        });
      },
      (err: any) => {
        return err.message.includes('CHECK constraint failed');
      }
    );

    // Verify neither order nor outbox entry was persisted
    const orders = db.listOrders();
    assert.equal(orders.length, 0);

    const pendingOutbox = db.getPendingOutbox();
    assert.equal(pendingOutbox.length, 0);
  });

  test('Outbox Worker: Publishes pending records to EventBus and marks PUBLISHED', async () => {
    const receivedEvents: DomainEvent<any>[] = [];
    eventBus.subscribe('order.created', async (evt) => {
      receivedEvents.push(evt);
    });

    const order = db.createOrderWithOutbox({
      userId: 'user-456',
      amount: 75.0,
    });

    // Run outbox worker process
    const count = await outboxWorker.processPending();
    assert.equal(count, 1);

    // Verify event dispatch
    assert.equal(receivedEvents.length, 1);
    assert.equal(receivedEvents[0].topic, 'order.created');
    assert.equal(receivedEvents[0].payload.orderId, order.id);
    assert.equal(receivedEvents[0].payload.amount, 75.0);

    // Verify outbox table status updated to PUBLISHED
    const pendingAfter = db.getPendingOutbox();
    assert.equal(pendingAfter.length, 0);

    const rawRows = db.getRawDb().prepare('SELECT * FROM outbox WHERE id = ?').all(receivedEvents[0].id) as any[];
    assert.equal(rawRows.length, 1);
    assert.equal(rawRows[0].status, 'PUBLISHED');
    assert.ok(rawRows[0].processed_at);
  });

  test('Saga Happy Path: payment.succeeded updates order status to COMPLETED', async () => {
    const order = db.createOrderWithOutbox({
      userId: 'user-789',
      amount: 100,
    });

    // Emit payment.succeeded
    await eventBus.publish({
      id: 'event-payment-ok-1',
      topic: 'payment.succeeded',
      aggregateId: 'bank-tx-1',
      aggregateType: 'Payment',
      payload: {
        orderId: order.id,
        userId: 'user-789',
        amount: 100,
        status: 'SUCCESS',
      },
      occurredAt: new Date().toISOString(),
    });

    const updated = db.getOrder(order.id);
    assert.ok(updated);
    assert.equal(updated.status, 'COMPLETED');

    // Verify inbox record was created
    assert.equal(db.isEventProcessed('event-payment-ok-1'), true);
  });

  test('Saga Compensation: payment.failed updates order status to CANCELLED', async () => {
    const order = db.createOrderWithOutbox({
      userId: 'user-broke',
      amount: 500,
    });

    // Emit payment.failed (e.g. Insufficient balance)
    await eventBus.publish({
      id: 'event-payment-fail-1',
      topic: 'payment.failed',
      aggregateId: 'bank-tx-2',
      aggregateType: 'Payment',
      payload: {
        orderId: order.id,
        userId: 'user-broke',
        amount: 500,
        reason: 'Insufficient balance',
        status: 'FAILED',
      },
      occurredAt: new Date().toISOString(),
    });

    const updated = db.getOrder(order.id);
    assert.ok(updated);
    assert.equal(updated.status, 'CANCELLED');

    // Verify inbox record was created
    assert.equal(db.isEventProcessed('event-payment-fail-1'), true);
  });

  test('Idempotent Consumer: Duplicate payment events are safely ignored', async () => {
    const order = db.createOrderWithOutbox({
      userId: 'user-idemp',
      amount: 30,
    });

    const paymentEvent = {
      id: 'duplicate-event-1',
      topic: 'payment.succeeded',
      aggregateId: 'bank-tx-3',
      aggregateType: 'Payment',
      payload: {
        orderId: order.id,
        userId: 'user-idemp',
        amount: 30,
      },
      occurredAt: new Date().toISOString(),
    };

    // First delivery
    await eventBus.publish(paymentEvent);
    const orderFirst = db.getOrder(order.id);
    assert.equal(orderFirst?.status, 'COMPLETED');

    // Duplicate delivery
    await eventBus.publish(paymentEvent);
    const orderSecond = db.getOrder(order.id);
    assert.equal(orderSecond?.status, 'COMPLETED');
    assert.equal(orderSecond?.updated_at, orderFirst?.updated_at);
  });

  test('HTTP API: Create order, query order by ID and list orders', async () => {
    const app = createOrderApp({ db, outboxWorker, consumer });
    const server = app.listen(0);
    const port = (server.address() as any).port;
    const baseUrl = `http://localhost:${port}`;

    try {
      // 1. Health Check
      const healthRes = await fetch(`${baseUrl}/health`);
      assert.equal(healthRes.status, 200);
      const healthData = await healthRes.json() as any;
      assert.equal(healthData.service, 'order-service');

      // 2. Validation error: Missing userId
      const badRes1 = await fetch(`${baseUrl}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 50 }),
      });
      assert.equal(badRes1.status, 400);

      // 3. Validation error: Non-positive amount
      const badRes2 = await fetch(`${baseUrl}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'u1', amount: -5 }),
      });
      assert.equal(badRes2.status, 400);

      // 4. Create Order
      const createRes = await fetch(`${baseUrl}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'alice', amount: 89.5 }),
      });
      assert.equal(createRes.status, 201);
      const createData = await createRes.json() as any;
      assert.ok(createData.success);
      assert.ok(createData.order.id);
      assert.equal(createData.order.user_id, 'alice');
      assert.equal(createData.order.amount, 89.5);
      assert.equal(createData.order.status, 'PENDING');

      const createdId = createData.order.id;

      // 5. Query Order by ID
      const getRes = await fetch(`${baseUrl}/orders/${createdId}`);
      assert.equal(getRes.status, 200);
      const getData = await getRes.json() as any;
      assert.equal(getData.order.id, createdId);

      // 6. Query Non-existent Order
      const notFoundRes = await fetch(`${baseUrl}/orders/non-existent-uuid`);
      assert.equal(notFoundRes.status, 404);

      // 7. List Orders
      const listRes = await fetch(`${baseUrl}/orders`);
      assert.equal(listRes.status, 200);
      const listData = await listRes.json() as any;
      assert.ok(Array.isArray(listData.orders));
      assert.ok(listData.orders.some((o: any) => o.id === createdId));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

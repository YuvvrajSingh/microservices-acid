import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryEventBus } from '../shared/eventBus.js';
import { createBankDatabase } from '../services/bank-service/src/db.js';
import { BankEventConsumer } from '../services/bank-service/src/eventConsumer.js';
import { BankOutboxWorker } from '../services/bank-service/src/outboxWorker.js';
import { createOrderDatabase } from '../services/order-service/src/db.js';
import { OrderEventConsumer } from '../services/order-service/src/eventConsumer.js';
import { OrderOutboxWorker } from '../services/order-service/src/outboxWorker.js';

test('End-to-End Choreography: Complete Dual Microservice Workflow', async (t) => {
  const bus = new InMemoryEventBus();

  // 1. Initialize independent Bank Service DB and workers
  const bankDb = createBankDatabase(':memory:');
  const bankOutbox = new BankOutboxWorker(bankDb, bus, { batchSize: 50, pollIntervalMs: 50 });
  const bankConsumer = new BankEventConsumer(bankDb, bus, bankOutbox);
  bankConsumer.start();

  // 2. Initialize independent Order Service DB and workers
  const orderDb = createOrderDatabase(':memory:');
  const orderOutbox = new OrderOutboxWorker(orderDb, bus, { batchSize: 50, pollIntervalMs: 50 });
  const orderConsumer = new OrderEventConsumer(orderDb, bus);
  orderConsumer.start();

  // Seed user account with $100 balance
  const user = bankDb.createAccount({ userId: 'alice', initialBalance: 100 });
  assert.equal(user.balance, 100);

  await t.test('Scenario 1: Happy Path - Order placed, Bank debited, Order COMPLETED', async () => {
    // Client calls Order Service: place order for $40
    const order = orderDb.createOrderWithOutbox({ userId: 'alice', amount: 40 });
    assert.equal(order.status, 'PENDING');

    // Order outbox worker publishes event to bus (triggers BankConsumer which processes & triggers BankOutboxWorker)
    const orderPublished = await orderOutbox.processPending();
    assert.equal(orderPublished, 1);

    // Verify final state in Order Service DB: order is COMPLETED
    const finalOrder = orderDb.getOrder(order.id);
    assert.equal(finalOrder?.status, 'COMPLETED');

    // Verify final state in Bank Service DB: balance dropped by $40
    const finalAccount = bankDb.getAccountByUserId('alice');
    assert.equal(finalAccount?.balance, 60);

    const txs = bankDb.getTransactions(finalAccount!.id);
    assert.equal(txs.length, 2); // Initial deposit + Debit
    assert.equal(txs[0].amount, 40);
  });

  await t.test('Scenario 2: Insufficient Funds - Order placed for $80, balance is $60 -> Order CANCELLED (Compensated)', async () => {
    // Current balance is $60. Client tries to order $80.
    const order = orderDb.createOrderWithOutbox({ userId: 'alice', amount: 80 });
    assert.equal(order.status, 'PENDING');

    // Order outbox publishes order.created (triggers BankConsumer -> payment.failed -> OrderConsumer -> CANCELLED)
    const orderPublished = await orderOutbox.processPending();
    assert.equal(orderPublished, 1);

    // Verify final state in Order Service DB: order CANCELLED (Saga compensation)
    const finalOrder = orderDb.getOrder(order.id);
    assert.equal(finalOrder?.status, 'CANCELLED');

    // Verify Bank balance remained unchanged at $60
    const finalAccount = bankDb.getAccountByUserId('alice');
    assert.equal(finalAccount?.balance, 60);
  });

  await t.test('Scenario 3: Network Duplication - At-least-once message delivery idempotency', async () => {
    // Order for $20
    const order = orderDb.createOrderWithOutbox({ userId: 'alice', amount: 20 });
    await orderOutbox.processPending();

    const orderAfterSuccess = orderDb.getOrder(order.id);
    assert.equal(orderAfterSuccess?.status, 'COMPLETED');
    assert.equal(bankDb.getAccountByUserId('alice')?.balance, 40);

    // Retrieve the order.created payload to simulate duplicate network delivery
    const outboxRow = orderDb.getRawDb().prepare('SELECT payload FROM outbox ORDER BY created_at DESC LIMIT 1').get() as { payload: string };
    const parsedEvent = JSON.parse(outboxRow.payload);

    // Direct duplicate dispatch to bank consumer
    const result = await bankConsumer.handleOrderCreated({
      id: parsedEvent.orderId,
      topic: 'order.created',
      aggregateId: parsedEvent.orderId,
      aggregateType: 'Order',
      payload: parsedEvent,
      timestamp: new Date().toISOString(),
    });

    // Check duplicate was recognized
    assert.equal(result.status, 'ALREADY_PROCESSED');

    // Verify bank balance did NOT decrement again
    assert.equal(bankDb.getAccountByUserId('alice')?.balance, 40);
  });

  // Cleanup
  bankConsumer.stop();
  bankOutbox.stop();
  orderConsumer.stop();
  orderOutbox.stop();
  bankDb.close();
  orderDb.close();
});

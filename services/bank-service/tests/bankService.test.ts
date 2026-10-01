import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createBankDatabase, BankDatabase } from '../src/db';
import { BankOutboxWorker } from '../src/outboxWorker';
import { BankEventConsumer } from '../src/eventConsumer';
import { createBankApp } from '../src/api';
import { InMemoryEventBus } from '../../../shared/eventBus';
import { DomainEvent } from '../../../shared/types';

describe('Bank Service - Local ACID Transactions, Outbox & Idempotency', () => {
  let db: BankDatabase;
  let testBus: InMemoryEventBus;
  let outboxWorker: BankOutboxWorker;
  let eventConsumer: BankEventConsumer;

  beforeEach(() => {
    // Use an in-memory SQLite database for test isolation
    db = createBankDatabase(':memory:');
    testBus = new InMemoryEventBus();
    outboxWorker = new BankOutboxWorker(db, testBus, { pollIntervalMs: 50 });
    eventConsumer = new BankEventConsumer(db, testBus, outboxWorker);
  });

  afterEach(() => {
    outboxWorker.stop();
    eventConsumer.stop();
    db.close();
  });

  test('Account creation and initial deposit ledger', () => {
    const account = db.createAccount({ userId: 'alice', initialBalance: 150 });
    assert.equal(account.user_id, 'alice');
    assert.equal(account.balance, 150);

    const retrieved = db.getAccountByUserId('alice');
    assert.ok(retrieved);
    assert.equal(retrieved.balance, 150);

    const txs = db.getTransactions(account.id);
    assert.equal(txs.length, 1);
    assert.equal(txs[0].type, 'DEPOSIT');
    assert.equal(txs[0].amount, 150);

    // Re-creating same userId should fail due to UNIQUE constraint
    assert.throws(() => {
      db.createAccount({ userId: 'alice', initialBalance: 50 });
    });
  });

  test('Deposit increases account balance and adds transaction', () => {
    const account = db.createAccount({ userId: 'bob', initialBalance: 50 });
    const depositResult = db.deposit('bob', 75);

    assert.equal(depositResult.account.balance, 125);
    assert.equal(depositResult.transaction.amount, 75);
    assert.equal(depositResult.transaction.type, 'DEPOSIT');

    const updated = db.getAccountByUserId('bob');
    assert.equal(updated?.balance, 125);

    const txs = db.getTransactions(account.id);
    assert.equal(txs.length, 2); // Initial deposit + second deposit
  });

  test('Database level CHECK (balance >= 0) constraint is strictly enforced', () => {
    const account = db.createAccount({ userId: 'charlie', initialBalance: 30 });
    const rawDb = db.getRawDb();

    // Directly attempting to update balance to a negative number must fail at SQL constraint level
    assert.throws(() => {
      rawDb.prepare('UPDATE accounts SET balance = -10 WHERE id = ?').run(account.id);
    }, /CHECK constraint failed/);

    const afterCheck = db.getAccountById(account.id);
    assert.equal(afterCheck?.balance, 30);
  });

  test('Local ACID Transaction - Sufficient balance debits account, logs tx, records outbox, marks inbox', () => {
    const account = db.createAccount({ userId: 'david', initialBalance: 200 });
    const eventId = 'evt-david-order-1';
    const orderId = 'ord-101';

    const result = db.debitAccountTx(eventId, orderId, 'david', 60);

    assert.equal(result.status, 'PAYMENT_SUCCEEDED');
    assert.equal(result.newBalance, 140);
    assert.ok(result.transactionId);

    // 1. Verify balance updated
    const updatedAccount = db.getAccountById(account.id);
    assert.equal(updatedAccount?.balance, 140);

    // 2. Verify ledger debit transaction
    const txs = db.getTransactions(account.id);
    const debitTx = txs.find((t) => t.type === 'DEBIT');
    assert.ok(debitTx);
    assert.equal(debitTx.amount, 60);

    // 3. Verify outbox record
    const pendingOutbox = db.getPendingOutbox();
    assert.equal(pendingOutbox.length, 1);
    assert.equal(pendingOutbox[0].topic, 'payment.succeeded');

    const payload = JSON.parse(pendingOutbox[0].payload);
    assert.equal(payload.orderId, 'ord-101');
    assert.equal(payload.userId, 'david');
    assert.equal(payload.amount, 60);
    assert.equal(payload.remainingBalance, 140);

    // 4. Verify inbox marker
    assert.ok(db.isEventProcessed(eventId));
  });

  test('Local ACID Transaction - Insufficient funds emits payment.failed, marks inbox, does NOT change balance', () => {
    const account = db.createAccount({ userId: 'elena', initialBalance: 25 });
    const eventId = 'evt-elena-order-1';
    const orderId = 'ord-102';

    const result = db.debitAccountTx(eventId, orderId, 'elena', 100);

    assert.equal(result.status, 'PAYMENT_FAILED');
    assert.ok(result.reason?.includes('Insufficient balance'));

    // 1. Balance remains unchanged
    const after = db.getAccountById(account.id);
    assert.equal(after?.balance, 25);

    // 2. No DEBIT transaction
    const txs = db.getTransactions(account.id);
    const debitTx = txs.find((t) => t.type === 'DEBIT');
    assert.equal(debitTx, undefined);

    // 3. Outbox recorded payment.failed
    const pendingOutbox = db.getPendingOutbox();
    assert.equal(pendingOutbox.length, 1);
    assert.equal(pendingOutbox[0].topic, 'payment.failed');

    const payload = JSON.parse(pendingOutbox[0].payload);
    assert.equal(payload.orderId, 'ord-102');
    assert.equal(payload.userId, 'elena');

    // 4. Inbox marked
    assert.ok(db.isEventProcessed(eventId));
  });

  test('Local ACID Transaction - Non-existent user emits payment.failed and marks inbox', () => {
    const eventId = 'evt-ghost-order-1';
    const orderId = 'ord-103';

    const result = db.debitAccountTx(eventId, orderId, 'non_existent_user', 50);

    assert.equal(result.status, 'PAYMENT_FAILED');
    assert.ok(result.reason?.includes('Account not found'));

    // Outbox recorded payment.failed
    const pendingOutbox = db.getPendingOutbox();
    assert.equal(pendingOutbox.length, 1);
    assert.equal(pendingOutbox[0].topic, 'payment.failed');

    // Inbox marked
    assert.ok(db.isEventProcessed(eventId));
  });

  test('Idempotency: duplicate eventId is rejected without re-debiting or creating new outbox messages', () => {
    db.createAccount({ userId: 'frank', initialBalance: 100 });
    const eventId = 'evt-frank-order-1';

    // First attempt
    const firstResult = db.debitAccountTx(eventId, 'ord-201', 'frank', 30);
    assert.equal(firstResult.status, 'PAYMENT_SUCCEEDED');
    assert.equal(firstResult.newBalance, 70);

    const outboxAfterFirst = db.getPendingOutbox();
    assert.equal(outboxAfterFirst.length, 1);

    // Second attempt with exact same eventId
    const secondResult = db.debitAccountTx(eventId, 'ord-201', 'frank', 30);
    assert.equal(secondResult.status, 'ALREADY_PROCESSED');

    // Balance must STILL be 70 (not 40)
    const account = db.getAccountByUserId('frank');
    assert.equal(account?.balance, 70);

    // No additional outbox rows
    const outboxAfterSecond = db.getPendingOutbox();
    assert.equal(outboxAfterSecond.length, 1);
  });

  test('OutboxWorker: publishes pending outbox records to EventBus and marks them PUBLISHED', async () => {
    db.createAccount({ userId: 'grace', initialBalance: 80 });
    db.debitAccountTx('evt-grace-1', 'ord-301', 'grace', 20);

    const publishedEvents: DomainEvent<any>[] = [];
    testBus.subscribe('payment.succeeded', async (event) => {
      publishedEvents.push(event);
    });

    const pendingBefore = db.getPendingOutbox();
    assert.equal(pendingBefore.length, 1);
    assert.equal(pendingBefore[0].status, 'PENDING');

    const publishedCount = await outboxWorker.processPending();
    assert.equal(publishedCount, 1);
    assert.equal(publishedEvents.length, 1);
    assert.equal(publishedEvents[0].topic, 'payment.succeeded');
    assert.equal(publishedEvents[0].payload.orderId, 'ord-301');

    // Verify outbox record transitioned to PUBLISHED
    const pendingAfter = db.getPendingOutbox();
    assert.equal(pendingAfter.length, 0);

    const allOutbox = db.listOutbox();
    assert.equal(allOutbox[0].status, 'PUBLISHED');
  });

  test('End-to-End Choreography: Consumer handles order.created, debits, and publishes payment.succeeded', async () => {
    db.createAccount({ userId: 'helen', initialBalance: 100 });

    eventConsumer.start();

    const paymentEvents: DomainEvent<any>[] = [];
    testBus.subscribe('payment.succeeded', async (event) => {
      paymentEvents.push(event);
    });

    // Simulate order service publishing order.created
    await testBus.publish({
      id: 'order-evt-helen-1',
      topic: 'order.created',
      aggregateId: 'ord-401',
      aggregateType: 'Order',
      payload: {
        orderId: 'ord-401',
        userId: 'helen',
        amount: 45,
      },
      occurredAt: new Date().toISOString(),
    });

    // Verify payment.succeeded was published
    assert.equal(paymentEvents.length, 1);
    assert.equal(paymentEvents[0].payload.orderId, 'ord-401');
    assert.equal(paymentEvents[0].payload.amount, 45);

    // Verify bank account was debited to 55
    const account = db.getAccountByUserId('helen');
    assert.equal(account?.balance, 55);

    // Verify inbox recorded order-evt-helen-1
    assert.ok(db.isEventProcessed('order-evt-helen-1'));
  });

  test('End-to-End Choreography: Insufficient funds emits payment.failed to trigger compensation', async () => {
    db.createAccount({ userId: 'ian', initialBalance: 15 });

    eventConsumer.start();

    const failedEvents: DomainEvent<any>[] = [];
    testBus.subscribe('payment.failed', async (event) => {
      failedEvents.push(event);
    });

    // Order created for $150 (available only $15)
    await testBus.publish({
      id: 'order-evt-ian-1',
      topic: 'order.created',
      aggregateId: 'ord-402',
      aggregateType: 'Order',
      payload: {
        orderId: 'ord-402',
        userId: 'ian',
        amount: 150,
      },
      occurredAt: new Date().toISOString(),
    });

    // Verify payment.failed was published
    assert.equal(failedEvents.length, 1);
    assert.equal(failedEvents[0].payload.orderId, 'ord-402');
    assert.ok(failedEvents[0].payload.reason.includes('Insufficient balance'));

    // Verify bank account remains 15
    const account = db.getAccountByUserId('ian');
    assert.equal(account?.balance, 15);
  });
});

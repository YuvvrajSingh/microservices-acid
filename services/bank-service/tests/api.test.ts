import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { createBankDatabase, BankDatabase } from '../src/db';
import { BankOutboxWorker } from '../src/outboxWorker';
import { createBankApp } from '../src/api';
import { InMemoryEventBus } from '../../../shared/eventBus';

describe('Bank Service - HTTP API Endpoints', () => {
  let db: BankDatabase;
  let server: http.Server;
  let baseUrl: string;
  let outboxWorker: BankOutboxWorker;

  before(async () => {
    db = createBankDatabase(':memory:');
    const bus = new InMemoryEventBus();
    outboxWorker = new BankOutboxWorker(db, bus);
    const app = createBankApp({ db, outboxWorker });

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address() as import('net').AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    outboxWorker.stop();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    db.close();
  });

  test('GET /health returns status ok', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'bank-service');
  });

  test('POST /accounts creates a new account with initial balance', async () => {
    const res = await fetch(`${baseUrl}/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-http-1', initialBalance: 250 }),
    });

    assert.equal(res.status, 201);
    const body = (await res.json()) as any;
    assert.equal(body.success, true);
    assert.equal(body.account.user_id, 'user-http-1');
    assert.equal(body.account.balance, 250);
  });

  test('POST /accounts rejects duplicate userId', async () => {
    const res = await fetch(`${baseUrl}/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-http-1', initialBalance: 50 }),
    });

    assert.equal(res.status, 409);
    const body = (await res.json()) as any;
    assert.ok(body.error.includes('already exists'));
  });

  test('GET /accounts/:userId returns existing account', async () => {
    const res = await fetch(`${baseUrl}/accounts/user-http-1`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.account.user_id, 'user-http-1');
    assert.equal(body.account.balance, 250);
  });

  test('POST /accounts/:userId/deposit deposits funds', async () => {
    const res = await fetch(`${baseUrl}/accounts/user-http-1/deposit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 150 }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.success, true);
    assert.equal(body.account.balance, 400);
    assert.equal(body.transaction.amount, 150);
  });

  test('GET /accounts/:userId/transactions returns ledger history', async () => {
    const res = await fetch(`${baseUrl}/accounts/user-http-1/transactions`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.transactions.length, 2); // Initial deposit of 250 + deposit of 150
  });

  test('GET /inbox and GET /outbox return record arrays', async () => {
    const inboxRes = await fetch(`${baseUrl}/inbox`);
    assert.equal(inboxRes.status, 200);
    const inboxBody = (await inboxRes.json()) as any;
    assert.ok(Array.isArray(inboxBody.inbox));

    const outboxRes = await fetch(`${baseUrl}/outbox`);
    assert.equal(outboxRes.status, 200);
    const outboxBody = (await outboxRes.json()) as any;
    assert.ok(Array.isArray(outboxBody.outbox));
  });

  test('POST /outbox/process triggers outbox publishing', async () => {
    const res = await fetch(`${baseUrl}/outbox/process`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.success, true);
    assert.equal(typeof body.publishedCount, 'number');
  });
});

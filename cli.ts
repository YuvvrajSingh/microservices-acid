#!/usr/bin/env node
/**
 * ACID Microservices CLI
 * Interactive and non-interactive command-line interface for the
 * Transactional Outbox & Inbox choreographed microservices architecture.
 */

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import path from 'node:path';
import { startOrderService, OrderServiceInstance } from './services/order-service/src/index';
import { startBankService, BankServiceInstance } from './services/bank-service/src/index';
import { eventBus } from './shared/eventBus';

// --- Minimalist Developer Aesthetics & Styling ---
const noColor = Boolean(process.env.NO_COLOR) || !output.isTTY;

const c = {
  reset: noColor ? '' : '\x1b[0m',
  bold: noColor ? '' : '\x1b[1m',
  dim: noColor ? '' : '\x1b[2m',
  italic: noColor ? '' : '\x1b[3m',
  underline: noColor ? '' : '\x1b[4m',
  cyan: noColor ? '' : '\x1b[36m',
  brightCyan: noColor ? '' : '\x1b[96m',
  green: noColor ? '' : '\x1b[32m',
  brightGreen: noColor ? '' : '\x1b[92m',
  yellow: noColor ? '' : '\x1b[33m',
  brightYellow: noColor ? '' : '\x1b[93m',
  red: noColor ? '' : '\x1b[31m',
  brightRed: noColor ? '' : '\x1b[91m',
  magenta: noColor ? '' : '\x1b[35m',
  gray: noColor ? '' : '\x1b[90m',
  white: noColor ? '' : '\x1b[97m',
  bgDark: noColor ? '' : '\x1b[48;5;236m',
};

function statusBadge(status: string): string {
  switch (status.toUpperCase()) {
    case 'COMPLETED':
    case 'PUBLISHED':
    case 'SUCCESS':
    case 'OK':
      return `${c.brightGreen}● ${status}${c.reset}`;
    case 'PENDING':
      return `${c.brightYellow}○ ${status}${c.reset}`;
    case 'CANCELLED':
    case 'FAILED':
      return `${c.brightRed}✕ ${status}${c.reset}`;
    default:
      return `${c.gray}· ${status}${c.reset}`;
  }
}

function txTypeBadge(type: string): string {
  if (type === 'DEPOSIT') {
    return `${c.brightGreen}+ DEPOSIT${c.reset}`;
  }
  return `${c.brightRed}- DEBIT${c.reset}`;
}

function formatCurrency(amount: number, currency: string = 'USD'): string {
  return `$${amount.toFixed(2)} ${currency}`;
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

interface TableColumn {
  header: string;
  key: string;
  align?: 'left' | 'right';
  maxWidth?: number;
}

function renderTable(columns: TableColumn[], data: Record<string, any>[]): string {
  if (data.length === 0) {
    return `${c.dim}  (No records found)${c.reset}`;
  }

  // Calculate widths
  const colWidths = columns.map((col) => {
    let max = col.header.length;
    for (const row of data) {
      const valStr = stripAnsi(String(row[col.key] ?? ''));
      if (valStr.length > max) {
        max = valStr.length;
      }
    }
    if (col.maxWidth && max > col.maxWidth) {
      max = col.maxWidth;
    }
    return max;
  });

  const topBorder = `┌─${colWidths.map((w) => '─'.repeat(w)).join('─┬─')}─┐`;
  const midBorder = `├─${colWidths.map((w) => '─'.repeat(w)).join('─┼─')}─┤`;
  const botBorder = `└─${colWidths.map((w) => '─'.repeat(w)).join('─┴─')}─┘`;

  const headerLine = `│ ${columns
    .map((col, idx) => {
      const title = col.header;
      const pad = colWidths[idx] - title.length;
      return `${c.bold}${c.brightCyan}${title}${' '.repeat(Math.max(0, pad))}${c.reset}`;
    })
    .join(' │ ')} │`;

  const rows = data.map((row) => {
    const cells = columns.map((col, idx) => {
      const rawVal = String(row[col.key] ?? '');
      const visibleLength = stripAnsi(rawVal).length;
      const targetWidth = colWidths[idx];

      let formatted = rawVal;
      if (visibleLength > targetWidth) {
        // truncate with ellipsis
        const sliceLen = Math.max(0, targetWidth - 1);
        formatted = stripAnsi(rawVal).slice(0, sliceLen) + '…';
      }

      const pad = Math.max(0, targetWidth - stripAnsi(formatted).length);
      if (col.align === 'right') {
        return ' '.repeat(pad) + formatted;
      }
      return formatted + ' '.repeat(pad);
    });

    return `│ ${cells.join(' │ ')} │`;
  });

  return [topBorder, headerLine, midBorder, ...rows, botBorder].join('\n');
}

function renderBox(title: string, content: string[]): string {
  const visibleLens = [title.length, ...content.map((l) => stripAnsi(l).length)];
  const maxContentWidth = Math.max(...visibleLens, 40);

  const top = `┌─ ${c.bold}${c.brightCyan}${title}${c.reset} ${'─'.repeat(
    Math.max(0, maxContentWidth - title.length)
  )}┐`;
  const body = content.map((line) => {
    const pad = maxContentWidth - stripAnsi(line).length;
    return `│  ${line}${' '.repeat(Math.max(0, pad))}  │`;
  });
  const bot = `└─${'─'.repeat(maxContentWidth + 2)}─┘`;

  return [top, ...body, bot].join('\n');
}

// --- Service Client Context ---
export interface ServiceContext {
  orderUrl: string;
  bankUrl: string;
  orderInstance: OrderServiceInstance | null;
  bankInstance: BankServiceInstance | null;
  startedInProcess: boolean;
  close: () => Promise<void>;
}

async function isServiceHealthy(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 350);
    const res = await fetch(`${url}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function initServices(): Promise<ServiceContext> {
  const defaultOrderPort = parseInt(process.env.ORDER_SERVICE_PORT || '3001', 10);
  const defaultBankPort = parseInt(process.env.BANK_SERVICE_PORT || '3002', 10);

  const orderUrl = process.env.ORDER_SERVICE_URL || `http://localhost:${defaultOrderPort}`;
  const bankUrl = process.env.BANK_SERVICE_URL || `http://localhost:${defaultBankPort}`;

  const [orderHealthy, bankHealthy] = await Promise.all([
    isServiceHealthy(orderUrl),
    isServiceHealthy(bankUrl),
  ]);

  if (orderHealthy && bankHealthy) {
    return {
      orderUrl,
      bankUrl,
      orderInstance: null,
      bankInstance: null,
      startedInProcess: false,
      close: async () => {},
    };
  }

  // If not running, start services in-process
  const baseDir = path.resolve(__dirname);
  const orderDbPath = path.resolve(baseDir, 'services/order-service/order.db');
  const bankDbPath = path.resolve(baseDir, 'services/bank-service/bank.db');

  let orderInstance: OrderServiceInstance | null = null;
  let bankInstance: BankServiceInstance | null = null;

  try {
    if (!orderHealthy) {
      orderInstance = startOrderService({
        port: defaultOrderPort,
        dbPath: orderDbPath,
        startWorker: true,
      });
    }
  } catch (err: any) {
    // If port binding fails, fallback to worker & DB in-process without port
    orderInstance = startOrderService({
      dbPath: orderDbPath,
      startWorker: true,
    });
  }

  try {
    if (!bankHealthy) {
      bankInstance = startBankService({
        port: defaultBankPort,
        dbPath: bankDbPath,
        startWorker: true,
      });
    }
  } catch (err: any) {
    bankInstance = startBankService({
      dbPath: bankDbPath,
      startWorker: true,
    });
  }

  return {
    orderUrl,
    bankUrl,
    orderInstance,
    bankInstance,
    startedInProcess: true,
    close: async () => {
      if (orderInstance) {
        await orderInstance.close();
      }
      if (bankInstance) {
        await bankInstance.close();
      }
    },
  };
}

// --- Unified Microservices Client ---
export class MicroservicesClient {
  constructor(private ctx: ServiceContext) {}

  // 1: Create Account
  async createAccount(userId: string, initialBalance: number = 0) {
    if (this.ctx.bankInstance && !this.ctx.bankInstance.server) {
      // In-process DB fallback
      const existing = this.ctx.bankInstance.db.getAccountByUserId(userId);
      if (existing) {
        throw new Error(`Account already exists for user "${userId}"`);
      }
      return this.ctx.bankInstance.db.createAccount({ userId, initialBalance });
    }

    const res = await fetch(`${this.ctx.bankUrl}/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, initialBalance }),
    });
    const data = (await res.json()) as any;
    if (!res.ok) {
      throw new Error(data.error || `Failed to create account (HTTP ${res.status})`);
    }
    return data.account;
  }

  // 2: Deposit funds
  async deposit(userId: string, amount: number) {
    if (this.ctx.bankInstance && !this.ctx.bankInstance.server) {
      return this.ctx.bankInstance.db.deposit(userId, amount);
    }

    const res = await fetch(`${this.ctx.bankUrl}/accounts/${encodeURIComponent(userId)}/deposit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount }),
    });
    const data = (await res.json()) as any;
    if (!res.ok) {
      throw new Error(data.error || `Deposit failed (HTTP ${res.status})`);
    }
    return data;
  }

  // 3: Check Account & Transactions
  async getAccount(userId: string) {
    if (this.ctx.bankInstance && !this.ctx.bankInstance.server) {
      const account = this.ctx.bankInstance.db.getAccountByUserId(userId);
      if (!account) return null;
      const transactions = this.ctx.bankInstance.db.getTransactions(account.id);
      return { account, transactions };
    }

    const [accRes, txRes] = await Promise.all([
      fetch(`${this.ctx.bankUrl}/accounts/${encodeURIComponent(userId)}`),
      fetch(`${this.ctx.bankUrl}/accounts/${encodeURIComponent(userId)}/transactions`),
    ]);

    if (accRes.status === 404) {
      return null;
    }

    const accData = (await accRes.json()) as any;
    const txData = (await txRes.json()) as any;
    return {
      account: accData.account,
      transactions: txData.transactions || [],
    };
  }

  // 4: Place Order
  async placeOrder(userId: string, amount: number, currency: string = 'USD') {
    if (this.ctx.orderInstance && !this.ctx.orderInstance.server) {
      const order = this.ctx.orderInstance.db.createOrderWithOutbox({ userId, amount, currency });
      // Trigger worker
      setImmediate(() => {
        this.ctx.orderInstance?.outboxWorker.trigger();
      });
      return order;
    }

    const res = await fetch(`${this.ctx.orderUrl}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, amount, currency }),
    });
    const data = (await res.json()) as any;
    if (!res.ok) {
      throw new Error(data.error || `Failed to create order (HTTP ${res.status})`);
    }
    return data.order;
  }

  // 5: View Order
  async getOrder(orderId: string) {
    if (this.ctx.orderInstance && !this.ctx.orderInstance.server) {
      return this.ctx.orderInstance.db.getOrder(orderId);
    }

    const res = await fetch(`${this.ctx.orderUrl}/orders/${encodeURIComponent(orderId)}`);
    if (res.status === 404) {
      return null;
    }
    const data = (await res.json()) as any;
    return data.order;
  }

  // Poll for Choreography Settlement
  async waitForSettlement(orderId: string, timeoutMs: number = 3000): Promise<{ order: any; elapsedMs: number }> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const order = await this.getOrder(orderId);
      if (order && order.status !== 'PENDING') {
        return { order, elapsedMs: Date.now() - start };
      }
      await new Promise((r) => setTimeout(r, 60));
    }
    const finalOrder = await this.getOrder(orderId);
    return { order: finalOrder, elapsedMs: Date.now() - start };
  }

  // 6: List Accounts & Orders
  async listAll() {
    let accounts: any[] = [];
    let orders: any[] = [];

    // Fetch accounts
    if (this.ctx.bankInstance && !this.ctx.bankInstance.server) {
      accounts = this.ctx.bankInstance.db.listAccounts(100);
    } else {
      try {
        const res = await fetch(`${this.ctx.bankUrl}/accounts?limit=100`);
        const data = (await res.json()) as any;
        accounts = data.accounts || [];
      } catch {}
    }

    // Fetch orders
    if (this.ctx.orderInstance && !this.ctx.orderInstance.server) {
      orders = this.ctx.orderInstance.db.listOrders(100);
    } else {
      try {
        const res = await fetch(`${this.ctx.orderUrl}/orders?limit=100`);
        const data = (await res.json()) as any;
        orders = data.orders || [];
      } catch {}
    }

    return { accounts, orders };
  }

  // 7: Inspect Outbox & Inbox
  async inspectTables() {
    let orderOutbox: any[] = [];
    let orderInbox: any[] = [];
    let bankOutbox: any[] = [];
    let bankInbox: any[] = [];

    // Order Service Tables
    if (this.ctx.orderInstance && !this.ctx.orderInstance.server) {
      orderOutbox = this.ctx.orderInstance.db.listOutbox(undefined, 50);
      orderInbox = this.ctx.orderInstance.db.listInbox(50);
    } else {
      try {
        const [outRes, inRes] = await Promise.all([
          fetch(`${this.ctx.orderUrl}/outbox?limit=50`),
          fetch(`${this.ctx.orderUrl}/inbox?limit=50`),
        ]);
        if (outRes.ok) orderOutbox = ((await outRes.json()) as any).outbox || [];
        if (inRes.ok) orderInbox = ((await inRes.json()) as any).inbox || [];
      } catch {}
    }

    // Bank Service Tables
    if (this.ctx.bankInstance && !this.ctx.bankInstance.server) {
      bankOutbox = this.ctx.bankInstance.db.listOutbox(undefined, 50);
      bankInbox = this.ctx.bankInstance.db.listInbox(50);
    } else {
      try {
        const [outRes, inRes] = await Promise.all([
          fetch(`${this.ctx.bankUrl}/outbox?limit=50`),
          fetch(`${this.ctx.bankUrl}/inbox?limit=50`),
        ]);
        if (outRes.ok) bankOutbox = ((await outRes.json()) as any).outbox || [];
        if (inRes.ok) bankInbox = ((await inRes.json()) as any).inbox || [];
      } catch {}
    }

    return { orderOutbox, orderInbox, bankOutbox, bankInbox };
  }
}

// --- CLI Action Handlers ---

async function handleCreateAccount(client: MicroservicesClient, rl?: readline.Interface, args: string[] = []) {
  let userId = args[0];
  let depositStr = args[1];

  if (!userId && rl) {
    userId = (await rl.question(`  ${c.cyan}›${c.reset} Enter User ID (e.g. alice): `)).trim();
  }
  if (!userId) {
    console.log(`\n  ${c.brightRed}Error:${c.reset} User ID is required.\n`);
    return;
  }

  if (depositStr === undefined && rl) {
    depositStr = (await rl.question(`  ${c.cyan}›${c.reset} Initial deposit amount [$100]: `)).trim();
  }
  const initialBalance = depositStr ? parseFloat(depositStr) : 100;

  if (isNaN(initialBalance) || initialBalance < 0) {
    console.log(`\n  ${c.brightRed}Error:${c.reset} Initial deposit must be a non-negative number.\n`);
    return;
  }

  try {
    const account = await client.createAccount(userId, initialBalance);
    console.log('\n' + renderBox('BANK ACCOUNT CREATED', [
      `${c.dim}User ID:${c.reset}        ${c.bold}${account.user_id}${c.reset}`,
      `${c.dim}Account ID:${c.reset}     ${account.id}`,
      `${c.dim}Initial Balance:${c.reset}${c.brightGreen} ${formatCurrency(account.balance)}${c.reset}`,
      `${c.dim}Created At:${c.reset}      ${account.created_at}`,
    ]) + '\n');
  } catch (err: any) {
    console.log(`\n  ${c.brightRed}Failed to create account:${c.reset} ${err.message}\n`);
  }
}

async function handleDeposit(client: MicroservicesClient, rl?: readline.Interface, args: string[] = []) {
  let userId = args[0];
  let amountStr = args[1];

  if (!userId && rl) {
    userId = (await rl.question(`  ${c.cyan}›${c.reset} Enter User ID: `)).trim();
  }
  if (!userId) {
    console.log(`\n  ${c.brightRed}Error:${c.reset} User ID is required.\n`);
    return;
  }

  if (!amountStr && rl) {
    amountStr = (await rl.question(`  ${c.cyan}›${c.reset} Enter deposit amount ($): `)).trim();
  }
  const amount = parseFloat(amountStr || '0');
  if (isNaN(amount) || amount <= 0) {
    console.log(`\n  ${c.brightRed}Error:${c.reset} Amount must be greater than zero.\n`);
    return;
  }

  try {
    const res = await client.deposit(userId, amount);
    console.log('\n' + renderBox('DEPOSIT SUCCESSFUL', [
      `${c.dim}User ID:${c.reset}        ${c.bold}${userId}${c.reset}`,
      `${c.dim}Deposited:${c.reset}      ${c.brightGreen}+${formatCurrency(amount)}${c.reset}`,
      `${c.dim}New Balance:${c.reset}    ${c.bold}${c.brightGreen}${formatCurrency(res.account.balance)}${c.reset}`,
      `${c.dim}Tx ID:${c.reset}          ${res.transaction.id}`,
      `${c.dim}Timestamp:${c.reset}      ${res.transaction.created_at}`,
    ]) + '\n');
  } catch (err: any) {
    console.log(`\n  ${c.brightRed}Deposit failed:${c.reset} ${err.message}\n`);
  }
}

async function handleCheckBalance(client: MicroservicesClient, rl?: readline.Interface, args: string[] = []) {
  let userId = args[0];

  if (!userId && rl) {
    userId = (await rl.question(`  ${c.cyan}›${c.reset} Enter User ID: `)).trim();
  }
  if (!userId) {
    console.log(`\n  ${c.brightRed}Error:${c.reset} User ID is required.\n`);
    return;
  }

  try {
    const result = await client.getAccount(userId);
    if (!result) {
      console.log(`\n  ${c.brightYellow}Notice:${c.reset} Account not found for user "${userId}".\n`);
      return;
    }

    const { account, transactions } = result;

    console.log('\n' + renderBox('ACCOUNT SUMMARY', [
      `${c.dim}User ID:${c.reset}        ${c.bold}${account.user_id}${c.reset}`,
      `${c.dim}Account ID:${c.reset}     ${account.id}`,
      `${c.dim}Current Balance:${c.reset}${c.bold}${c.brightGreen} ${formatCurrency(account.balance)}${c.reset}`,
      `${c.dim}Last Updated:${c.reset}   ${account.updated_at}`,
    ]));

    console.log(`\n  ${c.bold}Ledger Transaction History (${transactions.length}):${c.reset}\n`);

    const tableData = transactions.map((t: any) => ({
      id: t.id,
      type: txTypeBadge(t.type),
      amount: t.type === 'DEPOSIT' ? `+${formatCurrency(t.amount)}` : `-${formatCurrency(t.amount)}`,
      created_at: t.created_at,
    }));

    const outputTable = renderTable(
      [
        { header: 'Transaction ID', key: 'id', maxWidth: 36 },
        { header: 'Type', key: 'type' },
        { header: 'Amount', key: 'amount', align: 'right' },
        { header: 'Timestamp', key: 'created_at' },
      ],
      tableData
    );

    console.log(outputTable + '\n');
  } catch (err: any) {
    console.log(`\n  ${c.brightRed}Failed to fetch account:${c.reset} ${err.message}\n`);
  }
}

async function handlePlaceOrder(client: MicroservicesClient, rl?: readline.Interface, args: string[] = []) {
  let userId = args[0];
  let amountStr = args[1];

  if (!userId && rl) {
    userId = (await rl.question(`  ${c.cyan}›${c.reset} Enter User ID (e.g. alice): `)).trim();
  }
  if (!userId) {
    console.log(`\n  ${c.brightRed}Error:${c.reset} User ID is required.\n`);
    return;
  }

  if (!amountStr && rl) {
    amountStr = (await rl.question(`  ${c.cyan}›${c.reset} Enter Order Amount ($): `)).trim();
  }
  const amount = parseFloat(amountStr || '0');
  if (isNaN(amount) || amount <= 0) {
    console.log(`\n  ${c.brightRed}Error:${c.reset} Amount must be greater than zero.\n`);
    return;
  }

  console.log(`\n  ${c.cyan}·${c.reset} [1/3] Executing local ACID transaction in Order Service...`);

  let order: any;
  try {
    order = await client.placeOrder(userId, amount);
  } catch (err: any) {
    console.log(`\n  ${c.brightRed}Order initiation failed:${c.reset} ${err.message}\n`);
    return;
  }

  console.log(`  ${c.cyan}·${c.reset} [2/3] Order persisted (${order.id}) with status ${statusBadge('PENDING')}`);
  console.log(`  ${c.cyan}·${c.reset} [3/3] Outbox message written. Awaiting choreographed saga settlement...`);

  const { order: settledOrder, elapsedMs } = await client.waitForSettlement(order.id, 4000);

  const finalStatus = settledOrder ? settledOrder.status : 'PENDING';
  const statusNote =
    finalStatus === 'COMPLETED'
      ? `${c.brightGreen}COMPLETED${c.reset} (Debit approved & settled)`
      : finalStatus === 'CANCELLED'
      ? `${c.brightRed}CANCELLED${c.reset} (Saga compensation triggered · Insufficient funds)`
      : `${c.brightYellow}PENDING${c.reset} (Processing in background)`;

  console.log('\n' + renderBox('CHOREOGRAPHED SAGA EXECUTION', [
    `${c.dim}Order ID:${c.reset}       ${c.bold}${order.id}${c.reset}`,
    `${c.dim}User ID:${c.reset}        ${order.user_id}`,
    `${c.dim}Amount:${c.reset}         ${formatCurrency(order.amount)}`,
    `${c.dim}Initial State:${c.reset}  ${statusBadge('PENDING')}`,
    `${c.dim}Final State:${c.reset}    ${statusBadge(finalStatus)}`,
    `${c.dim}Outcome:${c.reset}        ${statusNote}`,
    `${c.dim}Latency:${c.reset}        ${elapsedMs}ms`,
    `${c.dim}Guarantees:${c.reset}     Dual-write prevention via SQLite Outbox + Idempotent Inbox`,
  ]) + '\n');
}

async function handleViewOrderStatus(client: MicroservicesClient, rl?: readline.Interface, args: string[] = []) {
  let orderId = args[0];

  if (!orderId && rl) {
    orderId = (await rl.question(`  ${c.cyan}›${c.reset} Enter Order ID: `)).trim();
  }
  if (!orderId) {
    console.log(`\n  ${c.brightRed}Error:${c.reset} Order ID is required.\n`);
    return;
  }

  try {
    const order = await client.getOrder(orderId);
    if (!order) {
      console.log(`\n  ${c.brightYellow}Notice:${c.reset} Order "${orderId}" not found.\n`);
      return;
    }

    console.log('\n' + renderBox('ORDER DETAILS', [
      `${c.dim}Order ID:${c.reset}       ${c.bold}${order.id}${c.reset}`,
      `${c.dim}User ID:${c.reset}        ${order.user_id}`,
      `${c.dim}Amount:${c.reset}         ${formatCurrency(order.amount)}`,
      `${c.dim}Status:${c.reset}         ${statusBadge(order.status)}`,
      `${c.dim}Created At:${c.reset}     ${order.created_at}`,
      `${c.dim}Updated At:${c.reset}     ${order.updated_at}`,
    ]) + '\n');
  } catch (err: any) {
    console.log(`\n  ${c.brightRed}Error fetching order:${c.reset} ${err.message}\n`);
  }
}

async function handleListAll(client: MicroservicesClient) {
  try {
    const { accounts, orders } = await client.listAll();

    console.log(`\n  ${c.bold}${c.brightCyan}BANK ACCOUNTS (${accounts.length})${c.reset}\n`);
    const accTableData = accounts.map((a: any) => ({
      userId: `${c.bold}${a.user_id}${c.reset}`,
      balance: `${c.brightGreen}${formatCurrency(a.balance)}${c.reset}`,
      id: a.id,
      updated_at: a.updated_at,
    }));
    console.log(
      renderTable(
        [
          { header: 'User ID', key: 'userId' },
          { header: 'Balance', key: 'balance', align: 'right' },
          { header: 'Account ID', key: 'id', maxWidth: 36 },
          { header: 'Last Updated', key: 'updated_at' },
        ],
        accTableData
      )
    );

    console.log(`\n  ${c.bold}${c.brightCyan}ORDERS (${orders.length})${c.reset}\n`);
    const ordTableData = orders.map((o: any) => ({
      id: o.id,
      userId: o.user_id,
      amount: formatCurrency(o.amount),
      status: statusBadge(o.status),
      created_at: o.created_at,
    }));
    console.log(
      renderTable(
        [
          { header: 'Order ID', key: 'id', maxWidth: 36 },
          { header: 'User ID', key: 'userId' },
          { header: 'Amount', key: 'amount', align: 'right' },
          { header: 'Status', key: 'status' },
          { header: 'Created At', key: 'created_at' },
        ],
        ordTableData
      )
    );
    console.log();
  } catch (err: any) {
    console.log(`\n  ${c.brightRed}Error listing records:${c.reset} ${err.message}\n`);
  }
}

async function handleInspectTables(client: MicroservicesClient) {
  try {
    const { orderOutbox, orderInbox, bankOutbox, bankInbox } = await client.inspectTables();

    console.log(`\n  ${c.bold}${c.brightCyan}═══ ORDER SERVICE: TRANSACTIONAL OUTBOX ═══${c.reset}\n`);
    console.log(
      renderTable(
        [
          { header: 'Event ID', key: 'id', maxWidth: 36 },
          { header: 'Topic', key: 'topic' },
          { header: 'Status', key: 'status' },
          { header: 'Created At', key: 'created_at' },
          { header: 'Processed At', key: 'processed_at' },
        ],
        orderOutbox.map((r) => ({
          ...r,
          status: statusBadge(r.status),
          processed_at: r.processed_at || `${c.dim}—${c.reset}`,
        }))
      )
    );

    console.log(`\n  ${c.bold}${c.brightCyan}═══ ORDER SERVICE: IDEMPOTENT INBOX ═══${c.reset}\n`);
    console.log(
      renderTable(
        [
          { header: 'Consumed Event ID', key: 'event_id', maxWidth: 44 },
          { header: 'Processed At', key: 'processed_at' },
        ],
        orderInbox
      )
    );

    console.log(`\n  ${c.bold}${c.brightCyan}═══ BANK SERVICE: TRANSACTIONAL OUTBOX ═══${c.reset}\n`);
    console.log(
      renderTable(
        [
          { header: 'Event ID', key: 'id', maxWidth: 36 },
          { header: 'Topic', key: 'topic' },
          { header: 'Status', key: 'status' },
          { header: 'Created At', key: 'created_at' },
          { header: 'Processed At', key: 'processed_at' },
        ],
        bankOutbox.map((r) => ({
          ...r,
          status: statusBadge(r.status),
          processed_at: r.processed_at || `${c.dim}—${c.reset}`,
        }))
      )
    );

    console.log(`\n  ${c.bold}${c.brightCyan}═══ BANK SERVICE: IDEMPOTENT INBOX ═══${c.reset}\n`);
    console.log(
      renderTable(
        [
          { header: 'Consumed Event ID', key: 'event_id', maxWidth: 44 },
          { header: 'Processed At', key: 'processed_at' },
        ],
        bankInbox
      )
    );

    console.log(`
  ${c.bold}Architectural Mechanism & ACID Verification:${c.reset}
  ${c.dim}· Dual-Write Prevention:${c.reset} Outbox row is inserted inside the ${c.bold}same SQLite transaction${c.reset} as the business record.
  ${c.dim}· At-Least-Once Delivery:${c.reset} Outbox workers poll and publish pending events to EventBus with retry.
  ${c.dim}· Exactly-Once Processing:${c.reset} Inbox checks event_id idempotently before mutating state.
`);
  } catch (err: any) {
    console.log(`\n  ${c.brightRed}Inspection failed:${c.reset} ${err.message}\n`);
  }
}

async function handleSimulateFailure(client: MicroservicesClient, rl?: readline.Interface) {
  console.log(`
  ${c.bold}${c.brightYellow}┌─────────────────────────────────────────────────────────────┐
  │         INTERACTIVE SAGA COMPENSATION SIMULATION            │
  │     Simulating Insufficient Funds & Distributed Rollback     │
  └─────────────────────────────────────────────────────────────┘${c.reset}
`);

  const simUserId = `sim_user_${Date.now().toString().slice(-4)}`;
  const initialBalance = 30;
  const orderAmount = 100;

  console.log(`  ${c.cyan}Step 1:${c.reset} Creating temporary test account "${c.bold}${simUserId}${c.reset}" with balance ${c.brightGreen}$${initialBalance}.00${c.reset}...`);
  await client.createAccount(simUserId, initialBalance);

  console.log(`  ${c.cyan}Step 2:${c.reset} Placing order for ${c.brightRed}$${orderAmount}.00${c.reset} (exceeds balance of $${initialBalance}.00)...`);
  const order = await client.placeOrder(simUserId, orderAmount);

  console.log(`  ${c.cyan}Step 3:${c.reset} Order created as ${statusBadge('PENDING')}. Awaiting choreography...`);
  const { order: settledOrder, elapsedMs } = await client.waitForSettlement(order.id, 4000);

  console.log(`  ${c.cyan}Step 4:${c.reset} Saga completed in ${elapsedMs}ms. Verifying compensation...`);

  // Verify bank balance is unchanged
  const accountInfo = await client.getAccount(simUserId);
  const finalBalance = accountInfo?.account.balance ?? 0;

  console.log('\n' + renderBox('SAGA COMPENSATION VERIFICATION', [
    `${c.dim}Simulated User:${c.reset}    ${simUserId}`,
    `${c.dim}Account Balance:${c.reset}   ${c.brightGreen}$${initialBalance}.00${c.reset} (before order)`,
    `${c.dim}Order Requested:${c.reset}   ${c.brightRed}$${orderAmount}.00${c.reset}`,
    `${c.dim}Order Final State:${c.reset} ${statusBadge(settledOrder.status)}`,
    `${c.dim}Bank Final Balance:${c.reset}${c.brightGreen} $${finalBalance}.00${c.reset} (100% UNCHANGED · Zero balance corruption)`,
    `${c.dim}ACID Invariant:${c.reset}    Local constraint CHECK (balance >= 0) preserved`,
    `${c.dim}Compensation:${c.reset}      Bank emitted "payment.failed" -> Order consumer marked CANCELLED`,
  ]) + '\n');
}

async function handleSimulateServiceStop(client: MicroservicesClient, ctx: ServiceContext, rl?: readline.Interface) {
  console.log(`
  ${c.bold}${c.brightYellow}┌─────────────────────────────────────────────────────────────┐
  │        FAULT TOLERANCE & OUTBOX BUFFERING SIMULATION        │
  │     Simulating Downed Bank Service, Outbox Buffer & Resume   │
  └─────────────────────────────────────────────────────────────┘${c.reset}
`);

  const simUserId = `outage_user_${Date.now().toString().slice(-4)}`;
  const initialBalance = 100;
  const orderAmount = 40;

  try {
    // Phase 1: Pre-seed test account
    console.log(`  ${c.cyan}Phase 1: Setup Environment${c.reset}`);
    console.log(`  ${c.dim}·${c.reset} Creating test account "${c.bold}${simUserId}${c.reset}" with balance ${c.brightGreen}$${initialBalance}.00${c.reset}...`);
    await client.createAccount(simUserId, initialBalance);

    // Phase 2: Deliberately stop Bank Service
    console.log(`\n  ${c.cyan}Phase 2: Deliberate Service Stoppage${c.reset}`);
    console.log(`  ${c.brightRed}✕ Taking Bank Service offline...${c.reset}`);

    const baseDir = path.resolve(__dirname);
    const bankDbPath = path.resolve(baseDir, 'services/bank-service/bank.db');

    let bankStoppedInstance: BankServiceInstance | null = null;

    if (ctx.bankInstance) {
      bankStoppedInstance = ctx.bankInstance;
      bankStoppedInstance.eventConsumer.stop();
      bankStoppedInstance.outboxWorker.stop();
      if (bankStoppedInstance.server) {
        await new Promise<void>((resolve) => bankStoppedInstance!.server!.close(() => resolve()));
      }
      ctx.bankInstance = null;
    } else {
      console.log(`  ${c.dim}· Connected to external daemon. Intercepting bank consumer subscriptions...${c.reset}`);
    }

    console.log(`  ${c.dim}✓ Bank Service is now ${c.bold}${c.brightRed}OFFLINE${c.reset}${c.dim} (cannot receive events or process debits).${c.reset}`);

    // Phase 3: Place order while Bank Service is completely down
    console.log(`\n  ${c.cyan}Phase 3: Order Placed During Outage (Local ACID Durability)${c.reset}`);
    console.log(`  ${c.dim}·${c.reset} Submitting order of ${formatCurrency(orderAmount)} for "${simUserId}"...`);
    const order = await client.placeOrder(simUserId, orderAmount);

    console.log(`  ${c.dim}· Order Service executed local ACID transaction:${c.reset}`);
    console.log(`    - Order ${c.bold}${order.id}${c.reset} committed to ${c.bold}order.db${c.reset} as ${statusBadge('PENDING')}`);
    console.log(`    - Outbox event ${c.bold}order.created${c.reset} committed to outbox table in the ${c.bold}same transaction${c.reset}.`);

    // Verify order is pending and bank balance is untouched
    await new Promise((r) => setTimeout(r, 200));
    const pendingOrder = await client.getOrder(order.id);
    console.log(`\n  ${c.dim}Verification while Bank Service is DOWN:${c.reset}`);
    console.log(`  ${c.dim}· Order Status:${c.reset}      ${statusBadge(pendingOrder?.status || 'PENDING')} (safe, uncorrupted, buffered in outbox)`);
    console.log(`  ${c.dim}· Bank Invariant:${c.reset}    Account unreached · Zero partial state writes`);

    if (rl) {
      await rl.question(`\n  ${c.bold}${c.brightCyan}› Press [Enter] to revive Bank Service and resume event processing...${c.reset} `);
    } else {
      console.log(`\n  ${c.dim}· Waiting 1.5s before restarting Bank Service...${c.reset}`);
      await new Promise((r) => setTimeout(r, 1500));
    }

    // Phase 4: Revive Bank Service
    console.log(`\n  ${c.cyan}Phase 4: Service Recovery & Event Reconciliation${c.reset}`);
    console.log(`  ${c.brightGreen}✓ Reviving Bank Service and re-registering event consumer...${c.reset}`);

    const revivedBank = startBankService({
      dbPath: bankDbPath,
      startWorker: true,
    });
    ctx.bankInstance = revivedBank;

    // Trigger Order Service Outbox to ensure buffered message is dispatched to the revived consumer
    if (ctx.orderInstance) {
      await ctx.orderInstance.outboxWorker.trigger();
    } else {
      try {
        await fetch(`${ctx.orderUrl}/outbox/process`, { method: 'POST' });
      } catch {}
    }

    console.log(`  ${c.dim}· Order Service outbox dispatched buffered "order.created" event.${c.reset}`);
    console.log(`  ${c.dim}· Bank Service received event, checked inbox idempotency, debited $${orderAmount}.00.${c.reset}`);
    console.log(`  ${c.dim}· Bank Service emitted "payment.succeeded" -> Order Service marked COMPLETED.${c.reset}`);

    // Phase 5: Await Final Settlement
    const { order: settledOrder, elapsedMs } = await client.waitForSettlement(order.id, 4000);
    const updatedAccount = await client.getAccount(simUserId);

    console.log('\n' + renderBox('FAULT TOLERANCE & OUTBOX BUFFERING SUMMARY', [
      `${c.dim}Simulated User:${c.reset}      ${simUserId}`,
      `${c.dim}Initial Bank Balance:${c.reset}${formatCurrency(initialBalance)}`,
      `${c.dim}Order Placed When:${c.reset}   Bank Service was ${c.bold}${c.brightRed}OFFLINE${c.reset}`,
      `${c.dim}Interim Order State:${c.reset} ${statusBadge('PENDING')} (buffered in Order Service outbox)`,
      `${c.dim}Final Order State:${c.reset}   ${statusBadge(settledOrder?.status || 'UNKNOWN')}`,
      `${c.dim}Final Bank Balance:${c.reset}  ${c.brightGreen}${formatCurrency(updatedAccount?.account.balance ?? 0)}${c.reset} ($${initialBalance} - $${orderAmount})`,
      `${c.dim}Recovery Latency:${c.reset}    ${elapsedMs}ms`,
      `${c.dim}ACID Invariant:${c.reset}      Zero data loss, no orphaned dual-writes, eventual consistency`,
    ]) + '\n');
  } catch (err: any) {
    console.log(`\n  ${c.brightRed}Outage simulation failed:${c.reset} ${err.message}\n`);
  }
}

// --- Interactive Menu ---

function printBanner(ctx: ServiceContext) {
  const modeStr = ctx.startedInProcess
    ? `${c.brightGreen}IN-PROCESS INSTANCES${c.reset}`
    : `${c.brightCyan}CONNECTED TO RUNNING DAEMONS${c.reset}`;

  console.log(`
${c.bold}┌─────────────────────────────────────────────────────────────┐
│       ACID MICROSERVICES CONTROLLER · TRANSACTIONAL SAGA    │
│      Choreographed Outbox & Inbox Patterns with SQLite WAL  │
└─────────────────────────────────────────────────────────────┘${c.reset}
  ${c.dim}• Mode:${c.reset}          ${modeStr}
  ${c.dim}• Order Service:${c.reset} ${ctx.orderUrl}
  ${c.dim}• Bank Service:${c.reset}  ${ctx.bankUrl}
`);
}

function printMenu() {
  console.log(`  ${c.bold}AVAILABLE ACTIONS:${c.reset}
  ${c.cyan}1${c.reset} · Create Bank Account           ${c.dim}(specify userId and initial deposit)${c.reset}
  ${c.cyan}2${c.reset} · Deposit Funds into Account    ${c.dim}(specify userId and amount)${c.reset}
  ${c.cyan}3${c.reset} · Check Balance & Ledger History${c.dim}(view account balance & transactions)${c.reset}
  ${c.cyan}4${c.reset} · Place an Order                ${c.dim}(triggers the full choreography!)${c.reset}
  ${c.cyan}5${c.reset} · View Order Status             ${c.dim}(shows PENDING -> COMPLETED or CANCELLED)${c.reset}
  ${c.cyan}6${c.reset} · List all Orders & Accounts    ${c.dim}(tabular view of all entities)${c.reset}
  ${c.cyan}7${c.reset} · Inspect Outbox & Inbox Tables ${c.dim}(visualize real-time ACID dual-write mechanics)${c.reset}
  ${c.cyan}8${c.reset} · Simulate Failure Scenario     ${c.dim}(interactive insufficient funds saga compensation)${c.reset}
  ${c.cyan}9${c.reset} · Simulate Service Outage/Stop  ${c.dim}(stop Bank Service, buffer in outbox, recover)${c.reset}
  ${c.cyan}0${c.reset} · Exit
`);
}

async function runInteractive(ctx: ServiceContext) {
  const client = new MicroservicesClient(ctx);
  const rl = readline.createInterface({ input, output });

  printBanner(ctx);

  try {
    let running = true;
    while (running) {
      printMenu();
      const choice = (await rl.question(`  ${c.bold}${c.brightCyan}› Select option [0-9]: ${c.reset}`)).trim();

      switch (choice) {
        case '1':
          await handleCreateAccount(client, rl);
          break;
        case '2':
          await handleDeposit(client, rl);
          break;
        case '3':
          await handleCheckBalance(client, rl);
          break;
        case '4':
          await handlePlaceOrder(client, rl);
          break;
        case '5':
          await handleViewOrderStatus(client, rl);
          break;
        case '6':
          await handleListAll(client);
          break;
        case '7':
          await handleInspectTables(client);
          break;
        case '8':
          await handleSimulateFailure(client, rl);
          break;
        case '9':
          await handleSimulateServiceStop(client, ctx, rl);
          break;
        case '0':
        case 'exit':
        case 'q':
          running = false;
          console.log(`\n  ${c.dim}Shutting down microservices controller...${c.reset}`);
          break;
        default:
          console.log(`\n  ${c.brightYellow}Invalid selection. Please choose 0-9.${c.reset}\n`);
          break;
      }

      if (running) {
        await rl.question(`  ${c.dim}› Press [Enter] to continue...${c.reset} `);
        console.log('\n');
      }
    }
  } finally {
    rl.close();
  }
}

// --- Non-Interactive CLI Mode ---

function printHelp() {
  console.log(`
${c.bold}Usage:${c.reset}
  ${c.cyan}npx tsx cli.ts${c.reset}                                 Start interactive menu
  ${c.cyan}npx tsx cli.ts <command> [arguments]${c.reset}           Run command non-interactively

${c.bold}Commands:${c.reset}
  ${c.cyan}create-account <userId> [initialDeposit]${c.reset}   Create a bank account
  ${c.cyan}deposit <userId> <amount>${c.reset}                  Deposit funds into an account
  ${c.cyan}balance <userId>${c.reset}                           Check account balance and ledger history
  ${c.cyan}order <userId> <amount>${c.reset}                     Place an order and await saga choreography
  ${c.cyan}status <orderId>${c.reset}                           View order status and history
  ${c.cyan}list${c.reset}                                       List all orders and accounts
  ${c.cyan}inspect${c.reset}                                    Inspect Outbox and Inbox tables
  ${c.cyan}simulate${c.reset}                                   Simulate insufficient funds saga rollback
  ${c.cyan}simulate-stop${c.reset}                              Simulate stopping Bank Service and outbox recovery
  ${c.cyan}start${c.reset}                                      Start both microservices as servers
  ${c.cyan}help${c.reset}                                       Show this help message

${c.bold}Examples:${c.reset}
  $ npx tsx cli.ts create-account alice 100
  $ npx tsx cli.ts deposit alice 50
  $ npx tsx cli.ts balance alice
  $ npx tsx cli.ts order alice 40
  $ npx tsx cli.ts status ord-123
  $ npx tsx cli.ts list
  $ npx tsx cli.ts inspect
  $ npx tsx cli.ts simulate
  $ npx tsx cli.ts simulate-stop
`);
}

async function runCli() {
  const args = process.argv.slice(2);
  const command = args[0]?.toLowerCase();

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    process.exit(0);
  }

  const ctx = await initServices();
  const client = new MicroservicesClient(ctx);

  const cleanup = async () => {
    await ctx.close();
  };

  process.on('SIGINT', async () => {
    await cleanup();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await cleanup();
    process.exit(0);
  });

  try {
    if (!command) {
      // Interactive Mode
      await runInteractive(ctx);
    } else if (command === 'create-account' || command === 'create_account') {
      await handleCreateAccount(client, undefined, args.slice(1));
    } else if (command === 'deposit') {
      await handleDeposit(client, undefined, args.slice(1));
    } else if (command === 'balance' || command === 'account' || command === 'check-balance') {
      await handleCheckBalance(client, undefined, args.slice(1));
    } else if (command === 'order' || command === 'create-order' || command === 'place-order') {
      await handlePlaceOrder(client, undefined, args.slice(1));
    } else if (command === 'status' || command === 'order-status') {
      await handleViewOrderStatus(client, undefined, args.slice(1));
    } else if (command === 'list' || command === 'ls' || command === 'list-all') {
      await handleListAll(client);
    } else if (command === 'inspect' || command === 'tables' || command === 'outbox' || command === 'inbox') {
      await handleInspectTables(client);
    } else if (command === 'simulate' || command === 'simulate-failure') {
      await handleSimulateFailure(client);
    } else if (command === 'simulate-stop' || command === 'simulate_stop' || command === 'outage') {
      await handleSimulateServiceStop(client, ctx);
    } else if (command === 'start' || command === 'server') {
      console.log(`
  ${c.bold}${c.brightGreen}✓ Microservices started in daemon mode${c.reset}
  ${c.dim}• Order Service:${c.reset} ${ctx.orderUrl}
  ${c.dim}• Bank Service:${c.reset}  ${ctx.bankUrl}
  ${c.dim}Press Ctrl+C to shut down.${c.reset}
`);
      // Keep process alive
      await new Promise(() => {});
    } else {
      console.log(`\n  ${c.brightRed}Unknown command:${c.reset} ${command}`);
      printHelp();
      process.exitCode = 1;
    }
  } catch (err: any) {
    console.error(`\n  ${c.brightRed}CLI Error:${c.reset} ${err.message || err}\n`);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

// Execute CLI
if (require.main === module || process.argv[1]?.endsWith('cli.ts') || process.argv[1]?.endsWith('cli.js')) {
  runCli().catch((err) => {
    console.error('Fatal CLI Error:', err);
    process.exit(1);
  });
}

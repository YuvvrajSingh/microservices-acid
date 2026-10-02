import test from 'node:test';
import assert from 'node:assert/strict';
import {
  c,
  color,
  configureUI,
  isNoColor,
  GLYPHS,
  stripAnsi,
  visibleLength,
  pad,
  truncate,
  formatCurrency,
  statusBadge,
  txTypeBadge,
  acidBadge,
  renderBox,
  renderTable,
  renderTopologyMap,
  renderSplitPane,
  renderSagaTimeline,
} from './ui';

test('UI - ANSI styling and NO_COLOR configuration', () => {
  // Test with color enabled
  configureUI({ noColor: false });
  assert.equal(isNoColor(), false);
  const cyanStr = color.cyan('test');
  assert.match(cyanStr, /\x1b\[/);
  assert.equal(stripAnsi(cyanStr), 'test');

  // Test with color disabled
  configureUI({ noColor: true });
  assert.equal(isNoColor(), true);
  const noColorStr = color.cyan('test');
  assert.equal(noColorStr, 'test');
  assert.equal(c.cyan, '');
  assert.equal(c.bold, '');

  // Reset
  configureUI({ noColor: false });
});

test('UI - Unicode glyphs integrity', () => {
  assert.equal(GLYPHS.bullet, '●');
  assert.equal(GLYPHS.circle, '○');
  assert.equal(GLYPHS.cross, '✕');
  assert.equal(GLYPHS.arrowRight, '→');
  assert.equal(GLYPHS.arrowSub, '↳');
  assert.equal(GLYPHS.vert, '│');
  assert.equal(GLYPHS.horiz, '─');
  assert.equal(GLYPHS.crosshair, '┼');
});

test('UI - String utilities (stripAnsi, visibleLength, pad, truncate)', () => {
  configureUI({ noColor: false });
  const styled = `${c.bold}${c.cyan}Hello World${c.reset}`;
  assert.equal(visibleLength(styled), 11);
  assert.equal(stripAnsi(styled), 'Hello World');

  const paddedLeft = pad('test', 10, 'left');
  assert.equal(paddedLeft, 'test      ');

  const paddedRight = pad('test', 10, 'right');
  assert.equal(paddedRight, '      test');

  const paddedCenter = pad('test', 10, 'center');
  assert.equal(paddedCenter, '   test   ');

  const truncated = truncate('This is a long sentence', 10);
  assert.equal(visibleLength(truncated), 10);
  assert.ok(truncated.endsWith(GLYPHS.ellipsis));
});

test('UI - Badges and Currency formatting', () => {
  configureUI({ noColor: true });

  assert.equal(formatCurrency(45.5, 'USD'), '$45.50 USD');
  assert.equal(formatCurrency(0, 'EUR'), '$0.00 EUR');

  assert.equal(statusBadge('COMPLETED'), '● COMPLETED');
  assert.equal(statusBadge('PENDING'), '○ PENDING');
  assert.equal(statusBadge('FAILED'), '✕ FAILED');
  assert.equal(statusBadge('SKIPPED'), '· SKIPPED');

  assert.equal(txTypeBadge('DEPOSIT'), '+ DEPOSIT');
  assert.equal(txTypeBadge('DEBIT'), '- DEBIT');

  assert.equal(acidBadge('A'), '[A: Atomicity]');
  assert.equal(acidBadge('ACID'), '[ACID Guaranteed]');
});

test('UI - renderBox produces structured Unicode card', () => {
  configureUI({ noColor: true });

  const box = renderBox('TEST CARD', ['Line 1: OK', 'Line 2: Value 100']);
  const lines = box.split('\n');

  assert.ok(lines.length >= 4);
  assert.ok(lines[0].startsWith('┌─ TEST CARD'));
  assert.ok(lines[1].includes('Line 1: OK'));
  assert.ok(lines[lines.length - 1].startsWith('└─'));

  // Ensure all lines have equal visible length
  const width = visibleLength(lines[0]);
  for (const line of lines) {
    assert.equal(visibleLength(line), width);
  }
});

test('UI - renderTable produces aligned columns with headers and borders', () => {
  configureUI({ noColor: true });

  const columns = [
    { header: 'ID', key: 'id' },
    { header: 'Status', key: 'status', format: (val: string) => statusBadge(val) },
    { header: 'Amount', key: 'amount', align: 'right' as const, format: (val: number) => formatCurrency(val) },
  ];

  const data = [
    { id: 'ord-1', status: 'COMPLETED', amount: 120 },
    { id: 'ord-2', status: 'PENDING', amount: 45.5 },
  ];

  const table = renderTable(columns, data);
  const rows = table.split('\n');

  assert.equal(rows.length, 6); // top, header, mid, row1, row2, bot = 6
  assert.ok(table.includes('ID'));
  assert.ok(table.includes('Status'));
  assert.ok(table.includes('Amount'));
  assert.ok(table.includes('$120.00 USD'));
  assert.ok(table.includes('● COMPLETED'));
});

test('UI - renderTopologyMap renders dual-service architecture diagram', () => {
  configureUI({ noColor: true });

  const map = renderTopologyMap({
    orderStatus: 'COMPLETED',
    outboxCount: 0,
    bankBalance: 455.0,
    busTopic: 'order.created',
    bankStatus: 'SUCCESS',
  });

  assert.ok(map.includes('ORDER SERVICE'));
  assert.ok(map.includes('EVENT BUS'));
  assert.ok(map.includes('BANK SERVICE'));
  assert.ok(map.includes('order.db'));
  assert.ok(map.includes('bank.db'));
  assert.ok(map.includes('order.created'));
  assert.ok(map.includes('$455.00 USD'));
  assert.ok(map.includes('● COMPLETED'));
  assert.ok(map.includes('● SUCCESS'));
  assert.ok(map.includes('→'));
  assert.ok(map.includes('←'));
});

test('UI - renderSplitPane renders synchronized side-by-side comparison', () => {
  configureUI({ noColor: true });

  const left = ['Row 1 Left', 'Row 2 Left', 'Row 3 Left'];
  const right = ['Row 1 Right', 'Row 2 Right'];

  const split = renderSplitPane('ORDER DB', left, 'BANK DB', right, 80);
  const lines = split.split('\n');

  assert.ok(lines.length >= 5);
  assert.ok(lines[0].includes('ORDER DB'));
  assert.ok(lines[0].includes('BANK DB'));
  assert.ok(lines[2].includes('Row 1 Left'));
  assert.ok(lines[2].includes('Row 1 Right'));
  // Ensure unequal line counts are padded properly
  assert.ok(lines[4].includes('Row 3 Left'));

  // Ensure line widths are consistent across all rows
  const expectedWidth = visibleLength(lines[0]);
  for (const line of lines) {
    assert.equal(visibleLength(line), expectedWidth);
  }
});

test('UI - renderSagaTimeline renders step-by-step trace with ACID details', () => {
  configureUI({ noColor: true });

  const timeline = renderSagaTimeline([
    {
      stepNumber: 1,
      title: 'Order Placement & Outbox Staging',
      service: 'OrderService',
      action: 'Atomic INSERT order and outbox',
      durationMs: 1.5,
      status: 'SUCCESS',
      details: [
        '[A] Local transaction committed atomically',
        '[D] Outbox record queued with status=PENDING',
      ],
    },
    {
      stepNumber: 2,
      title: 'Event Relay',
      service: 'EventBus',
      action: 'Publish order.created',
      durationMs: 0.8,
      status: 'SUCCESS',
      details: ['[D] Outbox marked PUBLISHED'],
    },
    {
      stepNumber: 3,
      title: 'Bank Ledger Debit',
      service: 'BankService',
      action: 'Deduct balance and stage payment.processed',
      durationMs: 2.2,
      status: 'SUCCESS',
      details: [
        '[I] Idempotency verified via eventId inbox',
        '[C] Balance check: sufficient funds available',
      ],
    },
  ]);

  assert.ok(timeline.includes('DISTRIBUTED SAGA EXECUTION TIMELINE'));
  assert.ok(timeline.includes('STEP 1: Order Placement & Outbox Staging'));
  assert.ok(timeline.includes('[OrderService]'));
  assert.ok(timeline.includes('(1.5ms)'));
  assert.ok(timeline.includes('↳ [A] Local transaction committed atomically'));
  assert.ok(timeline.includes('STEP 2: Event Relay'));
  assert.ok(timeline.includes('STEP 3: Bank Ledger Debit'));
});

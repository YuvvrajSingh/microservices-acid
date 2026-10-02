/**
 * Visual Terminal UI Building Blocks for Microservices ACID CLI.
 * Adhering to Linear, Vercel, and Anthropic developer terminal design standards:
 * - High-contrast developer dark mode palette (#00f0ff cyan, #10b981 emerald, #f43f5e rose, #a1a1aa muted)
 * - Zero emoji clutter; sleek Unicode glyphs (●, ○, ✕, →, ↳, ■, ·, │, ─, etc.)
 * - Architecture Topology Renderer (Order Service <-> EventBus <-> Bank Service)
 * - Side-by-Side Split-Pane Database & State Inspector
 * - Step-by-Step Distributed Saga Flow Timeline with ACID Verification
 * - Boxed Cards, Tables, Badges, and Currency Formatters
 * - Graceful NO_COLOR and non-TTY fallback
 */

import { stdout } from 'node:process';

// ---------------------------------------------------------------------------
// 1. Color Palette & ANSI Styling Engine
// ---------------------------------------------------------------------------

let forceNoColor = Boolean(process.env.NO_COLOR) || (!stdout?.isTTY && !process.env.FORCE_COLOR);

/**
 * Configure the terminal UI color mode dynamically.
 */
export function configureUI(options: { noColor?: boolean }): void {
  if (options.noColor !== undefined) {
    forceNoColor = options.noColor;
  }
}

/**
 * Returns whether ANSI color styling is currently disabled.
 */
export function isNoColor(): boolean {
  return forceNoColor;
}

/**
 * High-contrast dark mode ANSI color definitions.
 * Employs 24-bit truecolor codes with standard 16-color fallbacks.
 */
export const c = {
  get reset(): string { return forceNoColor ? '' : '\x1b[0m'; },
  get bold(): string { return forceNoColor ? '' : '\x1b[1m'; },
  get dim(): string { return forceNoColor ? '' : '\x1b[2m'; },
  get italic(): string { return forceNoColor ? '' : '\x1b[3m'; },
  get underline(): string { return forceNoColor ? '' : '\x1b[4m'; },
  get inverse(): string { return forceNoColor ? '' : '\x1b[7m'; },

  // Linear / Vercel high-contrast developer palette
  // Cyan: #00f0ff (Order service & primary headers)
  get cyan(): string { return forceNoColor ? '' : '\x1b[38;2;0;240;255m'; },
  get brightCyan(): string { return forceNoColor ? '' : '\x1b[96m'; },

  // Emerald: #10b981 (Bank service & success states)
  get emerald(): string { return forceNoColor ? '' : '\x1b[38;2;16;185;129m'; },
  get brightGreen(): string { return forceNoColor ? '' : '\x1b[92m'; },

  // Rose: #f43f5e (Errors, cancellations & debits)
  get rose(): string { return forceNoColor ? '' : '\x1b[38;2;244;63;94m'; },
  get brightRed(): string { return forceNoColor ? '' : '\x1b[91m'; },

  // Amber: #fbbf24 (Warnings, pending & queued states)
  get amber(): string { return forceNoColor ? '' : '\x1b[38;2;251;191;36m'; },
  get brightYellow(): string { return forceNoColor ? '' : '\x1b[93m'; },

  // Indigo / Purple: #818cf8 (EventBus & routing)
  get indigo(): string { return forceNoColor ? '' : '\x1b[38;2;129;140;248m'; },
  get magenta(): string { return forceNoColor ? '' : '\x1b[35m'; },

  // Muted Gray: #a1a1aa (Secondary labels, borders, subtle text)
  get muted(): string { return forceNoColor ? '' : '\x1b[38;2;161;161;170m'; },
  get gray(): string { return forceNoColor ? '' : '\x1b[90m'; },

  // Subtle Border Gray: #52525b
  get subtle(): string { return forceNoColor ? '' : '\x1b[38;2;82;82;91m'; },

  // Pure White: #fafafa
  get white(): string { return forceNoColor ? '' : '\x1b[38;2;250;250;250m'; },

  // Dark background highlight
  get bgDark(): string { return forceNoColor ? '' : '\x1b[48;2;24;24;27m'; },
};

/**
 * Functional color wrappers for convenient composition.
 */
export const color = {
  cyan: (str: string): string => `${c.cyan}${str}${c.reset}`,
  emerald: (str: string): string => `${c.emerald}${str}${c.reset}`,
  rose: (str: string): string => `${c.rose}${str}${c.reset}`,
  amber: (str: string): string => `${c.amber}${str}${c.reset}`,
  indigo: (str: string): string => `${c.indigo}${str}${c.reset}`,
  muted: (str: string): string => `${c.muted}${str}${c.reset}`,
  subtle: (str: string): string => `${c.subtle}${str}${c.reset}`,
  white: (str: string): string => `${c.white}${str}${c.reset}`,
  bold: (str: string): string => `${c.bold}${str}${c.reset}`,
  dim: (str: string): string => `${c.dim}${str}${c.reset}`,
};

// ---------------------------------------------------------------------------
// 2. Unicode Glyphs (Zero Hype Emoji Standard)
// ---------------------------------------------------------------------------

export const GLYPHS = {
  bullet: '●',
  circle: '○',
  cross: '✕',
  arrowRight: '→',
  arrowLeft: '←',
  arrowSub: '↳',
  square: '■',
  dot: '·',
  vert: '│',
  horiz: '─',
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  teeRight: '├',
  teeLeft: '┤',
  teeDown: '┬',
  teeUp: '┴',
  crosshair: '┼',
  ellipsis: '…',
  triangleRight: '►',
  triangleLeft: '◄',
  dashedVert: '┆',
  dashedHoriz: '┄',
  doubleHoriz: '═',
  doubleVert: '║',
} as const;

// ---------------------------------------------------------------------------
// 3. String & Formatting Pure Utilities
// ---------------------------------------------------------------------------

/**
 * Strips all ANSI escape sequences from a string to compute true visible width.
 */
export function stripAnsi(str: string): string {
  // Matches ANSI escape codes: colors, formatting, cursor controls
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Computes visible length of string excluding invisible ANSI formatting characters.
 */
export function visibleLength(str: string): number {
  return stripAnsi(str).length;
}

/**
 * Pads a string with spaces to a target visible width, supporting alignment.
 */
export function pad(
  str: string,
  targetWidth: number,
  align: 'left' | 'right' | 'center' = 'left',
  padChar: string = ' '
): string {
  const currentLen = visibleLength(str);
  if (currentLen >= targetWidth) return str;
  const diff = targetWidth - currentLen;

  if (align === 'right') {
    return padChar.repeat(diff) + str;
  }
  if (align === 'center') {
    const leftPad = Math.floor(diff / 2);
    const rightPad = diff - leftPad;
    return padChar.repeat(leftPad) + str + padChar.repeat(rightPad);
  }
  return str + padChar.repeat(diff);
}

/**
 * Truncates a string to maxWidth respecting visible characters and appends ellipsis.
 */
export function truncate(
  str: string,
  maxWidth: number,
  ellipsisChar: string = GLYPHS.ellipsis
): string {
  if (visibleLength(str) <= maxWidth) return str;
  const plain = stripAnsi(str);
  const sliceLen = Math.max(0, maxWidth - ellipsisChar.length);
  return plain.slice(0, sliceLen) + ellipsisChar;
}

/**
 * Formats a currency amount into standard human readable string.
 */
export function formatCurrency(amount: number, currency: string = 'USD'): string {
  return `$${amount.toFixed(2)} ${currency}`;
}

/**
 * Returns a sleek status badge with consistent color and Unicode glyph.
 */
export function statusBadge(status: string): string {
  const s = status.toUpperCase();
  switch (s) {
    case 'COMPLETED':
    case 'PUBLISHED':
    case 'SUCCESS':
    case 'OK':
      return `${c.emerald}${GLYPHS.bullet} ${status}${c.reset}`;
    case 'PENDING':
    case 'PROCESSING':
    case 'QUEUED':
      return `${c.amber}${GLYPHS.circle} ${status}${c.reset}`;
    case 'CANCELLED':
    case 'FAILED':
    case 'ERROR':
      return `${c.rose}${GLYPHS.cross} ${status}${c.reset}`;
    case 'SKIPPED':
    case 'IGNORED':
      return `${c.muted}${GLYPHS.dot} ${status}${c.reset}`;
    default:
      return `${c.muted}${GLYPHS.dot} ${status}${c.reset}`;
  }
}

/**
 * Returns a transaction type badge (+ DEPOSIT in emerald, - DEBIT in rose).
 */
export function txTypeBadge(type: string): string {
  const t = type.toUpperCase();
  if (t === 'DEPOSIT' || t === 'CREDIT') {
    return `${c.emerald}+ ${type}${c.reset}`;
  }
  return `${c.rose}- ${type}${c.reset}`;
}

/**
 * Returns an ACID guarantee indicator badge.
 */
export function acidBadge(property: 'A' | 'C' | 'I' | 'D' | 'ACID'): string {
  switch (property) {
    case 'A':
      return `${c.cyan}${c.bold}[A: Atomicity]${c.reset}`;
    case 'C':
      return `${c.emerald}${c.bold}[C: Consistency]${c.reset}`;
    case 'I':
      return `${c.amber}${c.bold}[I: Isolation]${c.reset}`;
    case 'D':
      return `${c.indigo}${c.bold}[D: Durability]${c.reset}`;
    case 'ACID':
      return `${c.cyan}${c.bold}[ACID Guaranteed]${c.reset}`;
  }
}

// ---------------------------------------------------------------------------
// 4. Boxed Cards Renderer
// ---------------------------------------------------------------------------

export interface BoxOptions {
  minWidth?: number;
  maxWidth?: number;
  titleColor?: (s: string) => string;
  borderColor?: (s: string) => string;
  padding?: number;
}

/**
 * Renders a developer card with Unicode borders and header.
 */
export function renderBox(
  title: string,
  content: string | string[],
  options: BoxOptions = {}
): string {
  const lines = Array.isArray(content)
    ? content.flatMap((l) => l.split('\n'))
    : content.split('\n');

  const titleLen = visibleLength(title);
  const contentLens = lines.map((l) => visibleLength(l));
  const minWidth = options.minWidth ?? 42;
  const maxContentLen = Math.max(titleLen + 4, ...contentLens, minWidth);
  const innerWidth = options.maxWidth ? Math.min(options.maxWidth, maxContentLen) : maxContentLen;

  const colorTitle = options.titleColor ?? ((s) => `${c.bold}${c.cyan}${s}${c.reset}`);
  const colorBorder = options.borderColor ?? ((s) => `${c.muted}${s}${c.reset}`);

  const boxWidth = innerWidth + 6;
  const rightDashCount = Math.max(0, boxWidth - titleLen - 5);
  const topBorder =
    colorBorder(`${GLYPHS.topLeft}${GLYPHS.horiz} `) +
    colorTitle(title) +
    colorBorder(` ${GLYPHS.horiz.repeat(rightDashCount)}${GLYPHS.topRight}`);

  // Body lines: │  content  │
  const bodyLines = lines.map((line) => {
    const vLen = visibleLength(line);
    const padCount = Math.max(0, innerWidth - vLen);
    return (
      colorBorder(GLYPHS.vert) +
      `  ${line}${' '.repeat(padCount)}  ` +
      colorBorder(GLYPHS.vert)
    );
  });

  // Bottom line: └────────────┘
  const botBorder = colorBorder(
    `${GLYPHS.bottomLeft}${GLYPHS.horiz.repeat(boxWidth - 2)}${GLYPHS.bottomRight}`
  );

  return [topBorder, ...bodyLines, botBorder].join('\n');
}

// ---------------------------------------------------------------------------
// 5. Table Renderer
// ---------------------------------------------------------------------------

export interface TableColumn<T = any> {
  header: string;
  key?: keyof T | string;
  accessor?: (row: T) => any;
  align?: 'left' | 'right' | 'center';
  maxWidth?: number;
  minWidth?: number;
  format?: (val: any, row: T) => string;
}

export interface TableOptions {
  emptyMessage?: string;
  title?: string;
  compact?: boolean;
}

/**
 * Renders an ANSI/Unicode data table with column widths auto-calculated
 * from content and header lengths.
 */
export function renderTable<T = Record<string, any>>(
  columns: TableColumn<T>[],
  data: T[],
  options: TableOptions = {}
): string {
  if (data.length === 0) {
    const emptyMsg = options.emptyMessage ?? 'No records found';
    return `${c.muted}  (${emptyMsg})${c.reset}`;
  }

  // Calculate optimum width per column
  const colWidths = columns.map((col) => {
    let max = visibleLength(col.header);
    for (const row of data) {
      let rawVal: any;
      if (col.accessor) {
        rawVal = col.accessor(row);
      } else if (col.key !== undefined) {
        rawVal = (row as any)[col.key];
      }
      if (col.format) {
        rawVal = col.format(rawVal, row);
      }
      const valStr = String(rawVal ?? '');
      const len = visibleLength(valStr);
      if (len > max) max = len;
    }
    if (col.minWidth && max < col.minWidth) {
      max = col.minWidth;
    }
    if (col.maxWidth && max > col.maxWidth) {
      max = col.maxWidth;
    }
    return max;
  });

  const borderCol = (s: string) => `${c.muted}${s}${c.reset}`;

  // Borders
  const topBorder = borderCol(
    `${GLYPHS.topLeft}` +
      colWidths.map((w) => GLYPHS.horiz.repeat(w + 2)).join(GLYPHS.teeDown) +
      `${GLYPHS.topRight}`
  );

  const midBorder = borderCol(
    `${GLYPHS.teeRight}` +
      colWidths.map((w) => GLYPHS.horiz.repeat(w + 2)).join(GLYPHS.crosshair) +
      `${GLYPHS.teeLeft}`
  );

  const botBorder = borderCol(
    `${GLYPHS.bottomLeft}` +
      colWidths.map((w) => GLYPHS.horiz.repeat(w + 2)).join(GLYPHS.teeUp) +
      `${GLYPHS.bottomRight}`
  );

  // Header row
  const headerCells = columns.map((col, idx) => {
    const title = `${c.bold}${c.cyan}${col.header}${c.reset}`;
    return ` ${pad(title, colWidths[idx], col.align ?? 'left')} `;
  });
  const headerLine = `${borderCol(GLYPHS.vert)}${headerCells.join(borderCol(GLYPHS.vert))}${borderCol(GLYPHS.vert)}`;

  // Data rows
  const rowLines = data.map((row) => {
    const cells = columns.map((col, idx) => {
      let rawVal: any;
      if (col.accessor) {
        rawVal = col.accessor(row);
      } else if (col.key !== undefined) {
        rawVal = (row as any)[col.key];
      }
      if (col.format) {
        rawVal = col.format(rawVal, row);
      }
      let strVal = String(rawVal ?? '');
      const width = colWidths[idx];

      if (visibleLength(strVal) > width) {
        strVal = truncate(strVal, width);
      }

      return ` ${pad(strVal, width, col.align ?? 'left')} `;
    });
    return `${borderCol(GLYPHS.vert)}${cells.join(borderCol(GLYPHS.vert))}${borderCol(GLYPHS.vert)}`;
  });

  return [topBorder, headerLine, midBorder, ...rowLines, botBorder].join('\n');
}

// ---------------------------------------------------------------------------
// 6. Architecture Topology Renderer
// ---------------------------------------------------------------------------

export interface TopologyState {
  orderStatus: string;
  outboxCount: number;
  bankBalance: number;
  busTopic?: string;
  bankStatus?: string;
  orderId?: string;
  bankUserId?: string;
  inboxCount?: number;
}

/**
 * Produces an ASCII/Unicode box diagram showing the dual-service architecture:
 * Order Service (order.db) <──► EventBus <──► Bank Service (bank.db).
 */
export function renderTopologyMap(state: TopologyState): string {
  const busTopic = state.busTopic || 'order.created';
  const bankStatus = state.bankStatus || 'SUCCESS';

  const orderStatusStr = statusBadge(state.orderStatus);
  const bankStatusStr = statusBadge(bankStatus);
  const outboxStr = `${state.outboxCount} pending`;
  const balanceStr = formatCurrency(state.bankBalance);

  const colCyan = (s: string) => `${c.cyan}${s}${c.reset}`;
  const colEmerald = (s: string) => `${c.emerald}${s}${c.reset}`;
  const colIndigo = (s: string) => `${c.indigo}${s}${c.reset}`;
  const colMuted = (s: string) => `${c.muted}${s}${c.reset}`;
  const colBold = (s: string) => `${c.bold}${s}${c.reset}`;

  function buildBox(
    title: string,
    rows: [string, string][],
    innerWidth: number,
    colorFn: (s: string) => string
  ): string[] {
    const titleLen = visibleLength(title);
    const dashCount = Math.max(0, innerWidth - titleLen - 1);
    const top =
      colorFn(`${GLYPHS.topLeft}${GLYPHS.horiz} `) +
      colBold(colorFn(title)) +
      colorFn(` ${GLYPHS.horiz.repeat(dashCount)}${GLYPHS.topRight}`);

    const body = rows.map(([label, val]) => {
      const content = label ? `${label} ${val}` : val;
      const vLen = visibleLength(content);
      const padLen = Math.max(0, innerWidth - vLen);
      return `${colorFn(GLYPHS.vert)} ${content}${' '.repeat(padLen)} ${colorFn(GLYPHS.vert)}`;
    });

    const bot = colorFn(
      `${GLYPHS.bottomLeft}${GLYPHS.horiz.repeat(innerWidth + 2)}${GLYPHS.bottomRight}`
    );

    return [top, ...body, bot];
  }

  const leftBox = buildBox(
    'ORDER SERVICE',
    [
      ['SQLite:', colMuted('order.db')],
      ['Status:', orderStatusStr],
      ['Outbox:', outboxStr],
      ['Tx:    ', 'ACID Local Commit'],
    ],
    26,
    colCyan
  );

  const midBox = buildBox(
    'EVENT BUS',
    [
      ['Router:  ', 'Topic-Based'],
      ['Topic:   ', truncate(busTopic, 14)],
      ['Delivery:', 'At-Least-Once'],
      ['Mode:    ', 'Choreography'],
    ],
    24,
    colIndigo
  );

  const rightBox = buildBox(
    'BANK SERVICE',
    [
      ['SQLite: ', colMuted('bank.db')],
      ['Status: ', bankStatusStr],
      ['Balance:', balanceStr],
      ['Inbox:  ', 'Idempotent Dedupe'],
    ],
    26,
    colEmerald
  );

  // Connectors between Left <-> Mid and Mid <-> Right (12 chars wide each)
  const gapEmpty = '            ';
  const fwdArrow = `  ${colCyan(GLYPHS.horiz.repeat(7) + GLYPHS.arrowRight)}  `;
  const revArrow = `  ${colEmerald(GLYPHS.arrowLeft + GLYPHS.horiz.repeat(7))}  `;

  const connectors = [
    gapEmpty, // Top border row
    gapEmpty, // Row 1 (Databases)
    fwdArrow, // Row 2 (order.created forward)
    revArrow, // Row 3 (payment reverse)
    gapEmpty, // Row 4 (Guarantees)
    gapEmpty, // Bottom border row
  ];

  const lines: string[] = [];
  for (let i = 0; i < leftBox.length; i++) {
    lines.push(`${leftBox[i]}${connectors[i]}${midBox[i]}${connectors[i]}${rightBox[i]}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 7. Split-Pane Side-by-Side Table Inspector
// ---------------------------------------------------------------------------

/**
 * Renders side-by-side comparison boxes for two independent databases or state inspectors.
 * Left and right panels are rendered with identical height and synchronized borders.
 */
export function renderSplitPane(
  leftTitle: string,
  leftLines: string[],
  rightTitle: string,
  rightLines: string[],
  totalWidth: number = 104
): string {
  // Normalize multi-line string elements
  const normLeft = leftLines.flatMap((l) => l.split('\n'));
  const normRight = rightLines.flatMap((r) => r.split('\n'));

  const width = Math.max(totalWidth, 60);
  // Total inner space divided equally between two columns (3 chars for │ borders)
  const availableWidth = width - 3;
  const leftColWidth = Math.floor(availableWidth / 2);
  const rightColWidth = availableWidth - leftColWidth;

  const borderCol = (s: string) => `${c.muted}${s}${c.reset}`;
  const titleLeftCol = (s: string) => `${c.bold}${c.cyan}${s}${c.reset}`;
  const titleRightCol = (s: string) => `${c.bold}${c.emerald}${s}${c.reset}`;

  // Top border: ┌─ Title 1 ───┬─ Title 2 ───┐
  const leftTitleVisLen = visibleLength(leftTitle);
  const rightTitleVisLen = visibleLength(rightTitle);

  const leftTopDashes = Math.max(0, leftColWidth - leftTitleVisLen - 3);
  const rightTopDashes = Math.max(0, rightColWidth - rightTitleVisLen - 3);

  const topBorder =
    borderCol(`${GLYPHS.topLeft}${GLYPHS.horiz} `) +
    titleLeftCol(leftTitle) +
    borderCol(` ${GLYPHS.horiz.repeat(leftTopDashes)}${GLYPHS.teeDown}${GLYPHS.horiz} `) +
    titleRightCol(rightTitle) +
    borderCol(` ${GLYPHS.horiz.repeat(rightTopDashes)}${GLYPHS.topRight}`);

  // Divider line under titles: ├───────────────┼───────────────┤
  const midDivider = borderCol(
    `${GLYPHS.teeRight}${GLYPHS.horiz.repeat(leftColWidth)}${GLYPHS.crosshair}${GLYPHS.horiz.repeat(
      rightColWidth
    )}${GLYPHS.teeLeft}`
  );

  // Body rows
  const maxRows = Math.max(normLeft.length, normRight.length);
  const bodyRows: string[] = [];

  for (let i = 0; i < maxRows; i++) {
    const rawLeft = normLeft[i] ?? '';
    const rawRight = normRight[i] ?? '';

    // Inner usable cell width is colWidth - 2 (for left and right padding spaces)
    const innerLeftWidth = leftColWidth - 2;
    const innerRightWidth = rightColWidth - 2;

    let leftText = rawLeft;
    if (visibleLength(leftText) > innerLeftWidth) {
      leftText = truncate(leftText, innerLeftWidth);
    }
    const paddedLeft = pad(leftText, innerLeftWidth, 'left');

    let rightText = rawRight;
    if (visibleLength(rightText) > innerRightWidth) {
      rightText = truncate(rightText, innerRightWidth);
    }
    const paddedRight = pad(rightText, innerRightWidth, 'left');

    bodyRows.push(
      `${borderCol(GLYPHS.vert)} ${paddedLeft} ${borderCol(GLYPHS.vert)} ${paddedRight} ${borderCol(
        GLYPHS.vert
      )}`
    );
  }

  // Bottom border: └───────────────┴───────────────┘
  const botBorder = borderCol(
    `${GLYPHS.bottomLeft}${GLYPHS.horiz.repeat(leftColWidth)}${GLYPHS.teeUp}${GLYPHS.horiz.repeat(
      rightColWidth
    )}${GLYPHS.bottomRight}`
  );

  return [topBorder, midDivider, ...bodyRows, botBorder].join('\n');
}

// ---------------------------------------------------------------------------
// 8. Distributed Saga Flow Timeline
// ---------------------------------------------------------------------------

export type SagaStepStatus = 'SUCCESS' | 'PENDING' | 'FAILED' | 'SKIPPED';

export interface SagaTimelineStep {
  stepNumber: number;
  title: string;
  service: string;
  action: string;
  durationMs?: number;
  status: SagaStepStatus;
  details?: string[];
}

/**
 * Renders a visual timeline showing each hop of an event with latency,
 * database operations, and ACID verification.
 */
export function renderSagaTimeline(steps: SagaTimelineStep[]): string {
  if (steps.length === 0) {
    return `${c.muted}  (No saga steps recorded)${c.reset}`;
  }

  const lines: string[] = [];

  // Title Card
  const headerDashes = GLYPHS.horiz.repeat(40);
  lines.push(
    `${c.muted}${GLYPHS.topLeft}${GLYPHS.horiz} ${c.bold}${c.cyan}DISTRIBUTED SAGA EXECUTION TIMELINE${c.reset} ${c.muted}${headerDashes}${GLYPHS.topRight}${c.reset}`
  );
  lines.push(`${c.muted}${GLYPHS.vert}${c.reset}`);

  steps.forEach((step, idx) => {
    const isLast = idx === steps.length - 1;

    // Node glyph and color based on status
    let nodeGlyph: string = GLYPHS.bullet;
    let nodeColor: string = c.emerald;

    if (step.status === 'PENDING') {
      nodeGlyph = GLYPHS.circle;
      nodeColor = c.amber;
    } else if (step.status === 'FAILED') {
      nodeGlyph = GLYPHS.cross;
      nodeColor = c.rose;
    } else if (step.status === 'SKIPPED') {
      nodeGlyph = GLYPHS.dot;
      nodeColor = c.muted;
    }

    // Service color
    let serviceBadge = `[${step.service}]`;
    if (step.service.toLowerCase().includes('order')) {
      serviceBadge = `${c.cyan}${serviceBadge}${c.reset}`;
    } else if (step.service.toLowerCase().includes('bank')) {
      serviceBadge = `${c.emerald}${serviceBadge}${c.reset}`;
    } else {
      serviceBadge = `${c.indigo}${serviceBadge}${c.reset}`;
    }

    // Status & duration
    const statusStr = statusBadge(step.status);
    const durationStr =
      step.durationMs !== undefined ? `${c.muted}(${step.durationMs.toFixed(1)}ms)${c.reset}` : '';

    // Step Header Line: ● STEP 1: <title> [SERVICE]
    lines.push(
      `${nodeColor}${nodeGlyph}${c.reset} ${c.bold}${c.white}STEP ${step.stepNumber}:${c.reset} ${c.bold}${step.title}${c.reset} ${serviceBadge}`
    );

    // Spine connector
    const spine = isLast ? ' ' : `${c.muted}${GLYPHS.vert}${c.reset}`;

    // Action and Status Line
    lines.push(
      `${c.muted}${GLYPHS.vert}${c.reset}   ${c.muted}Action:${c.reset} ${step.action}`
    );
    lines.push(
      `${c.muted}${GLYPHS.vert}${c.reset}   ${c.muted}Status:${c.reset} ${statusStr} ${durationStr}`
    );

    // Details / ACID operations
    if (step.details && step.details.length > 0) {
      for (const detail of step.details) {
        const trimmed = detail.trim();
        const prefix =
          trimmed.startsWith(GLYPHS.arrowSub) || trimmed.startsWith('↳')
            ? ''
            : `${c.muted}${GLYPHS.arrowSub}${c.reset} `;
        lines.push(`${c.muted}${GLYPHS.vert}${c.reset}   ${prefix}${detail}`);
      }
    }

    // Spacing between steps
    if (!isLast) {
      lines.push(`${c.muted}${GLYPHS.vert}${c.reset}`);
    }
  });

  // Footer closure
  lines.push(`${c.muted}${GLYPHS.vert}${c.reset}`);
  lines.push(
    `${c.muted}${GLYPHS.bottomLeft}${GLYPHS.horiz.repeat(76)}${GLYPHS.bottomRight}${c.reset}`
  );

  return lines.join('\n');
}

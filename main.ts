// Dip-reversion bot for the make.fun cbBTC 24h bars race (agent-fun/bars-replay/v1).
//
// Idea: on a one-minute tape that mostly churns, the reliable money is not in
// chasing breakouts but in buying sharp, late flushes and selling the snap
// back. The bot watches the trailing 3-hour log return of cbBTC closes; when
// that return is at most -100 bps AND the close has fallen at least 1.5%
// under its trailing 12-hour high, the dip counts as established rather than
// fresh — the first leg down of a new decline is left alone, a flush deep
// into an existing one is bought. The signal latches: it must reset (the
// 3-hour return back above -40 bps) before it can fire again, so one cascade
// is bought once, not chased down the stairs.
//
// The position is 55% of equity, additionally capped at 0.08% of the pool
// depth at the latest close so the modelled constant-product impact of the
// fill stays in single-digit bps. A full round trip at that size costs
// roughly 20-25 bps in fees, slippage and impact, so the exit starts well
// clear of it: three fifths of the position are sold at +120 bps over its
// blended fill cost, banking the reversion, and the remaining two fifths are
// left to run to +250 bps — the snap backs that pay best often overshoot —
// with a hard stop on time: everything is sold after 360 bars if neither
// level has been reached.
// There is no price stop on purpose: the paths after these flushes typically
// sag a little further before they turn, and a stop inside that sag would
// sell the bottom tick of the trades that pay. Risk is carried by size and
// by two equity guards instead — entries halt once equity is 5% under the
// starting stake, and a profit lock arms at +3%: if the gain then slips back
// to +1%, any position is sold and the bot parks in cash for the rest of the
// window.
//
// Orders are disarmed on fill, not on send: a buy the market refuses (a gap
// through the slippage cap, say) leaves the signal armed, so the next bar
// retries the same cascade instead of silently losing it.
//
// Everything is a deterministic function of the bars and the account the
// harness sends: no clock, no environment, no randomness. The wire is spoken
// by the kit's TypeScript SDK shim, vendored byte for byte under vendor/.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Signal.
const RET_BARS = 180; // trailing return window: 3 hours of 1-minute closes
const TRIGGER = 0.010; // buy when the trailing log return is at most -100 bps ...
const RESET = 0.004; // ... once it has reset above -40 bps since the last buy
const HIGH_BARS = 720; // trailing high window: 12 hours
const DIP_BELOW_HIGH = 0.015; // ... and the close is >= 1.5% under that high

// Exit: two stages over the blended fill cost.
const TARGET_FIRST = 0.012; // bank three fifths at +120 bps ...
const FIRST_NUM = 3n;
const FIRST_DEN = 5n;
const TARGET_REST = 0.025; // ... and let the rest run to +250 bps
const MAX_HOLD_BARS = 360; // or sell everything after 6 hours
const COOLDOWN_BARS = 90; // bars to sit out after an exit

// Sizing: 55% of equity, and at most 0.08% of the latest close's pool depth.
const SIZE_NUM = 55n;
const SIZE_DEN = 100n;
const DEPTH_NUM = 8n;
const DEPTH_DEN = 10_000n;

// Equity guards, as fractions of the starting stake.
const HALT_DRAWDOWN = 0.05; // stop opening trades 5% under the start
const LOCK_ARM = 0.03; // arm the profit lock 3% ahead ...
const LOCK_FLOOR = 0.01; // ... park if the gain slips back to 1%

// Slippage caps: far above the modelled cost at our size (~20 bps), with room
// for the next open to gap away from the close the order was decided on.
const SLIP_BUY_BPS = 200;
const SLIP_SELL_BPS = 400;

class DipReversion {
  readonly startCash: bigint;
  /** Recent closes as plain numbers (price units), newest last, capped at HIGH_BARS. */
  closes: number[] = [];
  armed = true;
  halted = false;
  lockArmed = false;
  locked = false;
  cooldown = 0;
  /** The seq of the batch that carried our buy fill; null while flat. */
  entrySeq: number | null = null;
  /** A buy we sent that the next batch has not yet answered for. */
  pendingBuy = false;
  /** Whether the first, banking stage of the exit has already filled. */
  tookFirst = false;

  constructor(startCash: bigint) {
    this.startCash = startCash;
  }

  /** The trailing RET_BARS log return, or null until enough closes exist. */
  trailingReturn(): number | null {
    const n = this.closes.length;
    if (n <= RET_BARS) return null;
    return Math.log(this.closes[n - 1]! / this.closes[n - 1 - RET_BARS]!);
  }

  /** The highest close of the trailing HIGH_BARS closes. */
  trailingHigh(): number {
    let hi = 0;
    for (const c of this.closes) if (c > hi) hi = c;
    return hi;
  }

  readFills(batch: Batch): void {
    for (const f of batch.fills) {
      if (f.symbol !== SYMBOL) continue;
      if (f.side === 'buy') {
        this.pendingBuy = false;
        if (f.status === 'filled') {
          this.entrySeq = batch.seq;
          this.armed = false;
        }
      } else if (f.status === 'filled') {
        // A sell that leaves a position behind is the banking stage; one
        // that empties it ends the trade and starts the cooldown.
        if (batch.account.positions.some((p) => p.symbol === SYMBOL)) {
          this.tookFirst = true;
        } else {
          this.entrySeq = null;
          this.tookFirst = false;
          this.cooldown = COOLDOWN_BARS;
        }
      }
    }
  }

  decide(state: BarsState, batch: Batch): (BuyInput | SellInput)[] {
    this.readFills(batch);
    const held = state.positions.get(SYMBOL);
    if (held === undefined) {
      this.entrySeq = null;
      this.tookFirst = false;
    }
    else if (this.entrySeq === null) this.entrySeq = batch.seq; // adopt; the account is the truth

    let freshBar = false;
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      freshBar = true;
      this.closes.push(Number(bar.c));
      if (this.closes.length > HIGH_BARS) this.closes.splice(0, this.closes.length - HIGH_BARS);
    }

    // Equity guards, marked on the account the harness sends.
    const start = Number(this.startCash);
    const equity = Number(state.equity);
    if (equity <= start * (1 - HALT_DRAWDOWN)) this.halted = true;
    if (equity >= start * (1 + LOCK_ARM)) this.lockArmed = true;
    if (this.lockArmed && equity <= start * (1 + LOCK_FLOOR)) this.locked = true;

    if (this.cooldown > 0) this.cooldown -= 1;
    if (state.warmingUp) return [];

    if (held !== undefined) return this.exitOrders(state, held, batch);
    if (!freshBar || this.pendingBuy) return [];
    return this.entryOrders(state);
  }

  exitOrders(state: BarsState, held: { qty: bigint; cost: bigint }, batch: Batch): SellInput[] {
    if (held.cost <= 0n) return [];
    const gain = Number(state.value(SYMBOL, held.qty)) / Number(held.cost) - 1;
    const aged = this.entrySeq !== null && batch.seq - this.entrySeq >= MAX_HOLD_BARS;
    if (this.locked || aged || (this.tookFirst && gain >= TARGET_REST)) {
      return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: SLIP_SELL_BPS }];
    }
    if (!this.tookFirst && gain >= TARGET_FIRST) {
      const part = (held.qty * FIRST_NUM) / FIRST_DEN;
      if (part > 0n) return [{ side: 'sell', symbol: SYMBOL, qty: part, max_slippage_bps: SLIP_SELL_BPS }];
    }
    return [];
  }

  entryOrders(state: BarsState): BuyInput[] {
    const r = this.trailingReturn();
    if (r === null) return [];
    if (-r < RESET) this.armed = true;
    if (!this.armed || this.halted || this.locked || this.cooldown > 0) return [];
    if (-r < TRIGGER) return [];
    const close = this.closes[this.closes.length - 1]!;
    const high = this.trailingHigh();
    if (high <= 0 || close > high * (1 - DIP_BELOW_HIGH)) return [];

    let size = (state.equity * SIZE_NUM) / SIZE_DEN;
    if (size > state.cash) size = state.cash;
    const room = state.weightRoom(SYMBOL);
    if (size > room) size = room;
    const depth = state.depthAt(SYMBOL);
    if (depth !== null && depth.length > 0) {
      const cap = (depth[0]! * DEPTH_NUM) / DEPTH_DEN;
      if (size > cap) size = cap;
    }
    if (size < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    this.pendingBuy = true;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: SLIP_BUY_BPS }];
  }
}

let strategy: DipReversion | null = null;

await runBars({
  onHello(state) {
    strategy = new DipReversion(BigInt(state.hello.capital.quote_units));
  },
  onBatch(state, batch) {
    if (strategy === null) strategy = new DipReversion(BigInt(state.hello.capital.quote_units));
    return strategy.decide(state, batch);
  },
});

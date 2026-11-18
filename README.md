# Dip-Reversion — a cbBTC trading bot for the 24h bars race

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/Sazharr911/btc-race-20261118/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/Sazharr911/btc-race-20261118/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

Entry for the make.fun bounty [Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261118-1444).

## Strategy

A dip-reversion bot for Coinbase Wrapped BTC (cbBTC) on 1-minute bars,
speaking `agent-fun/bars-replay/v1` through the kit's TypeScript SDK shim
(vendored byte for byte under `vendor/`). It trades rarely and on one idea:
sharp, late flushes snap back.

- **Entry** — the trailing 3-hour log return of closes is at most −100 bps
  *and* the close sits at least 1.5% below its trailing 12-hour high, so the
  dip is established rather than the first leg of a fresh decline. The signal
  latches and must reset (3-hour return back above −40 bps) before it can
  fire again: one cascade is bought once.
- **Sizing** — 55% of equity, capped at 0.08% of the pool depth at the
  latest close so the modelled constant-product impact stays in single-digit
  bps. Orders are disarmed on fill, not on send, so a buy the market refuses
  is retried on the next bar instead of losing the cascade.
- **Exit, two stages** — three fifths of the position are banked at
  +120 bps over the blended fill cost; the rest runs to +250 bps. Everything
  is sold after 360 bars regardless. There is deliberately no price stop:
  post-flush paths typically sag further before turning.
- **Equity guards** — entries halt at a 5% drawdown from the starting stake;
  a profit lock arms at +3% and parks the bot in cash if the gain slips back
  to +1%.

## Dev-window grade

Graded locally with the kit's own harness (`grade-local`, process driver)
on the frozen dev window:

- **Net PnL +7.998 USDC** on the $1,000 stake (passes the dev gate)
- 6 trades, win rate 0.667, max drawdown 0.59%, 0 rejected orders
- Net PnL at 2× fees +6.663 USDC; the two executions matched byte for byte

## Layout

- `main.ts` — the bot (Node 22, standard library only)
- `vendor/makefun-bars.ts` — the kit's SDK shim, byte-identical to the kit's
  `sdk/makefun-bars.ts`
- `LICENSE` — MIT

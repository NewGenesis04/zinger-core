# 📘 Zinger Core v1.1.0 — Engineering Handbook & Technical Specification

**Repository:** `NewGenesis04/zinger-core`  
**Version:** `1.1.0` (Post-Refactor Release)  
**Target Runtime:** Node.js `>= v22.23.2` · TypeScript / TSX · Linux x64  
**Blockchain:** Polygon PoS (`137`) · Gnosis Conditional Token Framework (CTF)  
**Persistence:** Native `node:sqlite` (WAL Mode)  

---

## 📑 Table of Contents

1. [Part I: The Refactor Journey & Empirical Validation](#part-i-the-refactor-journey--empirical-validation)
   - [1.1 The Starting State & Architectural Debt](#11-the-starting-state--architectural-debt)
   - [1.2 The 4 Refactor Slices & Milestones](#12-the-4-refactor-slices--milestones)
   - [1.3 Synergy with Real-Time Testing & Empirical Discoveries](#13-synergy-with-real-time-testing--empirical-discoveries)
   - [1.4 The 30-Item Backlog & Complete Refactor Outcomes Matrix](#14-the-30-item-backlog--complete-refactor-outcomes-matrix)
2. [Part II: System Architecture & Subsystem Topology](#part-ii-system-architecture--subsystem-topology)
   - [2.1 Decoupled 4-Phase Scan Pipeline](#21-decoupled-4-phase-scan-pipeline)
   - [2.2 Authority & Precedence Hierarchy (D3)](#22-authority--precedence-hierarchy-d3)
   - [2.3 Zero-Corruption Persistence Engine](#23-zero-corruption-persistence-engine)
3. [Part III: Quantitative & Execution Mathematics](#part-iii-quantitative--execution-mathematics)
   - [3.1 Atomic Arbitrage & Fee-Aware Break-Even Math](#31-atomic-arbitrage--fee-aware-break-even-math)
   - [3.2 Directional Sizing & Quarter-Kelly Mathematics](#32-directional-sizing--quarter-kelly-mathematics)
   - [3.3 The Multi-Tier Exit Matrix](#33-the-multi-tier-exit-matrix)
   - [3.4 Price-to-Beat Oracle & Order Book Imbalance](#34-price-to-beat-oracle--order-book-imbalance)
4. [Part IV: Risk Governance & Circuit Breakers](#part-iv-risk-governance--circuit-breakers)
   - [4.1 The 3 Strategy Regimes](#41-the-3-strategy-regimes)
   - [4.2 Dual-Layer Regime Detection](#42-dual-layer-regime-detection)
   - [4.3 Self-Healing Auto-Revert Engine](#43-self-healing-auto-revert-engine)
   - [4.4 Drawdown Circuit Breakers](#44-drawdown-circuit-breakers)
5. [Part V: On-Chain CTF & Polygon Settlement](#part-v-on-chain-ctf--polygon-settlement)
   - [5.1 Gnosis Conditional Token Framework (CTF) Mechanics](#51-gnosis-conditional-token-framework-ctf-mechanics)
   - [5.2 Instant On-Chain Merge Execution](#52-instant-on-chain-merge-execution)
6. [Part VI: Telemetry Engine & External API Specification](#part-vi-telemetry-engine--external-api-specification)
   - [6.1 Strongly Typed Telemetry Bus](#61-strongly-typed-telemetry-bus)
   - [6.2 In-Memory Ring Buffer Architecture](#62-in-memory-ring-buffer-architecture)
   - [6.3 Core Event Taxonomy & Schemas](#63-core-event-taxonomy--schemas)
   - [6.4 External HTTP & SSE Real-Time API Surface](#64-external-http--sse-real-time-api-surface)
7. [Part VII: Production Runbook & Operations Guide](#part-vii-production-runbook--operations-guide)
   - [7.1 Environment Variables Reference](#71-environment-variables-reference)
   - [7.2 Process Management & 24/7 Deployment](#72-process-management--247-deployment)
   - [7.3 Cash Ledger Reconciliations & Production Audits](#73-cash-ledger-reconciliations--production-audits)

---

# Part I: The Refactor Journey & Empirical Validation

### 1.1 The Starting State & Architectural Debt

Prior to the v1.1.0 refactor, Zinger operated as a monolithic codebase centered in a 4,000+ line [`src/polymarket/bot.ts`](file:///home/newgenesis/Documents/Repositories/ZINGER_BOT/src/polymarket/bot.ts) file. While the core trading concept was sound, the codebase suffered from 5 fundamental architectural vulnerabilities:

1. **State & Scan Loop Coupling:** Order book polling, technical indicator ingestion, order execution, position exit logic, and trade reconciliation were interleaved in a single synchronous loop. An error in mark-price calculation would crash the entire scan pass.
2. **The "Silent Fee-Refund" Bug:** Three independent modules computed cash balance, but two wrote to state asynchronously. Reconcile recomputed cash without accounting for entry/exit taker fees, causing a phantom balance drift ($+\$1.96$ per cycle) on production.
3. **Gross vs. Net Arbitrage Overstatements:** Hedged arbitrage profit was recorded as $\text{Payout} - \text{Total Cost}$ without subtracting taker fees paid on both legs. A package that appeared $+12\%$ profitable was often negative after fees.
4. **JSON File Corruption Risk:** State and trade history were serialized via raw `fs.writeFileSync` on every tick. Any SSH drop, power blip, or kill signal during write produced corrupt JSON files (`SyntaxError: Unexpected end of JSON input`).
5. **No Regression Safety Net:** Zero unit tests existed to guard critical accounting, math, or position lifecycle invariants.

---

### 1.2 The 4 Refactor Slices & Milestones

The refactoring was executed across 4 isolated, test-driven slices:

```mermaid
graph TD
    S0["Slice 0: The Safety Net<br/>• 67 Permanent Invariant Tests<br/>• 240 Unit Tests<br/>• Hot-Path Micro-Benchmarks"]
    S1["Slice 1: Atomic Arbitrage Engine<br/>• Decoupled Arb Matching<br/>• Fee-Aware Break-Even Gates<br/>• Zero Orphan Leg Exposure"]
    S2["Slice 2: Decoupled Scan Pipeline<br/>• 4 Pure Phases (Cycle, Inputs, Exits, Orchestrator)<br/>• Non-blocking Telemetry"]
    S3["Slice 3: Position Lifecycle & Settlement<br/>• Policy Engines & Settle Resolvers<br/>• SQLite WAL Store (Zero Corruption)"]
    CTF["Feature Slice: Instant CTF Merge<br/>• On-Chain CTF.mergePositions()<br/>• Instant $1.00 USDC Reclaim"]

    S0 --> S1
    S1 --> S2
    S2 --> S3
    S3 --> CTF
```

* **Slice 0 (Safety Net):** Authored [`tests/unit/invariants.test.ts`](file:///home/newgenesis/Documents/Repositories/ZINGER_BOT/tests/unit/invariants.test.ts) establishing 67 permanent mathematical invariants (fee calculations, cash ledgers, boundary caps, window parsers) and [`tests/perf/hot-path.perf.test.ts`](file:///home/newgenesis/Documents/Repositories/ZINGER_BOT/tests/perf/hot-path.perf.test.ts) enforcing $>12.5\text{M ops/s}$ throughput on taker fees.
* **Slice 1 (Atomic Arb Engine):** Created [`src/polymarket/arbEngine.ts`](file:///home/newgenesis/Documents/Repositories/ZINGER_BOT/src/polymarket/arbEngine.ts) to manage hedged packages as atomic units, enforcing the fee-aware break-even gate ($> \text{Fees}$) and zero orphan leg exposure.
* **Slice 2 (Decoupled Scan Pipeline):** Extracted the 4 pure scan phases into [`src/polymarket/scan/`](file:///home/newgenesis/Documents/Repositories/ZINGER_BOT/src/polymarket/scan/): [`cycle.ts`](file:///home/newgenesis/Documents/Repositories/ZINGER_BOT/src/polymarket/scan/cycle.ts), [`inputs.ts`](file:///home/newgenesis/Documents/Repositories/ZINGER_BOT/src/polymarket/scan/inputs.ts), [`exits.ts`](file:///home/newgenesis/Documents/Repositories/ZINGER_BOT/src/polymarket/scan/exits.ts), and [`orchestrator.ts`](file:///home/newgenesis/Documents/Repositories/ZINGER_BOT/src/polymarket/scan/orchestrator.ts).
* **Slice 3 (Position Lifecycle & Persistence):** Isolated position management in [`src/polymarket/positions/`](file:///home/newgenesis/Documents/Repositories/ZINGER_BOT/src/polymarket/positions/) and migrated storage to native `node:sqlite` WAL mode in [`src/polymarket/sqliteStore.ts`](file:///home/newgenesis/Documents/Repositories/ZINGER_BOT/src/polymarket/sqliteStore.ts).
* **Feature Slice (Instant On-Chain CTF Merge):** Integrated [`src/polymarket/ctf/merge.ts`](file:///home/newgenesis/Documents/Repositories/ZINGER_BOT/src/polymarket/ctf/merge.ts), executing Gnosis CTF `mergePositions()` on Polygon immediately upon both legs filling.

---

### 1.3 Synergy with Real-Time Testing & Empirical Discoveries

The refactor adhered to an empirical validation loop where unit testing and live sandbox simulations continuously shaped architectural decisions:

1. **The Small-Ticket `minTpUsd` Distortion Discovery:**
   * *Problem:* In testing, small positions ($5–$10 tickets) were never hitting Take-Profit targets and getting stopped out.
   * *Forensic Finding:* A legacy parameter `minTpUsd: 5` forced the Take-Profit price target to be scaled up by $+\$5.00$ in absolute profit. On a $\$5.00$ ticket, requiring $\$5.00$ profit forced a $+100\%$ target price (often $> \$0.99$), making TP mathematically unreachable!
   * *Resolution:* Setting `minTpUsd: 0` restored natural, percentage-based Take-Profit dynamics ($+18\%\text{--}+36\%$), converting previously lost trades into immediate winners.
2. **Single-Owner Cash Ledger Invariant:**
   * *Proof:* Live VPS burn-in proved the single-owner cash ledger formula with zero balance drift over 50+ closed positions:
     $$\text{Cash Balance} = \text{Initial Deposit} + \sum \text{Realized PnL} - \sum \text{Fees Paid} - \sum \text{Open Cost}$$
3. **Empirical Guardrail Validation (Live VPS Run):**
   * During the 5-hour VPS burn-in run, live market chop triggered the **Governor Auto-Revert** engine twice (`trend-ride lost $-15.19 / 6t → revert to scalp`), and triggered the **Drawdown Circuit Breaker** at $-13.6\%$, locking directional trading and preserving the remaining bankroll.

---

### 1.4 The 30-Item Backlog & Complete Refactor Outcomes Matrix

All 30 architectural backlog items identified across the pre-refactor audits were completely resolved, verified by automated unit tests, and promoted into permanent CI regression suites:

| Slice | Item ID | Subsystem | Defect / Technical Debt Before | Refactored Solution & Invariant Proof |
|---|---|---|---|---|
| **Slice 0** | **Item 6** | PnL Attribution | Paper cash drift and edge gate contamination across engines | Decoupled cash ledger, separate engine attribution, zero phantom fee drift. |
| **Slice 0** | **Item 7** | Arb Economics | Arb reported gross profit; ~1.6% gap lost money after fees | Built fee-aware break-even gate ($> \text{Fees}$) + reported net profit. |
| **Slice 0** | **Item 12** | Test Harness | Vitest workers deadlocking and writing to live `data/` dir | Isolated test environment via `ZINGER_DATA_DIR` per worker thread. |
| **Slice 0** | **Item 16** | Path Resolution | 7 modules hardcoded `../../data` bypassing data overrides | Unified `getDataDir()` export used universally across codebase. |
| **Slice 0** | **Item 23** | Hot-Path Perf | Slow taker fee and window parsing loops in scan cycle | Micro-optimized hot paths ($>12.5\text{M ops/s}$ taker fees, $>580\text{k ops/s}$ parsers). |
| **Slice 1** | **Item 9** | Arb Lifecycle | Stale `PENDING_FILL` arb packages locked slots indefinitely | Implemented auto-expire & capacity reclaim in `arbEngine.ts`. |
| **Slice 1** | **Item 25** | Trade Attribution | Trades lacked clear engine origin tags (`arb` vs `directional`) | Explicit `engine: 'arb' \| 'directional'` tag on every execution. |
| **Slice 1** | **Item 27** | Sizing Separation | Shared slot counts caused arb headroom to authorize directional risk | Decoupled `maxOpenPositions` from `maxArbPackages`. |
| **Slice 1** | **Item 29** | Leg Sizing Parity | Micro-cent rounding created asymmetric share sizes across UP/DOWN | Symmetrical micro-share sizing guaranteeing 1:1 payout parity. |
| **Slice 2** | **Item 8** | Naked Leg Value | Naked arb leg valued at fixed $0.50 baseline rather than market mark | Market-outcome valuation in `positions/policy.ts` using live order book. |
| **Slice 2** | **Item 10** | Housekeeping | `getState()` triggered `syncPackageSettlements` as a mutation side-effect | Pure read-only queries; mutations moved to isolated scan cycle phase. |
| **Slice 2** | **Item 11** | Multi-Duration | Hardcoded 5m/15m assumptions broke 30m, 1h, and 4h windows | Duration-aware window parser & resolver in `scan/cycle.ts`. |
| **Slice 2** | **Item 26** | Authority Model | Automated governor overwritten operator settings on every loop | D3 3-tier hierarchy: Operator > Guardrail > Automation. |
| **Slice 3** | **Item 1** | Scan Decomposition | 1,035-line monolithic `scan()` function doing 7 jobs at once | Decomposed into 4 isolated phase modules in `src/polymarket/scan/`. |
| **Slice 3** | **Item 2** | Single Responsibility | `bot.ts` held both orchestration and trading strategy policies | Isolated policies into `engines/` and `positions/` submodules. |
| **Slice 3** | **Item 3** | Governor Transparency | Silent regime overrides with 54 magic literals | Operator-editable regime profiles with explicit cooldown timers. |
| **Slice 3** | **Item 4** | Auto-Revert Engine | Losing regime transitions continued bleeding capital | Auto-revert guardrail monitoring baseline PnL over $N$ trades. |
| **Slice 3** | **Item 5** | Drawdown Breakers | No circuit breaker tripped on severe drawdown | Automated Drawdown Breaker locking bot into `arb-only` at $-14\%$. |
| **Slice 3** | **Item 13** | Log Retention | 300-entry in-memory log cap evicted critical forensic events | Raised retention to 5,000 typed events in ring buffer. |
| **Slice 3** | **Item 14** | Performance DB | 41 sessions of trade history invisible to ML optimizer | Migrated trade records to native `node:sqlite` WAL database. |
| **Slice 3** | **Item 15** | Persistence Safety | Backend selected by Node version alone; risk of stale JSON fallback | Documented explicit `ZINGER_SQLITE` / native WAL SQLite persistence. |
| **Slice 3** | **Item 17** | ML Boundary | Python ML traces intermingled with bot runtime state | Decoupled ML price trace ingestion via clean JSON contract. |
| **Slice 3** | **Item 18** | Live Wallet Setup | No secure wallet import/export path for private keys | Integrated encrypted wallet import/export & deposit address resolvers. |
| **Slice 3** | **Item 19** | Live Safety Caps | Config migration widened live position caps from $1 to $100 | Enforced permanent code assertions against widening live risk limits. |
| **Slice 3** | **Item 20** | Telemetry Bus | 44% of log lines carried unstructured prose strings | Strongly typed event bus with versioned schema (`events.ts`). |
| **Slice 3** | **Item 21** | Permissions Engine | Fragmented trade gating checks across 4 different files | Centralized `resolveTradingPermissions()` authority resolver. |
| **Slice 3** | **Item 22** | Clean Data Cut | Dirty pre-refactor state corrupted new analytics | Clean schema cutover with automated JSON archive migration. |
| **Slice 3** | **Item 24** | Arb History Proof | Resetting paper data detached arb packages from leg trades | Unified package ledger preserving leg linkage across all resets. |
| **Slice 3** | **Item 28** | Position Lifecycle | Manager contained 12 `isArbLeg` conditionals | Pure strategy-agnostic position manager (`positions/manager.ts`). |
| **Slice 3** | **Item 30** | Settlement Safety | Window expiry race condition caused stuck positions | Duration-aware settlement queue verifying on-chain condition resolution. |

#### Verification & Performance Benchmark Results
* **Test Suite:** 22 test files / 240 unit tests passing (0 failures).
* **Permanent Invariants:** 67 mathematical invariants continuously verified in [`tests/unit/invariants.test.ts`](file:///home/newgenesis/Documents/Repositories/ZINGER_BOT/tests/unit/invariants.test.ts).
* **Hot-Path Performance Budgets ([`tests/perf/hot-path.perf.test.ts`](file:///home/newgenesis/Documents/Repositories/ZINGER_BOT/tests/perf/hot-path.perf.test.ts)):**
  * `takerFeeUsdc`: **`> 12.5M ops/s`** (zero allocation in hot path)
  * `window-parsers`: **`> 580k ops/s`**
  * `computeKellySize`: **`> 530k ops/s`**
  * `auth-issue-verify`: **`> 34k ops/s`**

---

# Part II: System Architecture & Subsystem Topology

### 2.1 Decoupled 4-Phase Scan Pipeline

The scan engine executes periodically (default: every 1,000ms) through 4 decoupled, isolated phases:

```mermaid
sequenceDiagram
    participant S as Scan Orchestrator
    participant C as Phase 1: Cycle Boundary
    participant I as Phase 2: Inputs Ingestion
    participant E as Phase 3: Exits Evaluation
    participant O as Phase 4: Sizing & Execution

    S->>C: evaluateCycleBoundary(wallWindow, botState)
    Note over C: Prunes expired pending trades, updates window clocks
    C-->>S: Cycle boundary status

    S->>I: collectSignals() & refreshSpotPrices()
    Note over I: Non-blocking Binance ticks, ADX/ATR, ML traces
    I-->>S: Fresh signals & marks

    S->>E: evaluateExits(openPositions, liveMarks, signals)
    Note over E: Fast SL, Adaptive SL, Trailing TP, Partial Exits
    E-->>S: Pending sell orders

    S->>O: buildDecision() & resolveOrderSize()
    Note over O: D3 Perms, Kelly Sizing, Atomic Arb Detection
    O-->>S: Atomic execution orders
```

1. **Phase 1: Cycle Boundary ([`src/polymarket/scan/cycle.ts`](file:///home/newgenesis/Documents/Repositories/ZINGER_BOT/src/polymarket/scan/cycle.ts)):** Synchronizes with wall-clock time windows (5m, 15m, 30m, 1h, 4h). Prunes stale unconfirmed orders and reconciles closed trades.
2. **Phase 2: Inputs Ingestion ([`src/polymarket/scan/inputs.ts`](file:///home/newgenesis/Documents/Repositories/ZINGER_BOT/src/polymarket/scan/inputs.ts)):** Concurrently polls Binance spot prices (`BTCUSDT`, `ETHUSDT`), ADX/ATR technical indicators, and ML price traces. Network timeouts fall back gracefully to cached ticks without throwing unhandled rejections.
3. **Phase 3: Exits Evaluation ([`src/polymarket/scan/exits.ts`](file:///home/newgenesis/Documents/Repositories/ZINGER_BOT/src/polymarket/scan/exits.ts)):** Scans all open positions against live order book bids, evaluating Fast SL, Adaptive SL, Trailing TP, and Underdog Settlement status.
4. **Phase 4: Sizing & Execution ([`src/polymarket/scan/orchestrator.ts`](file:///home/newgenesis/Documents/Repositories/ZINGER_BOT/src/polymarket/scan/orchestrator.ts)):** Filters trade candidates through D3 permissions, scores `UP` vs `DOWN` via `evalBothSides`, sizes positions via Kelly fractions, and routes orders to the CLOB trade client.

---

### 2.2 Authority & Precedence Hierarchy (D3)

To ensure automated AI agents, background optimizers, or LLM arbiters cannot override risk limits or operator overrides, Zinger implements a strict **3-Tier Authority Hierarchy**:

$$\mathbf{\text{Operator Tier}} \gg \mathbf{\text{Guardrail Tier}} \gg \mathbf{\text{Automation Tier}}$$

```mermaid
flowchart TD
    Op["1. Operator Tier (Dashboard / Manual)<br/>• forceArbOnly: true<br/>• Hard Stop / Kill Switch<br/>• Direct Config Mutations"]
    Guard["2. Guardrail Tier (Invariants & Safety Nets)<br/>• Drawdown Circuit Breaker (-14%)<br/>• Auto-Revert Engine<br/>• Live Safety Caps (max ticket $100)"]
    Auto["3. Automation Tier (AI & Algorithms)<br/>• Heuristic Regime Switches (scalp / trend-ride)<br/>• LLM Profile Advice (OpenRouter)<br/>• Optimizer / Adaptive Parameter Dials"]

    Op -->|Outranks & Overrides| Guard
    Guard -->|Outranks & Restricts| Auto
```

* **Operator Tier:** Absolute priority. When an operator enables `forceArbOnly: true`, directional trading is physically blocked across all modules regardless of market conditions.
* **Guardrail Tier:** Autonomous safety nets. If cumulative drawdown reaches $-14\%$, the drawdown breaker overrides automated profiles and shifts the engine into `arb-only`.
* **Automation Tier:** Heuristic algorithms and LLMs operate strictly within bounded ranges defined in [`src/ai/governor.ts`](file:///home/newgenesis/Documents/Repositories/ZINGER_BOT/src/ai/governor.ts) and cannot mutate protected keys (`GOVERNOR_FORBIDDEN_KEYS`).

---

### 2.3 Zero-Corruption Persistence Engine

Storage is managed by native `node:sqlite` in [`src/polymarket/sqliteStore.ts`](file:///home/newgenesis/Documents/Repositories/ZINGER_BOT/src/polymarket/sqliteStore.ts):

* **Database File:** `<dataDir>/zinger.db`
* **Schema:**
  ```sql
  CREATE TABLE IF NOT EXISTS zinger_documents (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  ```
* **WAL Mode (Write-Ahead Logging):** Configured with `PRAGMA journal_mode = WAL;` and `PRAGMA synchronous = NORMAL;`.
* **Properties:**
  * Zero disk-locking overhead during concurrent reads.
  * Atomic transactions: power interruptions or process terminations never corrupt JSON state.
  * 4 core documents stored: `poly_config.json`, `poly_state.json`, `governor_state.json`, `wallet.json`.

---

# Part III: Quantitative & Execution Mathematics

### 3.1 Atomic Arbitrage & Fee-Aware Break-Even Math

The Atomic Arb Engine searches for complementary contract mispricings across binary prediction markets:

$$\text{Combined Cost (Sum)} = \text{Best Ask}(\text{UP}) + \text{Best Ask}(\text{DOWN})$$
$$\text{Arb Gap} = \$1.000 - \text{Combined Cost}$$

```mermaid
flowchart TD
    A["Order Book Ask(UP) & Ask(DOWN)"] --> B{"1. Fee Break-Even Gate<br/>Gap > Taker Fee(UP) + Taker Fee(DOWN) + Buffer"}
    B -- No --> C[⛔ Reject: Unprofitable after fees]
    B -- Yes --> D{"2. Operator Floor Gate<br/>Gap >= minArbGap (default 0.015)"}
    D -- No --> E[⛔ Reject: Gap below operator threshold]
    D -- Yes --> F{"3. Capacity & Balance Check<br/>Active pkgs < maxArbPackages"}
    F -- Yes --> G["🚀 Execute Atomic Arb Package<br/>Buy UP + Buy DOWN"]
```

#### The Two-Stage Arbitrage Gate ([`src/polymarket/arbEngine.ts:90-105`](file:///home/newgenesis/Documents/Repositories/ZINGER_BOT/src/polymarket/arbEngine.ts#L90-L105))
1. **Mathematical Fee Break-Even Gate:**
   $$\text{Gap} > \text{TakerFee}(\text{UP}) + \text{TakerFee}(\text{DOWN}) + 0.002$$
   Guarantees that no trade executes unless the locked payout strictly exceeds Polymarket taker fees.
2. **Operator Floor Gate (`minArbGap: 0.015`):**
   $$\text{Gap} \ge \text{minArbGap}$$
   Ensures capital is only committed to opportunities meeting the operator's minimum profit target (default: $1.5\%$ or $\$0.015$ per share).

---

### 3.2 Directional Sizing & Quarter-Kelly Mathematics

Directional position size is calculated in [`src/polymarket/kelly.ts`](file:///home/newgenesis/Documents/Repositories/ZINGER_BOT/src/polymarket/kelly.ts) using a fractional Kelly criterion:

$$f^* = \frac{b \cdot p - q}{b}$$

Where:
* $p = \text{Estimated Win Probability (Modeled Confidence)}$
* $q = 1 - p$
* $b = \frac{\text{Take Profit Target}}{\text{Stop Loss Distance}} = \text{Payoff Ratio}$

To prevent over-leverage, the theoretical Kelly fraction is scaled by `kellyFraction` (default: $0.12$ in scalp, $0.18$ in trend-ride):

$$\text{Allocated Capital} = \text{Bankroll} \cdot \min\Big(\text{maxPositionPct},\, f^* \cdot \text{kellyFraction}\Big)$$

---

### 3.3 The Multi-Tier Exit Matrix

Zinger implements 5 distinct, prioritized exit triggers:

| Exit Type | Condition | Purpose | Typical Gain/Loss |
|---|---|---|---|
| **`FAST SL`** | Price $\le \text{Entry} \cdot (1 - \text{slPct})$ | Hard risk cutoff | $-14\%\text{ to }-18\%$ |
| **`ADAPTIVE SL`** | Position underwater + Signal confidence fading ($\Delta \text{conf} > 0.10$) | Dynamic loss tightening | $-6\%\text{ to }-10\%$ |
| **`PARTIAL TP`** | Price $\ge \text{Entry} \cdot (1 + \text{tpPctLow} \cdot 0.55)$ | Derisk $20\%\text{--}25\%$ into momentum surge | $+15\%\text{ to }+25\%$ |
| **`TRAILING STOP`**| Price reaches high water mark, then retraces $> \text{trailDistanceCap}$ | Lock in unrealized trend gains | $+25\%\text{ to }+60\%$ |
| **`DISASTER SL`** | Underdog contract ($\text{Entry} \le \$0.48$) drops past $-45\%$ | Wide breathing room for hold-to-settle | $-45\%\text{ to }-48\%$ |

---

### 3.4 Price-to-Beat Oracle & Order Book Imbalance

In [`src/polymarket/engines/directional.ts`](file:///home/newgenesis/Documents/Repositories/ZINGER_BOT/src/polymarket/engines/directional.ts), order book depth is weighted using **Order Book Imbalance**:

$$\text{OB Imbalance} = \frac{\text{Bid Depth} - \text{Ask Depth}}{\text{Bid Depth} + \text{Ask Depth}} \in [-1.0, +1.0]$$

* **Positive Imbalance ($> +0.25$):** Bid-heavy support $\implies$ Boosts `UP` score by $+18\text{ pts}$.
* **Negative Imbalance ($< -0.25$):** Ask-heavy resistance $\implies$ Penalizes `UP` score by $-12\text{ pts}$.

---

# Part IV: Risk Governance & Circuit Breakers

### 4.1 The 3 Strategy Regimes

The Governor manages strategy behavior across 3 distinct operational regimes:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             GOVERNOR REGIME MATRIX                          │
├─────────────────┬───────────────────────────────────────────────────────────┤
│ `trend-ride`    │ Strong directional momentum (ADX ≥ 28). Wide TP (22%-55%),│
│                 │ partials at 85%, trailing stops enabled, Kelly 0.18.      │
├─────────────────┼───────────────────────────────────────────────────────────┤
│ `scalp`         │ Range-bound chop (ADX < 25). Tight TP (16%-32%), tighter  │
│                 │ stops (16%), small fast partials at 78%, Kelly 0.12.      │
├─────────────────┼───────────────────────────────────────────────────────────┤
│ `arb-only`      │ High volatility / uncertainty (ATR ≥ 0.5%) or Circuit     │
│                 │ Breaker Active. 100% directional risk locked out.         │
└─────────────────┴───────────────────────────────────────────────────────────┘
```

---

### 4.2 Dual-Layer Regime Detection

The Governor executes a **two-layer arbitration flow**:

```mermaid
flowchart TD
    A["Market Ticks & Signals"] --> B["Layer 1: Quantitative Math Heuristic"]
    B --> C{"Macro Volatility Analysis"}
    C -->|"ATR >= 0.5%"| D["Regime: arb-only"]
    C -->|"ADX >= 28 & Trending"| E["Regime: trend-ride"]
    C -->|"ADX < 28 Range/Chop"| F["Regime: scalp"]

    D --> G{"OpenRouter API Key Set?"}
    E --> G
    F --> G
    G -->|"Yes"| H["Layer 2: LLM Arbiter (OpenRouter)"]
    H -->|"Considers recent win-rate & equity"| I["Output: Bounded Regime Choice"]
    G -->|"No"| J["Adopt Layer 1 Heuristic Choice"]
```

---

### 4.3 Self-Healing Auto-Revert Engine

If the Governor switches into a regime that begins losing money, the **Auto-Revert Guardrail** (`governorRevertTrades: 6`, `governorRevertPnl: 0.00`) activates:

```mermaid
sequenceDiagram
    participant G as Governor
    participant S as Strategy Profile

    G->>S: Switch Regime: scalp to trend-ride
    Note over G: Record Baseline Trade Count and Net PnL
    loop Next 6 Closed Trades
        S->>S: Execute Directional Trade
    end
    alt Cumulative PnL is Negative (Bleeding)
        G->>S: Auto-Revert: trend-ride back to scalp
        Note over G: Place trend-ride on Cooldown Timer
    else Cumulative PnL is Positive or Flat
        Note over G: Confirm Regime Switch and Reset Baseline
    end
```

---

### 4.4 Drawdown Circuit Breakers

If cumulative equity drawdown dips past `governorDrawdownPct` (default: $-14\%$ in paper, $-10\%$ in live):
1. The Governor trips `breakerActive: true`.
2. Active regime is immediately locked into **`arb-only`**.
3. All directional buying is physically disabled until manual operator reset.

---

# Part V: On-Chain CTF & Polygon Settlement

### 5.1 Gnosis Conditional Token Framework (CTF) Mechanics

Polymarket binary outcome tokens are ERC-1155 tokens minted via the Gnosis CTF contract on Polygon PoS:

* **Contract Address:** `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045`
* **Collateral Token:** Native USDC (`0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` / 6 decimals)
* **Binary Partition:** `[1n, 2n]` (`Index 0 = UP`, `Index 1 = DOWN`)

---

### 5.2 Instant On-Chain Merge Execution

When an arbitrage package completes execution, rather than holding tokens until market resolution, Zinger triggers an **Instant On-Chain Merge** ([`src/polymarket/ctf/merge.ts`](file:///home/newgenesis/Documents/Repositories/ZINGER_BOT/src/polymarket/ctf/merge.ts)):

```mermaid
sequenceDiagram
    participant Arb as Arb Engine
    participant Viem as Viem Execution Client
    participant CTF as Polygon CTF Contract (0x4D97...)
    participant USDC as Collateral Vault

    Arb->>Viem: Package filled (e.g. 10.0 shares UP + 10.0 shares DOWN)
    Viem->>CTF: mergePositions(collateral, parentCollectionId, conditionId, [1n, 2n], 10000000n)
    CTF->>CTF: Burns 10.0 UP + 10.0 DOWN tokens
    CTF->>USDC: Transfers $10.000000 USDC to Bot Wallet
    CTF-->>Viem: Transaction Confirmed (TxHash)
    Viem-->>Arb: Package Status ──► 'MERGED'
```

* **Benefit:** Eliminates window settlement duration risk and unlocks 100% of collateral capital within seconds.

---

# Part VI: Telemetry Engine & External API Specification

### 6.1 Strongly Typed Telemetry Bus

Zinger implements a central, high-throughput event bus ([`src/polymarket/telemetry/events.ts`](file:///home/newgenesis/Documents/Repositories/ZINGER_BOT/src/polymarket/telemetry/events.ts)). All lifecycle events conform to schema version `TELEMETRY_SCHEMA_VERSION = 1`:

```ts
export interface BaseTelemetryEvent {
  id: string;          // Unique monotonic ID (e.g. 'evt-1787606490834-42')
  type: EventType;     // 'scan.cycle' | 'trade.decision' | 'trade.execution' | 'position.exit' | 'package.settlement'
  v: number;           // Schema version (1)
  ts: number;          // UNIX timestamp in milliseconds
  data: Record<string, any>;
}
```

---

### 6.2 In-Memory Ring Buffer Architecture

* **Capacity:** Default `5,000` events (`DEFAULT_EVENT_BUFFER_CAP`).
* **Zero Disk I/O:** Event emission occurs entirely in RAM at microsecond speed without triggering file locks.
* **FIFO Eviction:** When the buffer reaches 5,000 events, the oldest event is evicted automatically.

---

### 6.3 Core Event Taxonomy & Schemas

#### 1. `trade.decision` (Every Poke / Evaluation)
```json
{
  "id": "evt-1787616600000-101",
  "type": "trade.decision",
  "v": 1,
  "ts": 1787616600000,
  "data": {
    "symbol": "BTC",
    "slug": "btc-updown-5m-1787616600",
    "outcome": "up",
    "eligible": true,
    "score": 48.2,
    "confidence": 0.52,
    "price": 0.48,
    "reasons": ["signal UP 52%", "book bid heavy", "price edge +4.2c"]
  }
}
```

#### 2. `package.settlement` (Arbitrage Completion)
```json
{
  "id": "evt-1787652000000-204",
  "type": "package.settlement",
  "v": 1,
  "ts": 1787652000000,
  "data": {
    "packageId": "pkg-btc-8hyphb",
    "symbol": "BTC",
    "shares": 9.20,
    "totalCost": 8.92,
    "payout": 9.20,
    "lockedProfitUsd": 0.28,
    "lockedProfitPct": 3.14,
    "status": "MERGED",
    "mergeTxHash": "0xabc123..."
  }
}
```

---

### 6.4 External HTTP & SSE Real-Time API Surface

External analytics engines, monitoring dashboards, and forensics consumers interface with Zinger via these endpoints:

| Endpoint | Method | Description | Auth Required |
|---|---|---|---|
| **`/api/poly/state`** | `GET` | Full runtime state (trades, cash ledger, mark prices, positions) | Operator / ReadOnly |
| **`/api/poly/events`** | `GET` | Query ring-buffer events (`?type=...&symbol=...&since=...&limit=...`) | Operator / ReadOnly |
| **`/api/poly/packages`**| `GET` | Active and concluded hedged arbitrage packages | Operator / ReadOnly |
| **`/api/poly/audit`** | `GET` | Cash ledger reconciliation proofs and fee audits | Operator / ReadOnly |
| **`/api/poly/stream`** | `GET (SSE)`| Real-time Server-Sent Events stream of all telemetry events | Operator / ReadOnly |

---

# Part VII: Production Runbook & Operations Guide

### 7.1 Environment Variables Reference

Configure these in your production `.env` file:

```env
# ── Core Server ────────────────────────────────────────────────────────
PORT=3000
SITE_URL=http://localhost:3000
AUTH_PASSWORD=your_secure_password_here
READONLY_PASSWORD=your_readonly_password_here

# ── Storage & Bankroll ────────────────────────────────────────────────
# ZINGER_DATA_DIR=/var/lib/zinger/data
PAPER_BANKROLL=100                 # Initial bankroll on clean boot (default: 100)

# ── LLM Governor (Optional) ───────────────────────────────────────────
OPENROUTER_API_KEY=sk-or-v1-...     # Enable LLM macro regime arbitration

# ── Blockchain & Egress (Live Mode) ────────────────────────────────────
POLYGON_RPC_URL=https://polygon-bor-rpc.publicnode.com
# CLOB_PROXY_URL=socks5://user:pass@proxy:1080  # Optional egress proxy
```

---

### 7.2 Process Management & 24/7 Deployment

#### Running with `pm2` (Recommended for Auto-Restart)
```bash
# Install PM2 globally
npm install -g pm2

# Launch Zinger daemon
pm2 start "npm start" --name zinger

# View live telemetry logs
pm2 logs zinger
```

#### Running with `tmux`
```bash
# Start named session
tmux new -s zinger

# Run bot
cd /opt/apps/ZINGER
npm start

# Detach: Press Ctrl+B, then D
# Reattach: tmux attach -t zinger
```

---

### 7.3 Cash Ledger Reconciliations & Production Audits

To audit the cash ledger and verify zero balance drift at any time:

```bash
# Run one-line forensic audit via CLI:
curl -s -b cookie.txt http://localhost:3000/api/poly/audit | jq .
```

Expected output:
```json
{
  "ok": true,
  "baselineUsd": 100,
  "cashPnl": -15.03,
  "paperPnl": -13.64,
  "wallet": { "cash": 84.97, "botOpen": 0 },
  "checks": [
    { "id": "pnl_books", "ok": true, "detail": "Net $-15.03" },
    { "id": "trades", "ok": true, "detail": "16 paper trades" }
  ]
}
```

---

### 🏛️ Document Summary
This specification serves as the definitive engineering manual for Zinger Core v1.1.0. All mathematical invariants, authority hierarchies, persistence guarantees, and telemetry protocols documented herein are permanently enforced by continuous integration test suites in [`tests/unit/invariants.test.ts`](file:///home/newgenesis/Documents/Repositories/ZINGER_BOT/tests/unit/invariants.test.ts).

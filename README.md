# Casefile

**An investigating verifier for payment fraud alerts.**

A rules engine tells you a transaction is suspicious. It does not tell you whether it is
*right*. Casefile investigates the alert: it gathers evidence from the payment
environment, weighs it, and returns an auditable verdict where every claim traces to a
specific record — and where changing any record underneath that verdict makes replay
fail loudly instead of quietly lying to you.

> **Status:** early development. This README describes what is implemented today and
> grows with the system.

## The problem

Production fraud rules engines are tuned for recall, so they over-alert. A risk
analyst's day goes on clearing alerts that were never fraud. That cost is real and
two-sided: every false positive is a rejected customer, and every alert rubber-stamped
because the queue is 400 deep is a loss that got through.

Casefile sits *after* the rules engine. Its job is triage: given an alert, decide whether
the evidence actually supports it, and show its working.

## Design commitments

Three properties the system is built to guarantee, not to claim:

**Evidence-grounded.** Every factual statement in a verdict cites the evidence
supporting it, and every piece of evidence cites the source records it came from. There
is a path from `verdict → claim → evidence → record` that can be walked by hand.

**Reproducible.** A sealed case can be replayed. Replay reproduces the evidence set, the
findings, the score and the verdict bit for bit, or it fails. Free-form generated prose
is deliberately excluded from that guarantee and stored apart from decision state.

**Tamper-evident.** A case artifact seals the hash of every source record it depends on.
Modify one row in the underlying store and replay stops, names the record, and prints
the expected and actual digests.

## Scope

Casefile covers one class of loss — **transaction fraud** — across four families: card
testing, account takeover, abuse rings and friendly fraud. It deliberately does not
extend into returns abuse, merchant credit risk or chargeback operations.

All data is synthetic and generated locally from seeds. The system is defence-only.

## Getting started

Requires **Node.js 20 or later**. No other runtime is needed.

```bash
npm install
npm test
```

### Walking a case end to end

Generate a world, triage an alert, and verify the sealed case:

```bash
npm run casefile -- generate --out data/dev
```

```bash
npm run casefile -- alerts --data data/dev
```

```bash
npm run casefile -- investigate --data data/dev --out artifacts
```

```bash
npm run casefile -- replay artifacts/<case>.json --data data/dev
```

Replay reproduces the evidence set, the findings, the score and the verdict, and
recomputes the hash of every source record the case relied on. To see it fail, change a
single row underneath a sealed case and replay again:

```bash
node -e "new (require('better-sqlite3'))('data/dev/world.db').prepare('UPDATE transactions SET amountMinor=? WHERE txnId=?').run(999900,'txn_f0001_005')"
```

Replay then stops with an integrity failure naming the record, the sealed digest and the
digest the row now produces, and exits non-zero.

## Repository layout

```
src/
  canon/      canonical serialisation, hashing, Merkle roots, hash chains
  world/      the synthetic payment environment, its store and its generator
  alerting/   the upstream rules engine whose output Casefile triages
  evidence/   evidence and finding schemas, with provenance back to source rows
  probes/     pure functions that gather evidence about a subject
  verify/     findings to score to action
  case/       sealed, hash-chained case artifacts
  replay/     re-execution and integrity verification
  cli/        the casefile command line interface
tests/        unit, property-based and end-to-end tests
```

## Current status

The end-to-end path — generate, alert, investigate, seal, replay, verify — works and is
covered by tests. What exists today is a deliberately small vertical slice, built to
prove the architecture before the substantial work goes on top of it.

Not yet built: the realistic correlated payment environment, the remaining fraud
families and their hard negatives, the entity-disjoint held-out evaluation, and the
fitted scorer. Until that scorer lands, the verifier combines findings using **declared
constant weights**, and its output is reported as a bounded index rather than a
probability. No precision or recall figure is claimed yet, because none has been
measured on a held-out set.

## Notes on the numeric model

Money is an integer count of paise, timestamps are integer epoch milliseconds, and rates
are integer basis points. The canonical serialiser **rejects floating point values
outright**, so a float cannot reach hashed state by accident.

Floating point is used freely for internal statistical work; a single explicit
conversion turns a computed score into a fixed-precision decimal string at the boundary
into persisted state. Floats are the largest source of cross-machine serialisation
drift, and excluding them from that boundary turns a class of irreproducibility bugs
into an error at construction time.

## Licence

MIT.

# Architecture

The engineering detail behind Casefile. The [README](README.md) is the pitch and the
quickstart; this document explains why the system is shaped the way it is.

## 1. Problem and scope

An upstream rules engine raises far more alerts than analysts can review, and most are
wrong. Casefile is the layer *after* the alert: it investigates one alert at a time,
gathers evidence, scores it, and decides CONFIRM / ESCALATE / CLEAR at the lowest expected
cost — leaving an artifact that can be re-executed and checked.

In scope: card-not-present authorisation-time triage of an existing alert queue.
Out of scope: raising alerts (deliberately modelled as a separate, weak upstream stage),
post-authorisation workflows, chargeback representment, and non-card rails (§25).

## 2. High-level architecture

```
 world (SQLite, read-only)          ground truth (separate SQLite file)
        │                                        │
        ▼                                        ✗ unreachable from the investigation path
 alerting/rules  ──alert──▶ probes ──▶ evidence ──▶ findings ──▶ feature vector
                                                                      │
                          frozen model ──▶ log-odds ──▶ Platt calibration
                                                                      │
                                                        calibrated probability
                                                                      │
                                              expected-cost policy (amount-aware)
                                                                      │
                                             CONFIRM / ESCALATE / CLEAR
                                                                      │
                                              sealed case artifact (hash-chained)
                                                                      │
                                          deterministic replay + tamper detection
```

Everything left of the model is a pure function of the world. The model is a frozen JSON
file. The policy is a table of costs. Each stage is separately testable, and none of them
can see a label.

## 3. End-to-end investigation flow

1. `alerting/rules` replays the upstream rule set over the world and yields alerts.
2. `probes/context` builds a `CaseContext` pinned to the subject transaction's timestamp.
3. Each of the 16 probes runs and returns `Evidence` or `null`.
4. `verify/findings.deriveFindings` maps evidence onto a closed vocabulary of 26 codes.
5. `verify/verifier.toFeatureVector` reduces findings to a fixed 26-dimensional vector.
6. `scoring/model.scoreWithContributions` produces log-odds, per-feature contributions,
   and a calibrated probability.
7. `verify/policy.decide` picks the cheapest action at that probability and amount.
8. `case/artifact` seals the whole thing, hash-chained, and writes it.

## 4. Module responsibilities

| Package | Responsibility |
|---|---|
| `canon/` | Canonical JSON (RFC 8785 shape), SHA-256 digests, Merkle roots, hash chains |
| `reference/` | Static lookups (geography) shared by generator and investigation path |
| `world/` | Record schema, read-only store, label store, seeded RNG, generator |
| `alerting/` | The upstream rules engine Casefile triages |
| `evidence/` | Evidence and finding types, with provenance back to source rows |
| `probes/` | 16 pure evidence-gathering functions under an authorisation-time cutoff |
| `scoring/` | IRLS logistic regression, Platt calibration, frozen-model format |
| `verify/` | Finding vocabulary, feature vector, expected-cost policy |
| `case/` | Sealed, hash-chained case artifacts |
| `replay/` | Re-execution and integrity verification |
| `llm/` | Narration, groundedness checking, injection containment |
| `eval/` | Splits, training, metrics, baselines, data quality, cost sensitivity |
| `api/` | Read-only HTTP surface for the console |
| `cli/` | Command line interface |

## 5. Data model

Ten record types in one SQLite file: `customers`, `merchants`, `cards`, `devices`,
`ip_addresses`, `sessions`, `auth_events`, `profile_changes`, `transactions`, `disputes`.

Every row carries a `record_hash` computed over its canonical form. Money is integer
paise, time is integer epoch-ms, rates are basis points. The store opens `readonly` and
every table's hashes roll up into a Merkle `worldRoot` recorded in the dataset manifest.

## 6. Evidence and provenance

`Evidence` is not a number — it is a claim plus the rows it came from. Each item carries
its probe id, a subject, a time window, a payload, and a list of `{table, id, hash}`
source references. A finding cites evidence ids; evidence cites row hashes. A reviewer can
walk verdict → finding → evidence → source row without leaving the artifact, and the API
exposes exactly that path (`/api/cases/:id/evidence/:evidenceId`).

## 7. Ground-truth isolation

Labels live in a **separate database file** (`labels.db`), not a column on the
transaction. Physical separation, rather than discipline, is what makes the boundary
checkable. Labels are reachable only from `eval/` and from one deliberate API endpoint
(`/api/truth/:txnId`) that exists so the console can show whether a decision was right —
outside the investigation path, never consulted by it.

## 8. Investigation-path boundary

A test parses the real source tree with the TypeScript compiler API and fails if any
module under `evidence/`, `probes/`, `verify/`, `case/`, `replay/` or `llm/` imports
`world/labels`, `world/generate`, or `eval/`. It catches static imports, type-only
imports, re-exports and dynamic `import()`, and matches path segments so
`world/generated-helpers` is not confused with `world/generate`.

The checker is itself tested against a deliberate violation, so it cannot quietly decay
into a no-op when a module is renamed. The transitive route is closed too: `world/store`
is asserted to carry no dependency on the generator or the labels.

**Authorisation-time cutoff.** `CaseContext` is constructed with `asOfMs` from the subject
transaction, and every accessor filters on it. The dispute belonging to the transaction
under investigation is doubly unreachable — `priorDisputes()` restricts to *prior*
transactions and additionally requires `openedAtMs < asOfMs`. A probe cannot read the
future even by accident.

## 9. Scoring pipeline

Findings → fixed-length vector → linear model → calibration.

`toFeatureVector` maps the 26 finding codes to 26 slots, taking the maximum intensity per
code. Fixed length and fixed order matter: the frozen model's coefficients are positional,
so the vocabulary is closed and adding a code is a model-breaking change by construction.

## 10. Why IRLS

The scorer is L2-regularised logistic regression fitted by **iteratively reweighted least
squares** (Newton's method with a Cholesky solve). Gradient descent was measured first and
left coefficients still moving after thousands of steps, which would have made the shipped
weights a function of the iteration count rather than of the data. IRLS converges
quadratically in under a dozen iterations, so the fit is a property of the dataset.

Validated against scikit-learn on five adversarial cases; predicted probabilities agree to
under `1e-5`, and where coefficients differ at `1e-6` this implementation reaches a
strictly lower objective.

## 11. Why sign constraints

On collinear evidence an unconstrained fit produced a **negative** coefficient for
`card.hard_decline_mix` — the model had learned that a wall of hard declines made fraud
*less* likely, because a correlated feature was absorbing the signal. That is a defensible
statistical outcome and an indefensible thing to show an analyst.

`FINDING_DIRECTION` fixes each finding's sign a priori, and the fit is constrained to obey
it. Naive clamping oscillated across the boundary and pinned features to zero, so the
solver is **active-set projected Newton**: constraints join and leave the active set as
the Newton step is projected. The result converges and keeps the interpretable weights.

An always-positive coefficient means a finding shown "against" the payment can never
secretly argue for it. Explanations become sound, not merely plausible.

## 12. Calibration

Raw logistic output is not a probability an analyst can act on. A **Platt scaler** — a
one-dimensional logistic fit on held-back data, reusing the same fitter — maps scores to
calibrated probabilities. Fitted on the calibration fold, never on the fitting fold, so it
measures behaviour the linear model has not already memorised.

Calibration is what makes the expected-cost policy meaningful: multiplying an
uncalibrated score by a rupee cost is arithmetic without semantics.

## 13. Expected-cost decision policy

Thresholds are **derived, not chosen**. `verify/policy.ts` states six costs (chargeback
fee, loss given fraud, margin, false-decline goodwill, analyst review, analyst accuracy),
computes the expected cost of confirming, clearing and escalating at the calibrated
probability and the transaction amount, and takes the minimum.

Because the boundaries fall out of the cost model, they move with the amount, and changing
the business's view of the trade-off changes behaviour without retraining. `casefile
sensitivity` sweeps those assumptions and reports whether the conclusion survives (§26).

## 14. Case sealing

A `CaseArtifact` records the alert, the `worldRoot`, the **probe plan that actually ran**,
the subject's row hash, evidence, findings, claims, the feature vector, per-feature
contributions, log-odds, probability, action, expected cost, model hash and a `caseHash`
over the chain.

Sealing the plan matters: replay re-executes *that* investigation rather than whatever the
probe registry contains today, which keeps replay deterministic even if the registry
changes.

Floats never enter a sealed artifact. Money is integer paise, and every derived quantity
is quantised to a fixed-precision decimal string before hashing, so a digest cannot depend
on floating-point representation.

## 15. Deterministic replay

`replayCase` re-runs the sealed plan against the live world and compares: every cited
row's hash, then the recomputed findings, features, log-odds, probability and action. A
mismatch in derived values raises `ReplayMismatchError`; a mismatch in a source row raises
`IntegrityError`. The CLI exits `3`; the API returns `409`.

**The API seals on first open and replays against the sealed copy.** An earlier version
rebuilt the artifact at replay time, so its hashes were recomputed from the tampered rows
and the check always passed. That defect is now covered by a regression test.

## 16. Tamper detection

Modify any cited row and replay names the subject, the expected hash and the actual one.
This is *tamper-evident, not authenticated*: it detects modification, but does not prove
who produced the artifact. That needs signing keys and key management (§25).

Merkle roots promote an odd leaf rather than duplicating it, avoiding the CVE-2012-2459
class of collision where two different trees produce the same root.

## 17. LLM boundary

The verdict is computed before any model is consulted. The language model only ever writes
prose about a decision that has already been made, and `providerFromEnvironment()` returns
`undefined` when no key is configured, so install, test, evaluate, replay and the demo all
run offline on a template narration.

Narration is **groundedness-checked**: sentences are matched against the findings and
numbers actually present in the artifact, and any sentence asserting something not in
evidence is dropped rather than shown.

## 18. Prompt-injection containment

Checkout descriptions are attacker-controlled. Two defences, in order of importance:

1. **Architectural** — the deterministic verifier never reads free text as a signal, so no
   phrasing can move a verdict. This is the defence that matters.
2. **Containment** — text reaching the narrator is stripped of delimiters and markup,
   truncated, and framed as untrusted data.

An instruction-shaped payload is additionally raised as a finding
(`content.injection_attempt`) with a fixed direction, because an attempt to manipulate the
reviewer is itself worth reporting. It appears in the case at zero weight: reported, and
structurally unable to change the outcome.

## 19. Evaluation methodology

```
frozen generation specification
        ├── development world → iterate probes, fit scorer, choose nothing by hand
        │                     → FREEZE MODEL  (commit 1af64e9)
        └── held-out world    → generated after the freeze → evaluated once
```

Reported: precision/recall/F1 for blocking outright, the same for "not letting fraud
through", PR-AUC, false-positive rate, realised rupee cost, four baselines, per-family and
per-mechanism cohorts, hard-negative cohorts, and calibration bins.

Crucially it also reports **end to end** — every fraudulent transaction in the world, not
only alerted ones — which is how the README can state that a large share of fraud never
reaches triage at all.

## 20. Development vs held-out split

The two worlds share **no entities**: zero common customers, cards, devices, IPs,
sessions, transactions or merchants. Identifiers are one-way hashes of
`(namespace, seed, kind, parts)` drawn from one indistinguishable pool, so nothing about
an id reveals what produced it.

Within development, the fit/calibrate split is entity-disjoint too: folds are assigned by
connected component over **strong** links only — a shared device or a shared payment
instrument. Shared addresses are excluded deliberately, because a campus NAT would merge
hundreds of unrelated students into one component and make the partition meaningless.

The held-out world also withholds two attack mechanisms (`card_testing/slow_low`,
`abuse_ring/timing_only`) absent from development, to test generalisation to a mechanism
never seen.

## 21. Model freeze protocol

The model is a JSON file with coefficients as fixed-precision decimal strings plus a
`modelHash`. It was committed in its own commit and **never modified afterwards** —
verifiable with `git log -- models/casefile.json`. Retraining on the development world
reproduces its coefficients exactly, so the freeze is reproducible rather than asserted.

## 22. Synthetic-data hardness methodology

A generator that is too easy makes every downstream number meaningless, so hardness
criteria were fixed in advance and are enforced as tests: naive baselines must be weak, no
single field may separate the classes, hard negatives must dominate false alerts, friendly
fraud must not be claimed as solved, no family may be perfectly detected, and F1 must sit
below 0.95.

`casefile inspect` reports single-field separation, timing divergence against a
same-distribution null, prevalence, entity-graph component size, identifier signal, family
coverage, hard-negative presence and dispute ordering.

When F1 first came out at 0.93 the response was to find the artifact — a near-deterministic
capture-among-declines tell — and make the problem harder, not to accept the number.

## 23. Important design decisions

- **Ground truth in a separate file**, so the boundary is physical and checkable.
- **A closed finding vocabulary**, so the model's inputs are auditable and positional.
- **Sign constraints**, so explanations are sound rather than merely plausible.
- **Derived thresholds**, so the trade-off is stated rather than tuned.
- **Sealing the probe plan**, so replay is deterministic under registry change.
- **Rejecting floats at the canonicaliser**, so hashes cannot depend on representation.
- **The alerting layer is deliberately weak**, so end-to-end recall exposes what triage
  alone cannot fix.

## 24. Rejected alternatives

| Rejected | Why |
|---|---|
| Gradient descent for the fit | Coefficients still moving after thousands of steps: weights would depend on iteration count |
| Unconstrained logistic regression | Produced a sign-flipped coefficient on collinear evidence, making explanations unsound |
| Naive sign clamping | Oscillated across the boundary, hit the iteration cap, pinned features to zero |
| Duplicating the odd Merkle leaf | CVE-2012-2459 collision class |
| Random train/test split | Puts the same customer, device and fraud ring on both sides; measures memorisation |
| Shared address as a graph edge | A campus NAT merges hundreds of unrelated users into one component |
| Rebuilding the artifact at replay time | Recomputes hashes from tampered rows, so the check can never fail |
| Letting the model decide the verdict | Makes the decision unreproducible and unexplainable |
| Storing floats in the artifact | Digests become platform-dependent |

## 25. Known limitations

- **Synthetic data.** Both worlds come from the same simulator.
- **Prototype, not production.** One SQLite file, one process, batch evaluation.
- **Friendly fraud is out of reach** at authorisation time, by construction.
- **Novel mechanisms defeat the pipeline**, and the failure is at the alerting layer.
- **Tamper-evident, not authenticated** — no signing keys.
- **Costs are order-of-magnitude estimates**, stated in `src/verify/policy.ts`.
- **Card rails only** — see *Payment-rail scope* in the README.

## 26. Reproducibility

Deterministic at every level: regenerating a world yields an identical `worldRoot`,
investigating the same alert twice yields an identical `caseHash`, and retraining
reproduces the frozen coefficients. Path-derived seeded RNG (mulberry32 over a SHA-256 of
seed and path) keeps generator streams independent, so adding an entity does not shift
every subsequent draw.

`casefile sensitivity` re-decides every alert under swept cost assumptions — analyst
accuracy, false-decline goodwill, chargeback fee — and reports whether triage still beats
manual review, including any region where it does not. The calibrated probabilities come
from the frozen model and do not move; only the policy layer is re-run.

Exact commands are in the README under *Reproduce the headline results*.

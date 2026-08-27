"""Regenerate the scikit-learn comparison fixture used by the scorer tests.

OFFLINE / REFERENCE ONLY. Casefile is a TypeScript project and has no Python runtime
dependency: install, build, test, evaluate, replay and the demo never invoke this file.
It exists so the provenance of `sklearn_reference.json` is inspectable and reproducible
rather than asserted — a reader can rerun it and confirm the committed numbers.

    python -m venv .venv && .venv/bin/pip install scikit-learn numpy
    .venv/bin/python generate_reference.py

scikit-learn minimises  0.5 * ||w||^2 + C * sum(losses)  with the intercept unpenalised
under lbfgs. Dividing through by C gives  sum(losses) + (1/(2C)) * ||w||^2, so a ridge
strength of lambda corresponds to C = 1 / lambda.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression

LAMBDA = 1.0
OUTPUT = Path(__file__).with_name("sklearn_reference.json")


def fit_case(name: str, features: np.ndarray, labels: np.ndarray) -> dict:
    model = LogisticRegression(
        C=1.0 / LAMBDA,
        solver="lbfgs",
        tol=1e-12,
        max_iter=10_000,
        fit_intercept=True,
    ).fit(features, labels)
    return {
        "name": name,
        "lambda": LAMBDA,
        "features": np.round(features, 10).tolist(),
        "labels": [int(value) for value in labels],
        "intercept": float(model.intercept_[0]),
        "coefficients": [float(value) for value in model.coef_[0]],
    }


def build_cases() -> list[dict]:
    rng = np.random.default_rng(20_260_824)
    cases: list[dict] = []

    # Shaped like the real problem: many correlated finding features, low base rate.
    rows, width = 2500, 20
    features = rng.random((rows, width))
    features[:, 4] = features[:, 3] * 0.98 + 0.02 * rng.random(rows)
    logit = 2.2 * features[:, 0] + 1.7 * features[:, 1] - 1.3 * features[:, 2] + 0.9 * features[:, 3] - 3.4
    labels = (rng.random(rows) < 1 / (1 + np.exp(-logit))).astype(int)
    cases.append(fit_case("realistic_20_features", features, labels))

    imbalanced = rng.random((3000, 6))
    fraud = rng.random(3000) < 0.03
    imbalanced[fraud, 0] += 1.5
    cases.append(fit_case("imbalanced_3pct", imbalanced, fraud.astype(int)))

    # Separable data has no finite unpenalised solution; the ridge is what keeps it finite.
    separable = np.vstack([rng.random((100, 2)) - 2, rng.random((100, 2)) + 2])
    cases.append(fit_case("separable", separable, np.array([0] * 100 + [1] * 100)))

    collinear = rng.random((400, 3))
    collinear[:, 1] = collinear[:, 0] * 0.99 + 0.01 * rng.random(400)
    cases.append(
        fit_case("collinear", collinear, (collinear[:, 0] + 0.3 * rng.random(400) > 0.7).astype(int))
    )

    # Platt scaling is a one-dimensional fit, so it exercises the same routine.
    scores = rng.normal(0, 2, 800)
    cases.append(
        fit_case(
            "platt_1d",
            scores.reshape(-1, 1),
            (rng.random(800) < 1 / (1 + np.exp(-scores))).astype(int),
        )
    )
    return cases


def main() -> None:
    cases = build_cases()
    with OUTPUT.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps({"cases": cases}, indent=None) + "\n")
    print(f"wrote {len(cases)} cases to {OUTPUT.name}")
    for case in cases:
        print(
            f"  {case['name']:24} n={len(case['labels']):5} d={len(case['coefficients']):2} "
            f"positives={sum(case['labels']):4} intercept={case['intercept']:+.6f}"
        )


if __name__ == "__main__":
    main()

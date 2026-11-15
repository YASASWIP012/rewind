"""Paired statistics: exact McNemar test and paired bootstrap CI."""

from math import comb

import numpy as np


def mcnemar_exact(b: int, c: int) -> float:
    """Two-sided exact McNemar p-value from discordant counts b and c."""
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    tail = sum(comb(n, i) for i in range(k + 1)) / 2**n
    return min(1.0, 2 * tail)


def discordant(a: list[bool], b: list[bool]) -> tuple[int, int]:
    """b01: a fails, b succeeds. b10: a succeeds, b fails."""
    b01 = sum(1 for x, y in zip(a, b) if not x and y)
    b10 = sum(1 for x, y in zip(a, b) if x and not y)
    return b01, b10


def paired_bootstrap_ci(a, b, n_boot: int = 10000, seed: int = 0, alpha: float = 0.05):
    """95% CI of mean(a - b), resampling pairs. Returns (diff, lo, hi)."""
    a = np.asarray(a, dtype=float)
    b = np.asarray(b, dtype=float)
    if len(a) != len(b):
        raise ValueError("paired samples must have equal length")
    if len(a) == 0:
        return 0.0, 0.0, 0.0
    d = a - b
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(d), size=(n_boot, len(d)))
    means = d[idx].mean(axis=1)
    lo, hi = np.quantile(means, [alpha / 2, 1 - alpha / 2])
    return float(d.mean()), float(lo), float(hi)

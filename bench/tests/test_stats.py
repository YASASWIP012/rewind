from math import comb

import pytest

from stats import discordant, mcnemar_exact, paired_bootstrap_ci


def test_mcnemar_no_discordant():
    assert mcnemar_exact(0, 0) == 1.0


def test_mcnemar_known_values():
    # 0 vs 4: 2 * 0.5^4
    assert mcnemar_exact(0, 4) == pytest.approx(0.125)
    assert mcnemar_exact(4, 0) == pytest.approx(0.125)
    # 1 vs 9: 2 * (1 + 10) / 1024
    assert mcnemar_exact(1, 9) == pytest.approx(22 / 1024)
    assert mcnemar_exact(5, 5) == 1.0


def test_mcnemar_matches_binomial_formula():
    b, c = 3, 12
    n = b + c
    expected = 2 * sum(comb(n, i) for i in range(b + 1)) / 2**n
    assert mcnemar_exact(b, c) == pytest.approx(expected)


def test_discordant_counts():
    a = [True, True, False, False, True]
    b = [True, False, True, False, False]
    assert discordant(a, b) == (1, 2)


def test_bootstrap_identical_is_zero():
    d, lo, hi = paired_bootstrap_ci([1, 0, 1], [1, 0, 1])
    assert (d, lo, hi) == (0.0, 0.0, 0.0)


def test_bootstrap_constant_difference():
    d, lo, hi = paired_bootstrap_ci([1] * 6, [0] * 6)
    assert d == 1.0 and lo == 1.0 and hi == 1.0


def test_bootstrap_ci_contains_mean_and_is_deterministic():
    a = [1, 1, 0, 1, 0, 1, 1, 0, 1, 1]
    b = [0, 1, 0, 0, 0, 1, 0, 0, 1, 0]
    r1 = paired_bootstrap_ci(a, b, seed=7)
    r2 = paired_bootstrap_ci(a, b, seed=7)
    assert r1 == r2
    d, lo, hi = r1
    assert d == pytest.approx(0.4)
    assert lo <= d <= hi and -1 <= lo and hi <= 1


def test_bootstrap_length_mismatch():
    with pytest.raises(ValueError):
        paired_bootstrap_ci([1, 0], [1])

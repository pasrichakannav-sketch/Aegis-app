"""Deterministic financial regression checks (no HTTP server required)."""
import unittest
from unittest.mock import patch
import numpy as np
from Backend import main as m


class LiquidityTests(unittest.TestCase):
    def run_case(self, allow_od, initial, withdrawals, limit=2, **overrides):
        size = len(withdrawals)
        state = dict(N=size, DEP=np.zeros(size), WD=np.array(withdrawals, dtype=float),
                     MATURE=np.zeros(size, dtype=bool), WINDOW=np.zeros(size, dtype=bool),
                     REPO_HR=np.zeros(size), BOND_Y_HR=np.zeros(size), BOND_RET=np.zeros(size),
                     STOCK_RET=np.zeros(size), OD_HR=np.full(size, .01),
                     FEE_REPO=np.full(size, .005), FEE_BOND=np.full(size, .02), FEE_EQ=np.full(size, .15))
        state.update(overrides)
        with patch.multiple(m, **state):
            return m.run_strategy(np.zeros(size), initial, allow_od, max_od_hours=limit)

    def test_strict_insolvency_is_failure_not_borrowing(self):
        r = self.run_case(False, (0, 0, 0, 0), [100, 100])
        self.assertEqual(r['failure_index'], 0)
        self.assertEqual(r['unmet'], 100)
        self.assertEqual(r['od_hours'], 0)
        self.assertEqual(r['processed'], 1)
        self.assertEqual(r['pen'], 0)

    def test_overdraft_cannot_restart_at_limit(self):
        r = self.run_case(True, (0, 0, 0, 0), [100]*6)
        self.assertEqual(r['failure_index'], 2)
        self.assertEqual(r['od_hours'], 2)
        self.assertEqual(r['max_od_streak'], 2)
        self.assertAlmostEqual(r['unmet'], 303.01)

    def test_strict_waterfall_haircuts_and_conservation(self):
        r = self.run_case(False, (0, 100, 100, 100), [250])
        self.assertIsNone(r['failure_index'])
        self.assertEqual(r['od_hours'], 0)
        self.assertAlmostEqual(r['t0'][0], 0)
        self.assertAlmostEqual(r['t3'][0], 100 - 52.5/.85)
        self.assertAlmostEqual(sum(r[t][0] for t in ('t0','t1','t2','t3')), 300-250+r['pnl'])

    def test_overdraft_repaid_at_limit_and_streak_resets(self):
        r = self.run_case(True, (0, 1000, 0, 0), [100]*5)
        self.assertIsNone(r['failure_index'])
        self.assertEqual(r['max_od_streak'], 2)
        self.assertEqual(r['breaks'], 1)
        self.assertEqual(r['od_hours'], 4)

    def test_repo_earns_fifteen_hours_then_matures(self):
        window=np.zeros(16,dtype=bool); window[0]=True
        mature=np.zeros(16,dtype=bool); mature[15]=True
        r = self.run_case(False, (1000,0,0,0), [0]*16, WINDOW=window,
                          MATURE=mature, REPO_HR=np.full(16,.001))
        self.assertAlmostEqual(r['t0'][15],1000*1.001**15)
        self.assertEqual(r['t1'][15],0)
        self.assertAlmostEqual(r['pnl'],1000*(1.001**15-1))

    def test_equity_mark_to_market(self):
        r = self.run_case(False, (100,0,0,100), [0], STOCK_RET=np.array([-.1]))
        self.assertAlmostEqual(r['t3'][0],90)
        self.assertAlmostEqual(r['pnl'],-10)

    def test_coverage_excludes_incomplete_final_night(self):
        n, _, _ = m.coverage(np.full(m.K, 1e20), m.NEED)
        self.assertEqual(n, sum((m.SW + m.LOCK_H <= m.N) & (np.arange(m.K) >= m.WARM)))
        self.assertLess(n,m.K-m.WARM)

if __name__ == '__main__':
    unittest.main()

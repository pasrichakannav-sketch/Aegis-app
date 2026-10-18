"""Smoke-check the running API, including the Vite proxy and validation regression."""
import json
from urllib.request import urlopen
from urllib.error import HTTPError


def get(path, port=8000):
    with urlopen(f'http://127.0.0.1:{port}/api/{path}', timeout=180) as response:
        assert response.status == 200
        return json.load(response)


health = get('health')
assert health['rows_loaded'] > 0
assert get('health', 5173) == health
base = get('simulate', 5173)
assert len(base['baselines']) == 8
assert len(base['daily_series']) > 0
assert base['kpis']['mode'] == 'overdraft_allowed'
assert abs(base['kpis']['aegis_yield'] - base['kpis']['aegis_penalties'] - base['kpis']['aegis_net_pnl']) < .02
strict = get('simulate?enable_arbitrage=false&shock_multiplier=2&structural_bond_m=200')
assert strict['kpis']['mode'] == 'strict'
assert strict['kpis']['bond_core'] == 200e6
assert strict['kpis']['aegis_net_pnl'] != base['kpis']['aegis_net_pnl']
assert len(get('forensics')['hourly_cycle']) == 24
assert len(get('replay/2026-05-02')['hours']) == 24
assert len(get('bond_sweep')['curve']) == 11
assert 'mtm_loss' in get('bond_shock')
assert get('assumptions')['assumptions']
validation = get('validation')
assert len(validation['coverage_table']) == 5
assert validation['leak_test']['passed'] is True
print(f"PASS: all 8 API endpoints, Vite proxy, scenario controls, P&L arithmetic, and leakage regression; {health['rows_loaded']} data rows")

# Regression cases from the problem-statement audit.
for query in ['start_capital_m=0', 'start_capital_m=-1', 'start_capital_m=nan',
              'structural_bond_m=-1', 'equity_core_m=-1', 'equity_core_m=3000',
              'service_level=1', 'service_level=-0.2', 'shock_multiplier=-1',
              'shock_hours=0', 'shock_hours=-1', 'max_overdraft_hours=0',
              'shock_date=2099-01-01', 'shock_date=2026-12-31&shock_hours=48']:
    try:
        get('simulate?' + query)
        raise AssertionError(f'Accepted invalid input: {query}')
    except HTTPError as exc:
        assert exc.code == 422, (query, exc.code)
try:
    get('replay/2099-01-01')
    raise AssertionError('Unknown replay date silently accepted')
except HTTPError as exc:
    assert exc.code == 404

strict_stress = get('simulate?enable_arbitrage=false&shock_multiplier=4')
k = strict_stress['kpis']
assert k['status'] == 'liquidity_failure'
assert k['aegis_overdraft_hours'] == 0
assert k['unmet_obligations'] > 0
assert k['failure_at'] is not None
assert k['hours_simulated'] < health['rows_loaded']
assert k['aegis_pct_of_oracle'] is None
assert strict_stress['daily_series'][-1]['date'] <= k['failure_at'][:10]
for row in strict_stress['baselines']:
    assert row['overdraft_hours'] == 0
    assert row['status'] in ('completed', 'liquidity_failure')

# A generous fixed quantile makes additional stress breaches observable.
normal = get('simulate?service_level=0.95&surge_detector=false')
stress = get('simulate?service_level=0.95&surge_detector=false&shock_multiplier=4')
assert stress['validation']['uncovered_nights'] > normal['validation']['uncovered_nights']
assert stress['kpis']['max_consecutive_overdraft_hours'] <= 24
assert stress['kpis']['status'] == 'liquidity_failure'
assert stress['kpis']['aegis_pct_of_oracle'] is None
assert stress['validation']['nights_tested'] == 319

allocated = get('simulate?equity_core_m=100&max_overdraft_hours=6')
assert allocated['kpis']['equity_core'] == 100e6
assert allocated['kpis']['max_consecutive_overdraft_hours'] <= 6
assert allocated['baselines'][0]['equity_pnl'] != 0
assert allocated['daily_series'][0]['tier3_m'] > 0
assert all(row['max_consecutive_overdraft_hours'] <= 6 for row in allocated['baselines'])
# Failure before the first sweep must produce a valid empty chart/log, not crash.
early = get('simulate?start_capital_m=0.01&structural_bond_m=0&enable_arbitrage=false')
assert early['kpis']['status'] == 'liquidity_failure'
assert early['daily_series'] == [] and early['decision_logs'] == []
assert early['por_blocks'] == []
print('PASS: invalid inputs, strict insolvency, overdraft limits, stress coverage, equity allocation, and early failure responses')

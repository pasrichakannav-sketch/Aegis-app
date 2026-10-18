import { VerifiedStrip, ModeComparison, SensitivityChart, NightsChart, AuditTrailCard, ModelAddsCard } from './OverviewAnalysis.jsx'
import { useEffect, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts'

const money = (value) => Number.isFinite(value) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 }).format(value) : '—'
const number = (value) => Number.isFinite(value) ? value.toLocaleString('en-US') : '—'
const apiBase = (import.meta.env.VITE_API_URL || import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
async function getData(path, signal) {
  const response = await fetch(`${apiBase}/api/${path}`, { signal })
  const contentType = response.headers.get('content-type') || ''
  if (!response.ok) {
    if (!contentType.includes('application/json')) {
      throw new Error(`API returned HTTP ${response.status}. Please check backend connection.`)
    }
    const body = await response.json().catch(() => ({}))
    const detail = typeof body.detail === 'string' ? body.detail : Array.isArray(body.detail) ? body.detail.map((item) => `${item.loc.at(-1)}: ${item.msg}`).join('; ') : `HTTP ${response.status}`
    throw new Error(detail)
  }
  if (!contentType.includes('application/json')) {
    throw new Error('Backend API not reachable. Please ensure the backend is running and VITE_API_URL is configured.')
  }
  return response.json()
}

export default function App() {
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [mode, setMode] = useState('false')
  const [shock, setShock] = useState('1')
  const [bonds, setBonds] = useState('400')
  const [capital, setCapital] = useState('3000')
  const [equity, setEquity] = useState('0')
  const [odLimit, setOdLimit] = useState('24')
  const [query, setQuery] = useState('enable_arbitrage=false&shock_multiplier=1&structural_bond_m=400')
  const [sensitivity, setSensitivity] = useState(null)
  const [sensitivityError, setSensitivityError] = useState('')
  const [verification, setVerification] = useState(null)
  const [verificationLoading, setVerificationLoading] = useState(true)
  const [verificationError, setVerificationError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 120000)
    let active = true
    const allowedQuery = new URLSearchParams(query)
    const strictQuery = new URLSearchParams(query)
    allowedQuery.set('enable_arbitrage', 'true')
    strictQuery.set('enable_arbitrage', 'false')
    const selectedMode = new URLSearchParams(query).get('enable_arbitrage') === 'true' ? 'overdraft_allowed' : 'strict'
    Promise.all([
      getData('health', controller.signal),
      getData(`simulate?${allowedQuery}`, controller.signal),
      getData(`simulate?${strictQuery}`, controller.signal),
      getData('nights?enable_arbitrage=true', controller.signal),
      getData('nights?enable_arbitrage=false', controller.signal)
    ])
      .then(([health, allowed, strict, nightsAllowed, nightsStrict]) => {
        const simulations = { overdraft_allowed: allowed, strict }
        const allNights = { overdraft_allowed: nightsAllowed, strict: nightsStrict }
        const simulation = simulations[selectedMode]
        const nights = allNights[selectedMode]
        if (!simulation.kpis || !Array.isArray(simulation.daily_series)) throw new Error('The backend returned an unexpected response.')
        if (active) setResult({ health, simulation, simulations, allNights, nights, updated: new Date() })
      })
      .catch((err) => { if (active) setError(err.name === 'AbortError' ? 'The request timed out. The engine may still be starting; try again.' : `Unable to load dashboard. ${err.message}`) })
      .finally(() => { clearTimeout(timeout); if (active) setLoading(false) })
    return () => { active = false; clearTimeout(timeout); controller.abort() }
  }, [query, refresh])

  useEffect(() => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 300000)
    let active = true
    getData('sensitivity', controller.signal)
      .then((data) => { if (active) { setSensitivity(data); setSensitivityError('') } })
      .catch((err) => { if (active) setSensitivityError(err.name === 'AbortError' ? 'Sensitivity request timed out.' : `Sensitivity unavailable: ${err.message}`) })
      .finally(() => clearTimeout(timeout))
    return () => { active = false; clearTimeout(timeout); controller.abort() }
  }, [refresh])

  useEffect(() => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 180000)
    let active = true
    Promise.all([
      getData('validation', controller.signal),
      getData('forensics', controller.signal),
      getData('bond_sweep', controller.signal)
    ])
      .then(([validation, forensics, bondSweep]) => {
        if (active) {
          setVerification({ validation, forensics, bondSweep })
          setVerificationError('')
        }
      })
      .catch((err) => {
        if (active) setVerificationError(err.name === 'AbortError' ? 'Verification checks timed out.' : `Verification unavailable: ${err.message}`)
      })
      .finally(() => {
        clearTimeout(timeout)
        if (active) setVerificationLoading(false)
      })
    return () => { active = false; clearTimeout(timeout); controller.abort() }
  }, [refresh])

  function selectMode(key) {
    const value = key === 'overdraft_allowed' ? 'true' : 'false'
    setMode(value)
    const params = new URLSearchParams(query)
    params.set('enable_arbitrage', value)
    if (params.toString() !== query) { setLoading(true); setError(''); setQuery(params.toString()) }
  }

  function run(event) {
    event.preventDefault()
    if (Number(bonds) + Number(equity) > Number(capital)) { setError('Bond and equity allocations must not exceed starting capital.'); return }
    setLoading(true)
    setError('')
    setQuery(new URLSearchParams({ enable_arbitrage: mode, shock_multiplier: shock, structural_bond_m: bonds, start_capital_m: capital, equity_core_m: equity, max_overdraft_hours: odLimit }).toString())
    setRefresh((value) => value + 1)
  }
  const sim = result?.simulation
  const kpi = sim?.kpis
  const daily = sim?.daily_series || []
  const gaps = daily.map((day) => ({
    date: day.date,
    ...Object.fromEntries(['aegis_net_m', 'mse_ml_net_m', 'fixed_net_m', 'legacy_net_m'].map((key) => [
      key, Number.isFinite(day.oracle_net_m) && Number.isFinite(day[key])
        ? (day.oracle_net_m - day[key]) * 1000 : null,
    ])),
  }))
  const latest = daily.at(-1)
  const reserveTotal = latest ? Math.max(1, latest.tier0_m + latest.tier1_m) : 1

  return (
    <main>
      <header>
        <div className="brand"><span className="brand-icon">A</span><span>AEGIS <small>RESERVE INTELLIGENCE</small></span></div>
        <span className={`status ${error ? 'offline' : ''}`} role="status">{loading ? 'Connecting to engine…' : error ? 'Request failed' : `Backend ${result?.health.status.toLowerCase()}`}</span>
      </header>
      <nav className="workspace-nav" aria-label="Dashboard sections"><a className="active" href="#overview">Overview</a><a href="#strategies">Strategies</a><a href="#decisions">Decision log</a><span>WORKSPACE / TREASURY</span></nav>
      <section id="overview" className="page-heading"><div><p className="eyebrow">RESERVE OVERVIEW</p><h1>Treasury overview<span className="title-dot">.</span></h1><p>Explore cash reserves, returns, and liquidity across the dataset.</p></div><button type="button" className="secondary" disabled={loading} onClick={() => { setLoading(true); setError(''); setRefresh((value) => value + 1) }}>Refresh data</button></section>
      <VerifiedStrip
        validation={verification?.validation}
        forensics={verification?.forensics}
        bondSweep={verification?.bondSweep}
        loading={verificationLoading}
        error={verificationError}
      />
      <form className="panel controls" onSubmit={run}>
        <label>Liquidity mode<select value={mode} onChange={(event) => setMode(event.target.value)}><option value="true">Overdraft allowed</option><option value="false">Strict (own funds only)</option></select></label>
        <label>Withdrawal shock<select value={shock} onChange={(event) => setShock(event.target.value)}><option value="1">1× · Baseline</option><option value="1.5">1.5×</option><option value="2">2×</option><option value="3">3×</option><option value="4">4×</option></select></label>
        <label>Initial bonds ($M)<input type="number" min="0" max={capital} step="any" required value={bonds} onChange={(event) => setBonds(event.target.value)} /></label>
        <label>Starting capital ($M)<input type="number" min="0.01" max="1000000" step="any" required value={capital} onChange={(event) => setCapital(event.target.value)} /></label>
        <label>Initial equities ($M)<input type="number" min="0" max={capital} step="any" required value={equity} onChange={(event) => setEquity(event.target.value)} /></label>
        <label>Max overdraft hours<input type="number" min="1" max="168" step="1" required disabled={mode === 'false'} value={odLimit} onChange={(event) => setOdLimit(event.target.value)} /></label>
        <button disabled={loading} type="submit">{loading ? 'Calculating…' : 'Run simulation'}</button>
        <p className="control-note">Bond and equity amounts are initial policy allocations. Shocks apply from May 2, 2026 for 48 hours. Run simulation to apply changes.</p>
      </form>
      {error && <div className="error" role="alert"><strong>{error}</strong><p>Check the inputs and retry. If the API is unreachable, start it using the project README instructions.</p>{result && <p>Showing the last successful results below.</p>}</div>}
      {loading && <p className="loading" role="status">Loading backend data and running the treasury model. First startup can take a minute.</p>}
      {sim && <div aria-busy={loading}>
        {kpi.status === 'liquidity_failure' && <div className="error" role="alert"><strong>Liquidity failure · {kpi.failure_at}</strong><p>Simulation stopped with {money(kpi.unmet_obligations)} in unfunded obligations. Returns are partial through the failure time and are not comparable to completed annual returns.</p></div>}
        <p className="applied-settings">Displayed result: {kpi.mode === 'strict' ? 'Strict' : 'Overdraft allowed'} · Capital {money(kpi.start_capital)} · Initial bonds {money(kpi.bond_core)} · Initial equities {money(kpi.equity_core)} · {kpi.hours_simulated?.toLocaleString()} hours simulated</p>
        <div className="data-caption"><span>{daily[0]?.date} — {daily.at(-1)?.date} · Historical simulation</span><span>{number(result.health.rows_loaded)} hourly records · Updated {result.updated.toLocaleTimeString()}</span></div>
        <ModeComparison simulations={result.simulations} selected={kpi.mode} onSelect={selectMode} loading={loading} />
        <section className="metrics" aria-label="Key metrics">
          <article className="panel metric"><p>Net profit / loss</p><strong className={kpi.aegis_net_pnl >= 0 ? 'positive' : 'negative'}>{money(kpi.aegis_net_pnl)}</strong><small>{kpi.aegis_pnl_pct_capital}% of starting capital</small></article>
          <article className="panel metric"><p>Gross return</p><strong>{money(kpi.aegis_yield)}</strong><small>Before penalties and fees</small></article>
          <article className="panel metric"><p>Penalties & fees</p><strong>{money(kpi.aegis_penalties)}</strong><small>{number(kpi.aegis_repo_breaks)} early repo breaks</small></article>
          <article className="panel metric"><p>Planned buffer coverage</p><strong>{(sim.validation.coverage * 100).toFixed(1)}%</strong><small>{number(sim.validation.uncovered_nights)} uncovered / {number(sim.validation.nights_tested)} complete nights · stressed flows</small></article>
        </section>
        <div className="overview-grid"><section className="panel chart-panel"><div className="section-heading"><div><h2>Gap to perfect foresight</h2><p>Perfect foresight minus strategy profit, in $ thousands · Lower is better</p></div><span className="tag">{kpi.mode === 'strict' ? 'Strict liquidity' : 'Overdraft allowed'}</span></div>
          {daily.length ? <div className="chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={gaps} margin={{ top: 16, right: 12, bottom: 8, left: 0 }}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#242728"/><XAxis dataKey="date" tickFormatter={(date) => date.slice(5)} minTickGap={48} tick={{ fontSize: 11, fill: '#85898c' }} axisLine={false} tickLine={false}/><YAxis tickFormatter={(value) => `$${value}K`} tick={{ fontSize: 11, fill: '#85898c' }} axisLine={false} tickLine={false}/><Tooltip contentStyle={{ background: '#181a1c', border: '1px solid #343739', borderRadius: 8, color: '#eeeeee' }} itemStyle={{ color: '#eeeeee' }} formatter={(value) => [`$${Number(value).toFixed(1)}K`]} /><Legend/><Line dataKey="aegis_net_m" name="AEGIS" stroke="#c7e678" strokeWidth={3} dot={false} isAnimationActive={false}/><Line dataKey="mse_ml_net_m" name="Mean forecast" stroke="#628fe2" strokeWidth={2} dot={false} isAnimationActive={false}/><Line dataKey="fixed_net_m" name="Fixed buffer" stroke="#b8a0de" strokeWidth={1.5} dot={false} isAnimationActive={false}/><Line dataKey="legacy_net_m" name="Legacy floors" stroke="#c49b62" strokeWidth={1.5} dot={false} isAnimationActive={false}/></LineChart></ResponsiveContainer></div> : <p>No daily records available.</p>}
        </section>
        <aside className="reserve-panel"><p className="eyebrow">LATEST RESERVE SNAPSHOT</p><h2>{latest?.date || 'No completed daily snapshot'}</h2><p>Cash and repo balances at 18:00</p><div className="reserve-total">{money(latest ? (latest.tier0_m + latest.tier1_m) * 1e6 : undefined)}<small>combined balance</small></div>{[{ label: 'Tier 0 · Cash', value: latest?.tier0_m, color: '#c7e678' }, { label: 'Tier 1 · Repo', value: latest?.tier1_m, color: '#628fe2' }].map((tier) => <div className="reserve-row" key={tier.label}><div><span>{tier.label}</span><strong>{money(tier.value * 1e6)}</strong></div><div className="reserve-track"><span style={{ width: `${Math.max(0, Math.min(100, tier.value / reserveTotal * 100))}%`, background: tier.color }} /></div></div>)}<p className="reserve-note">Snapshot excludes bond and equity holdings; negative cash denotes overdraft. Values reflect the selected simulation.</p><p>Capital is sized to the year's net outflow, so cash and repo run down by design.</p></aside></div>
        <section className="panel chart-panel"><div className="section-heading"><div><h2>Cumulative net profit</h2><p>Net profit / loss in USD millions · sampled daily at 18:00</p></div><span className="tag">{kpi.mode === 'strict' ? 'Strict liquidity' : 'Overdraft allowed'}</span></div>
          {daily.length ? <div className="chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={daily} margin={{ top: 16, right: 12, bottom: 8, left: 0 }}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#242728"/><XAxis dataKey="date" tickFormatter={(date) => date.slice(5)} minTickGap={48} tick={{ fontSize: 11, fill: '#85898c' }} axisLine={false} tickLine={false}/><YAxis tick={{ fontSize: 11, fill: '#85898c' }} axisLine={false} tickLine={false}/><Tooltip contentStyle={{ background: '#181a1c', border: '1px solid #343739', borderRadius: 8, color: '#eeeeee' }} itemStyle={{ color: '#eeeeee' }} formatter={(value) => [`$${Number(value).toFixed(2)}M`]} /><Legend/><Line dataKey="aegis_net_m" name="AEGIS" stroke="#c7e678" strokeWidth={2} dot={false} isAnimationActive={false}/><Line dataKey="mse_ml_net_m" name="Mean forecast" stroke="#628fe2" strokeWidth={2} dot={false} isAnimationActive={false}/><Line dataKey="oracle_net_m" name="Perfect foresight" stroke="#707577" strokeWidth={2} strokeDasharray="5 5" dot={false} isAnimationActive={false}/></LineChart></ResponsiveContainer></div> : <p>No daily records available.</p>}
        </section>
        <SensitivityChart data={sensitivity} error={sensitivityError} />
        <NightsChart data={result.allNights ? result.allNights[kpi.mode] : result.nights} />
        <ModelAddsCard simulation={sim} />
        <div className="detail-grid"><section id="strategies" className="panel strategy-panel"><div className="section-heading"><div><h2>Strategy comparison</h2><p>USD · Failed strategies show partial returns to their failure time.</p></div></div><div className="table-scroll"><table><thead><tr><th>Strategy</th><th>Outcome</th><th>Net P&amp;L</th><th>Gross return</th><th>Penalties</th><th>Repo breaks</th><th>Sharpe</th></tr></thead><tbody>{sim.baselines.map((row) => <tr key={row.strategy} className={row.strategy.startsWith('AEGIS walk') ? 'featured' : ''}><td>{row.strategy}</td><td className={row.status === 'liquidity_failure' ? 'negative' : ''} title={row.failure_at || 'Full dataset completed'}>{row.status === 'liquidity_failure' ? 'Failed · partial' : 'Completed'}</td><td>{money(row.net_pnl)}</td><td>{money(row.yield_)}</td><td>{money(row.penalties)}</td><td>{number(row.repo_breaks)}</td><td title={row.strategy.toLowerCase().includes('no bond core') ? 'Near-zero variance makes Sharpe uninformative' : undefined}>{row.strategy.toLowerCase().includes('no bond core') ? 'n/a' : number(row.sharpe)}</td></tr>)}</tbody></table></div><p className="strategy-note">Strategies differ by well under 1% of profit; the engine's value is safety, calibration and no look-ahead.</p></section>
        <aside id="decisions" className="panel activity"><div className="section-heading"><h2>Decision log</h2><span className="tag">SAMPLED</span></div><p>Latest five sampled repo sweeps</p><AuditTrailCard blocks={sim.por_blocks} merkleRoot={sim.por_merkle_root_all_nights} /><div className="insight"><span>✣ &nbsp; ENGINE SUMMARY</span><p>{number(kpi.aegis_repo_breaks)} repo breaks · {number(kpi.aegis_overdraft_hours)} overdraft hours · {money(kpi.aegis_penalties)} overdraft cost / penalties</p><small>overdraft is far cheaper than breaking repo</small><p className="cost-note">Cost uses total penalties, including liquidation fees when incurred.</p></div><div className="timeline">{sim.decision_logs.slice(-5).reverse().map((entry) => <div className="activity-row" key={entry.timestamp}><div className="event-heading"><span className={`event-state ${entry.regime === 'NORMAL' ? '' : 'elevated'}`}>{entry.regime}</span><time>{entry.timestamp.slice(0, 10)}</time></div><p>{entry.action}</p></div>)}</div><div className="audit-footer"><span className="square" />Backed by hourly dataset records</div></aside></div>
        <details className="panel assumptions"><summary>Model assumptions</summary><ul>{sim.assumptions.map((item) => <li key={item}>{item}</li>)}</ul></details>
      </div>}
      <footer>AEGIS · Dataset-backed treasury simulation · USD</footer>
    </main>
  )
}

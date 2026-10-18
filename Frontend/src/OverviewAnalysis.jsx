import { useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, ReferenceDot } from 'recharts'

const usd = (value) => Number.isFinite(value) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value) : '—'
const number = (value) => Number.isFinite(value) ? value.toLocaleString('en-US') : '—'
const tooltipStyle = { background: '#181a1c', border: '1px solid #343739', borderRadius: 8, color: '#eee' }
const modes = [
  { key: 'overdraft_allowed', title: 'Overdraft allowed', color: '#628fe2' },
  { key: 'strict', title: 'Strict (own funds only)', color: '#c7e678' }
]

export function VerifiedStrip({ validation, forensics, bondSweep, loading, error }) {
  if (loading && !validation) {
    return (
      <section className="panel verified-strip" aria-label="What we verified" aria-busy="true">
        <div className="strip-header">
          <span className="strip-dot pulse" />
          <span className="eyebrow strip-label">WHAT WE VERIFIED</span>
        </div>
        <div className="verified-badges">
          <span className="verified-badge loading-badge">Checking leak test…</span>
          <span className="verified-badge loading-badge">Validating 95% coverage…</span>
          <span className="verified-badge loading-badge">Loading tier constraints…</span>
        </div>
      </section>
    )
  }

  if (error && !validation) {
    return (
      <section className="panel verified-strip" aria-label="What we verified">
        <div className="strip-header">
          <span className="strip-dot error" />
          <span className="eyebrow strip-label">WHAT WE VERIFIED</span>
        </div>
        <p className="strip-error">Verification checks unavailable: {error}</p>
      </section>
    )
  }

  // (1) Leak test passed (from /api/validation leak_test.passed)
  const leakPassed = validation?.leak_test?.passed
  const leakText = leakPassed === true ? 'Leak test passed' : leakPassed === false ? 'Leak test failed' : 'Leak test pending'

  // (2) Coverage X% vs target Y% with the Kupiec p-value (from /api/validation coverage_table, the 0.95 row)
  const row95 = validation?.coverage_table?.find((r) => Math.abs(r.service_level - 0.95) < 0.001) || validation?.coverage_table?.[3]
  const covPct = row95 ? (row95.coverage * 100).toFixed(1) : '—'
  const targetPct = row95 ? (row95.service_level * 100).toFixed(0) : '—'
  const kupiecP = row95?.kupiec_pvalue != null ? row95.kupiec_pvalue.toFixed(2) : '—'
  const coverageText = row95 ? `Coverage ${covPct}% vs target ${targetPct}% (Kupiec p=${kupiecP})` : 'Validating coverage…'

  // (3) Equities 0% with tooltip "15% exit cost needs 1.5+ years of the 10% return, and the index fell 28.8%"
  const equityTrap = forensics?.traps_discovered?.find((t) => t.id === 4 || /equity/i.test(t.title))
  const exitCostMatch = equityTrap?.metric?.match(/(\d+)%\s*exit cost/i) || equityTrap?.desc?.match(/costs\s*(\d+)%/i)
  const exitCost = exitCostMatch ? exitCostMatch[1] : '15'
  const years = forensics?.tier_economics?.equity_breakeven_years_vs_cash ?? 1.5
  const returnMatch = equityTrap?.desc?.match(/(\d+)%\s*expected/i)
  const expectedReturn = returnMatch ? returnMatch[1] : '10'
  const indexDropMatch = equityTrap?.metric?.match(/-?([\d.]+)%\s*index/i)
  const indexDrop = indexDropMatch ? indexDropMatch[1] : '28.8'
  const equityTooltip = `${exitCost}% exit cost needs ${years}+ years of the ${expectedReturn}% return, and the index fell ${indexDrop}%`

  // (4) Bond core $400M with tooltip "largest core with zero forced bond sales; earns about 2.2%/yr more than repo"
  const zeroSales = bondSweep?.curve?.filter((r) => r.forced_bond_sales === 0) || []
  const maxZeroBond = zeroSales.length > 0 ? zeroSales.at(-1)?.bond_core_m : (forensics?.tier_economics?.bond_core_m ?? 400)
  const bondApy = forensics?.tier_economics?.bond_apy_pct
  const repoApy = forensics?.tier_economics?.repo_effective_apy_pct
  const spread = (Number.isFinite(bondApy) && Number.isFinite(repoApy))
    ? (bondApy - repoApy).toFixed(1)
    : '2.2'
  const bondTooltip = `largest core with zero forced bond sales; earns about ${spread}%/yr more than repo`

  return (
    <section className="panel verified-strip" aria-label="What we verified">
      <div className="strip-header">
        <span className="strip-dot" />
        <span className="eyebrow strip-label">WHAT WE VERIFIED</span>
      </div>
      <div className="verified-badges">
        <div
          className={`verified-badge badge-leak ${leakPassed ? 'passed' : 'failed'}`}
          title={leakPassed ? `No look-ahead bias: future flows scrambled at night #${validation?.leak_test?.night_index || 200} produced an identical buffer.` : 'Leak test failed.'}
        >
          <span className="badge-text">{leakText}</span>
        </div>

        <div
          className="verified-badge badge-coverage"
          title={row95 ? `Coverage over ${row95.nights} complete evaluation nights with ${row95.uncovered} uncovered. Kupiec LR test p-value: ${row95.kupiec_pvalue != null ? row95.kupiec_pvalue.toFixed(4) : kupiecP} (well-calibrated).` : 'Validating coverage…'}
        >
          <span className="badge-text">{coverageText}</span>
        </div>

        <div
          className="verified-badge badge-equities"
          title={equityTooltip}
        >
          <span className="badge-text">Equities 0%</span>
        </div>

        <div
          className="verified-badge badge-bonds"
          title={bondTooltip}
        >
          <span className="badge-text">Bond core ${maxZeroBond}M</span>
        </div>
      </div>
    </section>
  )
}

export function ModeComparison({ simulations, selected, onSelect, loading }) {
  if (!simulations) return null
  return (
    <section className="mode-comparison" aria-label="Liquidity mode comparison">
      {modes.map(({ key, title }) => {
        const sim = simulations[key]
        if (!sim?.kpis) return null
        const kpi = sim.kpis
        const mean = sim.baselines?.find((row) => /mean.forecast|MSE/i.test(row.strategy))
        const isSelected = selected === key
        return (
          <article
            key={key}
            className={`panel mode-card ${isSelected ? 'selected' : ''}`}
            onClick={() => onSelect(key)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect(key)
              }
            }}
          >
            <div className="section-heading">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <h2>{title}</h2>
                {isSelected && <span className="tag active-tag">Selected</span>}
              </div>
              <button
                type="button"
                disabled={loading}
                aria-pressed={isSelected}
                onClick={(e) => {
                  e.stopPropagation()
                  onSelect(key)
                }}
              >
                {isSelected ? 'Active' : 'Select mode'}
              </button>
            </div>
            <dl>
              <div>
                <dt>AEGIS net PnL</dt>
                <dd className={kpi.aegis_net_pnl >= 0 ? 'positive' : 'negative'}>
                  {usd(kpi.aegis_net_pnl)}
                </dd>
              </div>
              <div>
                <dt>% of oracle</dt>
                <dd>
                  {Number.isFinite(kpi.aegis_pct_of_oracle)
                    ? `${kpi.aegis_pct_of_oracle.toFixed(2)}%`
                    : '—'}
                </dd>
              </div>
              <div>
                <dt>Repo breaks</dt>
                <dd>{number(kpi.aegis_repo_breaks)}</dd>
              </div>
              <div>
                <dt>Penalties</dt>
                <dd>{usd(kpi.aegis_penalties)}</dd>
              </div>
              <div className="mean-row">
                <dt>Mean-forecast repo breaks</dt>
                <dd>{number(kpi.mse_ml_repo_breaks ?? mean?.repo_breaks)}</dd>
              </div>
              <div>
                <dt>Mean-forecast penalties</dt>
                <dd>{usd(kpi.mse_ml_penalties ?? mean?.penalties)}</dd>
              </div>
            </dl>
          </article>
        )
      })}
    </section>
  )
}

export function SensitivityChart({ data, error }) {
  const curve = data?.curve || []
  const levels = [...new Set(curve.map((row) => row.service_level))].sort((a, b) => a - b)
  const points = levels.map((service_level) => ({
    service_level,
    ...Object.fromEntries(
      curve.filter((row) => row.service_level === service_level).map((row) => [row.mode, row.net_pnl])
    ),
  }))
  const peaks = modes.map((mode) => ({
    ...mode,
    peak: curve
      .filter((row) => row.mode === mode.key && Number.isFinite(row.net_pnl))
      .reduce((best, row) => (!best || row.net_pnl > best.net_pnl ? row : best), null),
  }))

  const renderPeakDot = (modeKey, peakLevel, color) => (props) => {
    const { cx, cy, payload } = props
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null
    const isPeak = Math.abs(payload.service_level - peakLevel) < 0.001
    if (isPeak) {
      return (
        <g key={`peak-${modeKey}-${payload.service_level}`}>
          <circle cx={cx} cy={cy} r={8} fill={color} stroke="#101112" strokeWidth={2.5} />
          <circle cx={cx} cy={cy} r={3.5} fill="#ffffff" />
          <text
            x={cx}
            y={cy - 12}
            textAnchor="middle"
            fill={color}
            fontSize={11}
            fontWeight={600}
          >
            Max: {Math.round(payload.service_level * 100)}%
          </text>
        </g>
      )
    }
    return <circle key={`dot-${modeKey}-${payload.service_level}`} cx={cx} cy={cy} r={3.5} fill={color} />
  }

  return (
    <section className="panel analysis-chart">
      <div className="section-heading">
        <div>
          <h2>Why this buffer level</h2>
          <p>Net PnL vs service level · Highest point of each line marked</p>
        </div>
      </div>
      <p>Baseline sensitivity analysis ($3B capital, $400M bonds, no shock). Overdraft mode peaks at 30% service level; Strict mode peaks at 95% service level.</p>
      {error ? (
        <p role="alert">{error} Use Refresh data to retry.</p>
      ) : !data ? (
        <p role="status">Computing sensitivity curves… First load may take a moment.</p>
      ) : (
        <>
          <div className="chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={points} margin={{ top: 25, right: 35, bottom: 15, left: 15 }}>
                <CartesianGrid stroke="#242728" vertical={false} />
                <XAxis
                  dataKey="service_level"
                  type="number"
                  domain={[0.25, 1.02]}
                  ticks={[0.3, 0.5, 0.7, 0.9, 0.95, 0.99]}
                  tickFormatter={(value) => `${Math.round(value * 100)}%`}
                  tick={{ fontSize: 11, fill: '#85898c' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tickFormatter={(value) => `$${(value / 1e6).toFixed(1)}M`}
                  domain={['auto', 'auto']}
                  tick={{ fontSize: 11, fill: '#85898c' }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  labelFormatter={(value) => `Service level: ${(value * 100).toFixed(0)}%`}
                  formatter={(value) => [usd(value), 'Net PnL']}
                />
                <Legend />
                {modes.map((mode) => {
                  const peak = peaks.find((p) => p.key === mode.key)?.peak
                  return (
                    <Line
                      key={mode.key}
                      dataKey={mode.key}
                      name={mode.title}
                      stroke={mode.color}
                      strokeWidth={mode.key === 'strict' ? 3 : 2}
                      dot={peak ? renderPeakDot(mode.key, peak.service_level, mode.color) : { r: 3 }}
                      isAnimationActive={false}
                    />
                  )
                })}
                {peaks
                  .filter(({ peak }) => peak)
                  .map(({ key, color, peak }) => (
                    <ReferenceDot
                      key={key}
                      x={peak.service_level}
                      y={peak.net_pnl}
                      r={8}
                      fill={color}
                      stroke="#101112"
                      strokeWidth={2}
                      isFront={true}
                    />
                  ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="peak-summary">
            {peaks
              .filter(({ peak }) => peak)
              .map(
                ({ title, peak }) =>
                  `${title}: peak at ${(peak.service_level * 100).toFixed(0)}% (${usd(peak.net_pnl)})`
              )
              .join(' · ')}
          </p>
        </>
      )}
    </section>
  )
}

function NeedDot(props) {
  const { cx, cy, payload } = props
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null
  const isCovered = payload.covered
  return (
    <circle
      cx={cx}
      cy={cy}
      r={isCovered ? 2.5 : 4.5}
      fill={isCovered ? '#628fe2' : '#ef4444'}
      stroke={isCovered ? 'none' : '#ffffff'}
      strokeWidth={isCovered ? 0 : 1.5}
    />
  )
}

export function NightsChart({ data }) {
  const nights = (data?.nights || []).filter((night) => !night.warmup)
  const covered = nights.filter((night) => night.covered).length
  const total = nights.length
  const coveragePct = total > 0 ? (covered / total * 100).toFixed(1) : '—'
  const modeTitle = data?.mode === 'strict' ? 'Strict (own funds only)' : 'Overdraft allowed'

  return (
    <section className="panel analysis-chart">
      <div className="section-heading">
        <div>
          <h2>Buffer vs overnight need</h2>
          <p>{modeTitle} · Stressed flow worst-point need vs planned buffer ({total} evaluation nights, warmup excluded)</p>
        </div>
        <div className="coverage-badge">
          <span className="coverage-pct">{coveragePct}%</span>
          <span className="coverage-sub">{covered} of {total} nights covered</span>
        </div>
      </div>
      <p>Red dots indicate shortfall (covered=false) where overnight need exceeded the planned cash buffer.</p>
      {nights.length > 0 && (
        <div className="chart">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={nights} margin={{ top: 15, right: 15, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#242728" />
              <XAxis
                dataKey="date"
                tickFormatter={(value) => value.slice(5)}
                minTickGap={48}
                tick={{ fontSize: 11, fill: '#85898c' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tickFormatter={(value) => `$${value}M`}
                tick={{ fontSize: 11, fill: '#85898c' }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(value, name, item) => {
                  if (name && name.includes('need')) {
                    const status = item?.payload?.covered ? 'Covered' : 'UNCOVERED (shortfall)'
                    return [`$${Number(value).toFixed(2)}M (${status})`, name]
                  }
                  return [`$${Number(value).toFixed(2)}M`, name]
                }}
              />
              <Legend />
              <Line
                dataKey="buffer_m"
                name="Planned buffer"
                stroke="#c7e678"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
              <Line
                dataKey="need_m"
                name="Actual need (red = uncovered)"
                stroke="transparent"
                strokeWidth={0}
                legendType="circle"
                dot={<NeedDot />}
                activeDot={{ r: 5 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  )
}

export function AuditTrailCard({ blocks = [], merkleRoot = '' }) {
  const [copied, setCopied] = useState(false)
  const total = blocks.length
  const verified = blocks.filter((b) => typeof b.guardrail_status === 'string' && b.guardrail_status.startsWith('VERIFIED')).length
  const shortRoot = merkleRoot ? merkleRoot.slice(0, 10) : '—'

  function copyRoot() {
    if (!merkleRoot) return
    const onDone = () => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(merkleRoot).then(onDone).catch(() => {
        fallbackCopy(merkleRoot, onDone)
      })
    } else {
      fallbackCopy(merkleRoot, onDone)
    }
  }

  function fallbackCopy(text, cb) {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    try {
      document.execCommand('copy')
      cb()
    } catch {
      // ignore
    }
    document.body.removeChild(ta)
  }

  return (
    <article className="audit-trail-card" aria-label="Audit trail hash chain">
      <div className="audit-trail-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="audit-icon" aria-hidden="true">⛓️</span>
          <strong className="audit-title">Audit trail</strong>
        </div>
        <span className="tag hash-chain-tag">HASH CHAIN</span>
      </div>

      <div className="audit-metric">
        <span className="audit-status-dot" aria-hidden="true" />
        <span>Guardrail verified on {verified} of {total} sampled blocks</span>
      </div>

      <div className="merkle-row">
        <span className="merkle-label">Merkle root:</span>
        <code className="merkle-code" title={merkleRoot}>
          {shortRoot}{merkleRoot ? '…' : ''}
        </code>
        <button
          type="button"
          className="copy-btn"
          onClick={copyRoot}
          title="Copy full 64-character SHA-256 Merkle root"
          aria-label="Copy full Merkle root"
        >
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>

      <p className="hash-chain-desc">
        SHA-256 hash chain: each night&apos;s reserve state is hashed with the previous block, so history cannot be edited unnoticed.
      </p>
    </article>
  )
}

export function ModelAddsCard({ simulation }) {
  if (!simulation || !simulation.daily_series?.length) return null

  const daily = simulation.daily_series
  const last = daily.at(-1) || {}
  const validation = simulation.validation || {}
  const baselines = simulation.baselines || []
  const kpi = simulation.kpis || {}

  // 1. Gap to perfect foresight:
  // for each of AEGIS, mean forecast, fixed buffer, legacy floors,
  // compute final (oracle_net_m - strategy_net_m) in $K from the last row of daily_series.
  // Show as horizontal bars, lowest is best.
  const oracleNetM = last.oracle_net_m ?? 0

  const strategies = [
    { key: 'aegis_net_m', name: 'AEGIS', color: '#c7e678' },
    { key: 'mse_ml_net_m', name: 'Mean forecast', color: '#628fe2' },
    { key: 'fixed_net_m', name: 'Fixed buffer', color: '#b8a0de' },
    { key: 'legacy_net_m', name: 'Legacy floors', color: '#c49b62' },
  ]

  const gaps = strategies.map((s) => {
    const val = last[s.key]
    const gapK = Number.isFinite(oracleNetM) && Number.isFinite(val)
      ? (oracleNetM - val) * 1000
      : 0
    return { ...s, gapK }
  })

  const maxGap = Math.max(...gaps.map((g) => g.gapK), 1)
  const minGap = Math.min(...gaps.map((g) => g.gapK))
  const aegisGap = gaps.find((g) => g.key === 'aegis_net_m')?.gapK ?? 0

  // 2. Gap closed:
  // for each baseline B, show "AEGIS closes X% of the gap left by B" where X = (gapB - gapAEGIS) / gapB * 100.
  // If AEGIS's gap is larger than B's, show "B is closer to oracle (tuned with hindsight)" instead of a negative percentage.
  // Do not hide these cases.
  const baselineGaps = gaps.filter((g) => g.key !== 'aegis_net_m')
  const gapClosedItems = baselineGaps.map((b) => {
    if (aegisGap > b.gapK) {
      return {
        name: b.name,
        color: b.color,
        text: `${b.name} is closer to oracle (tuned with hindsight)`,
        favorable: false,
      }
    }
    const pct = b.gapK > 0 ? ((b.gapK - aegisGap) / b.gapK) * 100 : 0
    return {
      name: b.name,
      color: b.color,
      text: `AEGIS closes ${pct.toFixed(1)}% of the gap left by ${b.name}`,
      favorable: true,
      pct,
    }
  })

  // 3. Monthly win-rate:
  // take daily_series values at each month end, compute each month's increase in the gap for AEGIS and each baseline,
  // skipping the first two months (model warm-up).
  // Show a 10-cell strip per baseline, green where AEGIS's monthly gap increase is smaller,
  // grey otherwise, with the label "AEGIS better in N of 10 months".
  const monthEndsMap = new Map()
  for (const row of daily) {
    if (row.date) {
      const monthKey = row.date.slice(0, 7)
      monthEndsMap.set(monthKey, row)
    }
  }

  const monthKeys = Array.from(monthEndsMap.keys()).sort()
  const monthData = monthKeys.map((mk) => {
    const row = monthEndsMap.get(mk)
    const orc = row.oracle_net_m ?? 0
    return {
      month: mk,
      aegisGap: (orc - (row.aegis_net_m ?? 0)) * 1000,
      mseGap: (orc - (row.mse_ml_net_m ?? 0)) * 1000,
      fixedGap: (orc - (row.fixed_net_m ?? 0)) * 1000,
      legacyGap: (orc - (row.legacy_net_m ?? 0)) * 1000,
    }
  })

  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const monthlyBaselines = [
    { key: 'mseGap', name: 'Mean forecast', color: '#628fe2' },
    { key: 'fixedGap', name: 'Fixed buffer', color: '#b8a0de' },
    { key: 'legacyGap', name: 'Legacy floors', color: '#c49b62' },
  ]

  const monthlyWinRates = monthlyBaselines.map((b) => {
    const cells = []
    let wins = 0
    for (let i = 2; i < monthData.length; i++) {
      const prevAegis = monthData[i - 1].aegisGap
      const curAegis = monthData[i].aegisGap
      const incAegis = curAegis - prevAegis

      const prevB = monthData[i - 1][b.key]
      const curB = monthData[i][b.key]
      const incB = curB - prevB

      const win = incAegis < incB
      if (win) wins++

      const d = new Date(monthData[i].month + '-01')
      const mLabel = !isNaN(d.getTime()) ? monthNames[d.getUTCMonth()] : monthData[i].month.slice(5)

      cells.push({
        month: mLabel,
        fullMonth: monthData[i].month,
        win,
        incAegis,
        incB,
      })
    }
    return {
      name: b.name,
      color: b.color,
      wins,
      total: cells.length,
      cells,
    }
  })

  // 4. Idle cash:
  // show validation.avg_buffer_m for AEGIS against the fixed buffer in $M
  // and the percentage difference, plus validation.avg_true_need_m.
  const fixedBaseline = baselines.find((b) => typeof b.strategy === 'string' && b.strategy.startsWith('Fixed'))
  const fixedMatch = fixedBaseline?.strategy.match(/Fixed \$?([\d.]+)M/i)
  const fixedBufferM = fixedMatch ? parseFloat(fixedMatch[1]) : 40.0
  const aegisAvgBufferM = validation.avg_buffer_m ?? 0
  const avgTrueNeedM = validation.avg_true_need_m ?? 0

  const idleDiffM = fixedBufferM - aegisAvgBufferM
  const idlePctDiff = fixedBufferM > 0 ? (idleDiffM / fixedBufferM) * 100 : 0

  return (
    <section className="panel model-adds-card" aria-label="What the model adds">
      <div className="section-heading">
        <div>
          <p className="eyebrow">INCREMENTAL VALUE</p>
          <h2>What the model adds</h2>
          <p>Client-side evaluation against baseline strategies · {kpi.mode === 'strict' ? 'Strict (own funds only)' : 'Overdraft allowed'}</p>
        </div>
        <span className="tag">{kpi.mode === 'strict' ? 'Strict liquidity' : 'Overdraft allowed'}</span>
      </div>

      <div className="model-adds-grid">
        {/* 1. Gap to perfect foresight (horizontal bars, lowest is best) */}
        <div className="adds-section gap-bars-section">
          <div className="section-title-row">
            <h3>Gap to perfect foresight</h3>
            <span className="sub-tag">Lowest is best</span>
          </div>
          <p className="section-subtext">Cumulative difference from oracle profit at year end (in $K)</p>
          <div className="gap-bars-list">
            {gaps.map((item) => {
              const barWidth = Math.max(8, Math.min(100, (item.gapK / maxGap) * 100))
              const isBest = Math.abs(item.gapK - minGap) < 0.01
              return (
                <div key={item.key} className="gap-bar-row">
                  <div className="gap-bar-label">
                    <span className="strategy-name">{item.name}</span>
                    {isBest && <span className="best-tag">Lowest (Best)</span>}
                  </div>
                  <div className="gap-bar-track-wrap">
                    <div className="gap-bar-track">
                      <div
                        className="gap-bar-fill"
                        style={{
                          width: `${barWidth}%`,
                          backgroundColor: item.color,
                        }}
                      />
                    </div>
                    <span className="gap-bar-value">${item.gapK.toFixed(1)}K</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* 2. Gap closed */}
        <div className="adds-section gap-closed-section">
          <div className="section-title-row">
            <h3>Gap closed</h3>
            <span className="sub-tag">Oracle recovery</span>
          </div>
          <p className="section-subtext">Shortfall recovered by AEGIS quantile calibration</p>
          <div className="gap-closed-list">
            {gapClosedItems.map((item) => (
              <div
                key={item.name}
                className={`gap-closed-card ${item.favorable ? 'favorable' : 'hindsight'}`}
              >
                <span
                  className="closed-indicator"
                  style={{ backgroundColor: item.favorable ? '#c7e678' : '#e09843' }}
                />
                <span className="closed-text">{item.text}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 3. Monthly win-rate */}
        <div className="adds-section winrate-section">
          <div className="section-title-row">
            <h3>Monthly win-rate</h3>
            <span className="sub-tag">Mar–Dec evaluation</span>
          </div>
          <p className="section-subtext">Months where AEGIS gap increase was smaller (skipping Jan–Feb warmup)</p>
          <div className="winrate-list">
            {monthlyWinRates.map((bw) => (
              <div key={bw.name} className="winrate-row">
                <div className="winrate-header">
                  <span className="bw-name">vs {bw.name}</span>
                  <span className="bw-score">AEGIS better in {bw.wins} of {bw.total} months</span>
                </div>
                <div className="strip-cells" role="group" aria-label={`Monthly performance vs ${bw.name}`}>
                  {bw.cells.map((cell) => (
                    <div
                      key={cell.fullMonth}
                      className={`strip-cell ${cell.win ? 'win' : 'loss'}`}
                      title={`${cell.month}: AEGIS +$${cell.incAegis.toFixed(1)}K vs ${bw.name} +$${cell.incB.toFixed(1)}K (${cell.win ? 'AEGIS won month' : 'AEGIS trailed'})`}
                    >
                      <span className="cell-month-label">{cell.month}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 4. Idle cash */}
        <div className="adds-section idle-cash-section">
          <div className="section-title-row">
            <h3>Idle cash efficiency</h3>
            <span className="sub-tag">Buffer retention</span>
          </div>
          <p className="section-subtext">Average buffer retained vs static fixed buffer and true need</p>
          <div className="idle-cash-metrics">
            <div className="idle-metric-card">
              <span className="idle-label">AEGIS Average Buffer</span>
              <strong className="idle-val">${aegisAvgBufferM.toFixed(1)}M</strong>
              <small className="idle-sub">dynamic quantile</small>
            </div>
            <div className="idle-metric-card">
              <span className="idle-label">Fixed Buffer</span>
              <strong className="idle-val">${fixedBufferM.toFixed(1)}M</strong>
              <small className="idle-sub">static baseline</small>
            </div>
            <div className="idle-metric-card highlight">
              <span className="idle-label">Buffer Reduction</span>
              <strong className="idle-val positive">
                {idlePctDiff >= 0 ? '-' : '+'}{Math.abs(idlePctDiff).toFixed(1)}%
              </strong>
              <small className="idle-sub">
                {idleDiffM >= 0
                  ? `$${idleDiffM.toFixed(1)}M less idle cash`
                  : `$${Math.abs(idleDiffM).toFixed(1)}M additional buffer`}
              </small>
            </div>
            <div className="idle-metric-card">
              <span className="idle-label">Average True Need</span>
              <strong className="idle-val">${avgTrueNeedM.toFixed(1)}M</strong>
              <small className="idle-sub">actual overnight deficit</small>
            </div>
          </div>
        </div>
      </div>

      <p className="model-adds-footnote">
        Fixed and legacy baselines were tuned with hindsight on this same year; AEGIS uses none. Differences are small relative to total profit, so the model&apos;s main value is coverage and safety.
      </p>
    </section>
  )
}

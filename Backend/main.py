"""
AEGIS // Reserve Juggler  --  backend v3.0 (audited rewrite)

What changed vs v2 (see CHANGELOG at bottom of file):
  * ML target is the overnight WORST POINT (trough of cumulative net flow, 17:00->08:00),
    not the 15h endpoint.
  * Walk-forward only: model retrained weekly on completed nights; features use rows < 17:00.
  * No calendar hard-codes in the AEGIS buffer (legacy calendar floors kept only as a baseline).
  * Every strategy gets the SAME recourse ladder and the SAME total capital.
  * No free negative cash: any shortfall is charged (overdraft / repo break / bond / equity).
  * Sharpe, drawdown, % of capital, coverage + Kupiec test, oracle and leak test are COMPUTED.
  * Honest naming: hash chain + a real Merkle root; guardrail status is actually checked.
"""
import os, hashlib, math
import numpy as np
import pandas as pd
from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sklearn.ensemble import GradientBoostingRegressor
from scipy.stats import chi2

app = FastAPI(title="AEGIS // Algorithmic Treasury & Reserve Juggler API", version="3.0.0",
              description="Walk-forward quantile liquidity engine + 4-tier waterfall + proof-of-reserves hash chain")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ----------------------------------------------------------------------------- data
def _find_csv():
    candidates = [
        os.environ.get("AEGIS_CSV", ""),
        "treasury_4tier_dataset.csv",
        "../treasury_4tier_dataset.csv",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "treasury_4tier_dataset.csv"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "treasury_4tier_dataset.csv"),
        "data/treasury_4tier_dataset.csv",
        "../data/treasury_4tier_dataset.csv"
    ]
    for p in candidates:
        if p and os.path.exists(p):
            return p
    raise FileNotFoundError("treasury_4tier_dataset.csv not found (set AEGIS_CSV or place it next to backend/)")

df = pd.read_csv(_find_csv())
df["timestamp_dt"] = pd.to_datetime(df["timestamp"])
df["hour"] = df["timestamp_dt"].dt.hour
df["dom"] = df["timestamp_dt"].dt.day
df["dow"] = df["timestamp_dt"].dt.dayofweek
df["date_str"] = df["timestamp"].astype(str).str.slice(0, 10)
if "net_flow_usd" not in df:
    df["net_flow_usd"] = df["deposits_usd"] - df["withdrawals_usd"]

N = len(df)
DEP = df["deposits_usd"].to_numpy(float)
WD = df["withdrawals_usd"].to_numpy(float)
NET = DEP - WD
HOUR = df["hour"].to_numpy(int)
DOW = df["dow"].to_numpy(int)
DOM = df["dom"].to_numpy(int)
WINDOW = df["repo_sweep_window_open"].astype(bool).to_numpy()
MATURE = df["repo_sweep_mature"].astype(bool).to_numpy()
REPO_APY = df["tier1_repo_rate_apy"].to_numpy(float)
REPO_HR = REPO_APY / 100.0 / 8760.0
BOND_Y_HR = df["tier2_bond_yield_pct"].to_numpy(float) / 100.0 / 8760.0
OD_HR = df["emergency_overdraft_penalty_apr_pct"].to_numpy(float) / 100.0 / 8760.0
FEE_REPO = df["tier1_early_redemption_haircut_pct"].to_numpy(float) / 100.0
FEE_BOND = df["tier2_bond_liquidation_haircut_pct"].to_numpy(float) / 100.0
FEE_EQ = df["tier3_stock_liquidation_haircut_pct"].to_numpy(float) / 100.0
_bp = df["tier2_bond_price_index"].to_numpy(float)
_sp = df["tier3_stock_index_price"].to_numpy(float)
BOND_RET = np.r_[0.0, np.diff(_bp) / _bp[:-1]]
STOCK_RET = np.r_[0.0, np.diff(_sp) / _sp[:-1]]
BOND_DUR = df["tier2_bond_mod_duration"].to_numpy(float) if "tier2_bond_mod_duration" in df else np.full(N, 1.92)

SW = np.where(WINDOW)[0]            # row index of every 17:00 sweep
K = len(SW)                         # number of nights
LOCK_H = 15                         # 17:00 -> 08:00
IDX18 = np.where(HOUR == 18)[0]

# ----------------------------------------------------------------------------- policy constants
WARM = 45                # nights before the model is trusted
MINTRAIN = 14            # nights of history needed for lag features
RETRAIN_EVERY = 7        # weekly walk-forward retrain
FALLBACK_BUF = 40e6      # conservative buffer during warm-up (disclosed)
MIN_BUF = 5e6            # operational floor
OD_MAX_STREAK_H = 24     # overdraft allowed for at most 24 consecutive hours, then liquidate assets
DEFAULT_CAPITAL = 3000e6
DEFAULT_BOND_CORE = 400e6

ASSUMPTIONS = [
    "Starting capital is a parameter (default $3.0B = $2.6B cash + $0.4B bonds). It was set so the year ends near zero spare cash; "
    "the CSV has a net outflow of about $2.5B over 2026.",
    "Repo: sweep at 17:00 (before that hour's flow lands), matures 08:00; earns the CSV rate for 15 hours (rows 17..07).",
    "Repo break fee, bond and equity haircuts, and overdraft APR are read from the CSV columns, not hard-coded.",
    "Repo break fee is charged on the amount broken (grossed up so the shortfall is covered net of fee).",
    "Overdraft interest accrues hourly on the running deficit; allowed for at most 24 consecutive hours, then assets are liquidated.",
    "Every strategy uses the same recourse ladder and the same total starting capital.",
    "Bond core is a strategic parameter. Its best size depends on the annual cash drain, which is only known in hindsight.",
    "Equity allocation is 0 for AEGIS: a 15% exit cost needs >1.5 years of the 10% expected return to recover, and the 2026 index fell.",
    "Model is retrained weekly on completed nights only; features use rows strictly before the 17:00 flow; first 45 nights use a $40M fallback buffer.",
    "Withdrawal shock = one-off multiplier on withdrawals for a window (default 48h from 2026-05-02). The model is not told; only the surge detector, which sees observed flows, reacts.",
]

# ----------------------------------------------------------------------------- night table
def night_deficits(net):
    """Per night: deficit path (cash needed) over the locked window rows i..i+14."""
    return [np.maximum(0.0, -np.cumsum(net[i:i + LOCK_H])) for i in SW]

DEFS = night_deficits(NET)
NEED = np.array([d.max() for d in DEFS])

FEATS = ["dow", "dom", "day_flow_so_far", "prev_day_flow", "prev2_day_flow", "last3h_flow",
         "lag1_need", "lag7_need", "roll14_need", "max7_need"]

def build_features(net, need):
    F = np.zeros((K, len(FEATS)))
    for k, i in enumerate(SW):
        # all flows used are from rows < i (strictly before the 17:00 hour)
        dso = net[max(0, i - 17):i].sum()
        p1 = net[max(0, i - 41):max(0, i - 17)].sum()
        p2 = net[max(0, i - 65):max(0, i - 41)].sum()
        l3 = net[max(0, i - 3):i].sum()
        lag1 = need[k - 1] if k >= 1 else 0.0
        lag7 = need[k - 7] if k >= 7 else 0.0
        r14 = need[max(0, k - 14):k].mean() if k >= 1 else 0.0
        m7 = need[max(0, k - 7):k].max() if k >= 1 else 0.0
        F[k] = [DOW[i], DOM[i], dso, p1, p2, l3, lag1, lag7, r14, m7]
    return F

FEAT_MAT = build_features(NET, NEED)

def walk_forward(F, need, loss="quantile", alpha=0.5, upto=None):
    end = K if upto is None else upto + 1
    preds = np.full(K, np.nan)
    m = None
    for k in range(WARM, end):
        if m is None or (k - WARM) % RETRAIN_EVERY == 0:
            m = GradientBoostingRegressor(loss=loss, alpha=alpha, n_estimators=60, max_depth=3,
                                          learning_rate=0.08, subsample=0.8, min_samples_leaf=5, random_state=0)
            m.fit(F[MINTRAIN:k], need[MINTRAIN:k])
        preds[k] = m.predict(F[k:k + 1])[0]
    return preds, m

def conformalise(raw, need, q):
    out = raw.copy()
    for k in range(WARM, K):
        past = need[WARM:k] - raw[WARM:k]
        off = float(np.quantile(past, q)) if len(past) >= 15 else 0.0
        out[k] = raw[k] + off
    return out

_CACHE = {}
_LAST_MODEL = {}

def model_buffers(q, conformal):
    key = (round(q, 4), bool(conformal))
    if key not in _CACHE:
        rk = ("raw", round(q, 4))
        if rk not in _CACHE:
            raw, m = walk_forward(FEAT_MAT, NEED, "quantile", q)
            _CACHE[rk] = raw
            _LAST_MODEL[round(q, 4)] = m
        raw = _CACHE[rk]
        b = conformalise(raw, NEED, q) if conformal else raw.copy()
        b = np.maximum(b, MIN_BUF)
        b[:WARM] = FALLBACK_BUF
        _CACHE[key] = b
    return _CACHE[key]

def mse_buffers():
    if "mse" not in _CACHE:
        p, m = walk_forward(FEAT_MAT, NEED, "squared_error")
        b = np.maximum(MIN_BUF, p * 1.10)
        b[:WARM] = FALLBACK_BUF
        _CACHE["mse"] = b
    return _CACHE["mse"]

def to_rows(bk):
    arr = np.full(N, np.nan)
    arr[SW] = bk
    return arr

def surge_multiplier(wd_obs, z_thresh=3.5):
    mult = np.ones(K)
    for k, i in enumerate(SW):
        if i < 24 * 29:
            continue
        cur = wd_obs[i - 6:i].sum()
        hist = np.array([wd_obs[i - 6 - 24 * j:i - 24 * j].sum() for j in range(1, 29)])
        z = (cur - hist.mean()) / (hist.std() + 1e-9)
        if z > z_thresh:
            mult[k] = min(2.5, 1 + 0.25 * (z - z_thresh))
    return mult

def legacy_floor_buffers(normal, elevated, storm):
    out = np.zeros(K)
    for k, i in enumerate(SW):
        payday = DOM[i] in (1, 2, 3, 15, 16, 17)
        weekend = DOW[i] in (4, 5)
        out[k] = storm if (payday and weekend) else elevated if (payday or weekend) else normal
    return out

def oracle_buffers(defs, allow_od):
    out = np.zeros(K)
    for k, i in enumerate(SW):
        d = defs[k]
        if not allow_od:
            out[k] = d.max() * 1.0001
        else:
            # cost(B) = B*carry + odrate*sum(max(0,d-B)); optimum = the h-th largest deficit, h = carry/odrate
            h = int((REPO_HR[i] * LOCK_H) / OD_HR[i])
            s = np.sort(d)[::-1]
            out[k] = s[h - 1] if 1 <= h <= len(s) else 0.0
    return out

# ----------------------------------------------------------------------------- simulation engine
def shock_vec(mult, date_str="2026-05-02", hours=48):
    """One-off withdrawal shock: multiplier applied to withdrawals for `hours` starting at `date_str` 00:00."""
    v = np.ones(N)
    if mult != 1.0:
        hit = np.where(df["date_str"].to_numpy() == date_str)[0]
        if len(hit) == 0:
            raise HTTPException(status_code=422, detail=f"shock_date '{date_str}' not found in dataset")
        start = int(hit[0])
        clamped_hours = min(max(1, int(hours)), N - start)
        v[start:start + clamped_hours] = mult
    return v

def run_strategy(buf_rows, init, allow_od, shock=1.0):
    SHK = np.full(N, float(shock)) if np.isscalar(shock) else shock
    t0, t1, t2, t3 = init
    streak = 0
    y_repo = y_bond = y_eq = pen_tot = 0.0
    breaks = od_hours = 0
    bond_sale = eq_sale = 0.0
    max_od = 0.0
    min_cash = 1e18
    pnl_row = np.zeros(N)
    A0 = np.zeros(N); A1 = np.zeros(N); A2 = np.zeros(N)
    events = []
    for i in range(N):
        # 08:00 maturity then 17:00 sweep happen before the hour's flow lands
        if MATURE[i]:
            t0 += t1
            t1 = 0.0
        if WINDOW[i]:
            b = buf_rows[i]
            if not math.isnan(b):
                swept = max(0.0, t0 - b)
                events.append((i, b, t0, swept, t1 + swept, t2))
                if swept > 0:
                    t1 += swept
                    t0 -= swept
        t0 += DEP[i] - WD[i] * SHK[i]
        ry = t1 * REPO_HR[i]; t1 += ry
        by = t2 * (BOND_Y_HR[i] + BOND_RET[i]); t2 += by
        ey = t3 * STOCK_RET[i]; t3 += ey
        y_repo += ry; y_bond += by; y_eq += ey
        pen = 0.0
        if t0 < 0:
            short = -t0
            max_od = max(max_od, short)
            if allow_od and streak < OD_MAX_STREAK_H:
                c = short * OD_HR[i]
                t0 -= c; pen += c; od_hours += 1; streak += 1
                if len(events) < 10**9:
                    events.append((i, -1, short, c, 0, 0))
            else:
                streak = 0
                fr, fb, fe = FEE_REPO[i], FEE_BOND[i], FEE_EQ[i]
                if t1 > 0 and t0 < 0:
                    b = min(t1, -t0 / (1 - fr)); fee = b * fr
                    t1 -= b; t0 += b - fee; pen += fee; breaks += 1
                    events.append((i, -2, b, fee, 0, 0))
                if t0 < 0 and t2 > 0:
                    b = min(t2, -t0 / (1 - fb)); fee = b * fb
                    t2 -= b; t0 += b - fee; pen += fee; bond_sale += b
                if t0 < 0 and t3 > 0:
                    b = min(t3, -t0 / (1 - fe)); fee = b * fe
                    t3 -= b; t0 += b - fee; pen += fee; eq_sale += b
                if t0 < 0:                      # last resort: never free
                    c = -t0 * OD_HR[i]
                    t0 -= c; pen += c; od_hours += 1
        else:
            streak = 0
        min_cash = min(min_cash, t0)
        pen_tot += pen
        pnl_row[i] = ry + by + ey - pen
        A0[i], A1[i], A2[i] = t0, t1, t2
    return dict(yield_=y_repo + y_bond + y_eq, y_repo=y_repo, y_bond=y_bond, y_eq=y_eq, pen=pen_tot,
                pnl=y_repo + y_bond + y_eq - pen_tot, breaks=breaks, od_hours=od_hours, max_od=max_od,
                bond_sale=bond_sale, eq_sale=eq_sale, min_cash=min_cash, pnl_row=pnl_row,
                t0=A0, t1=A1, t2=A2, events=events)

def stats(res, capital):
    daily = res["pnl_row"].reshape(-1, 24).sum(1) if N % 24 == 0 else res["pnl_row"]
    cum = np.cumsum(daily)
    peak = np.maximum.accumulate(np.r_[0.0, cum])[1:]
    dd = float((cum - peak).min() / capital * 100) if capital > 0 else 0.0
    sd = daily.std()
    sharpe = float(daily.mean() / sd * math.sqrt(365)) if (sd > 0 and not math.isnan(sd)) else 0.0
    pnl_pct = float(res["pnl"] / capital * 100) if capital > 0 else 0.0
    return dict(net_pnl=round(res["pnl"], 2), yield_=round(res["yield_"], 2), penalties=round(res["pen"], 2),
                repo_breaks=int(res["breaks"]), overdraft_hours=int(res["od_hours"]),
                max_overdraft=round(res["max_od"], 2), forced_bond_sales=round(res["bond_sale"], 2),
                pnl_pct_capital=round(pnl_pct, 3), sharpe=round(sharpe, 2) if not math.isnan(sharpe) else 0.0,
                max_drawdown_pct=round(dd, 4) if not math.isnan(dd) else 0.0, repo_yield=round(res["y_repo"], 2),
                bond_yield=round(res["y_bond"], 2), equity_pnl=round(res["y_eq"], 2))

def coverage(bk, need):
    m = np.arange(K) >= WARM
    ok = (bk[m] >= need[m] - 1e-6)
    n = int(m.sum()); x = int((~ok).sum())
    return n, x, float(ok.mean())

def kupiec(n, x, target):
    p0 = 1 - target
    if x == 0:
        lr = -2 * n * math.log(1 - p0)
    else:
        ph = x / n
        if ph >= 1:
            return 0.0
        lr = -2 * ((n - x) * math.log(1 - p0) + x * math.log(p0)
                   - (n - x) * math.log(1 - ph) - x * math.log(ph))
    return float(chi2.sf(lr, 1))

# ----------------------------------------------------------------------------- scenario builder
def default_level(allow_od):
    return 0.50 if allow_od else 0.95

def build_scenario(allow_od, service_level, shk, surge, fixed_m, floors, capital, bond_core):
    q = service_level if service_level else default_level(allow_od)
    conformal = not allow_od
    aeg_k = model_buffers(q, conformal).copy()
    if surge:
        aeg_k = aeg_k * surge_multiplier(WD * shk)
    aeg = to_rows(aeg_k)
    mse = to_rows(mse_buffers())
    fixed = to_rows(np.full(K, fixed_m))
    legacy = to_rows(legacy_floor_buffers(*floors))
    net_s = DEP - WD * shk
    orc = to_rows(oracle_buffers(night_deficits(net_s), allow_od))
    naive = to_rows(np.full(K, 5e6))
    core = (capital - bond_core, 0.0, bond_core, 0.0)
    allcash = (capital, 0.0, 0.0, 0.0)
    f = capital / 2600e6
    naive_init = (300e6 * f, 0.0, 1600e6 * f, 700e6 * f)
    runs = {
        "aegis": run_strategy(aeg, core, allow_od, shk),
        "mse": run_strategy(mse, core, allow_od, shk),
        "fixed": run_strategy(fixed, core, allow_od, shk),
        "legacy": run_strategy(legacy, core, allow_od, shk),
        "repo_only": run_strategy(aeg, allcash, allow_od, shk),
        "oracle": run_strategy(orc, core, allow_od, shk),
        "naive": run_strategy(naive, naive_init, allow_od, shk),
    }
    return q, aeg_k, runs

# ----------------------------------------------------------------------------- hashing
def merkle_root(leaves):
    lvl = [bytes.fromhex(h) for h in leaves]
    if not lvl:
        return "0x" + "0" * 64
    while len(lvl) > 1:
        if len(lvl) % 2:
            lvl.append(lvl[-1])
        lvl = [hashlib.sha256(lvl[j] + lvl[j + 1]).digest() for j in range(0, len(lvl), 2)]
    return "0x" + lvl[0].hex()

def regime_label(b):
    return "NORMAL" if b < 20e6 else "ELEVATED" if b < 40e6 else "SUPER-STORM"

# ----------------------------------------------------------------------------- endpoints
@app.get("/api/health")
def health():
    return {"status": "ONLINE", "engine": "AEGIS_QUANT_CORE_V3", "rows_loaded": N, "nights": K,
            "models_active": ["Walk_Forward_Quantile_GBDT", "Conformal_Calibration", "Overdraft_vs_Repo_Break_Ladder",
                              "Surge_Detector_zscore", "SHA256_Hash_Chain_PoR"]}

@app.get("/api/assumptions")
def assumptions():
    return {"assumptions": ASSUMPTIONS}

@app.get("/api/forensics")
def get_forensics():
    hourly = df.groupby("hour")[["deposits_usd", "withdrawals_usd", "net_flow_usd"]].mean() / 1e6
    hourly_list = [{"hour": f"{int(h):02d}:00", "deposits_m": round(r["deposits_usd"], 2),
                    "withdrawals_m": round(r["withdrawals_usd"], 2), "net_flow_m": round(r["net_flow_usd"], 2)}
                   for h, r in hourly.iterrows()]
    dom = (df.groupby("dom")["net_flow_usd"].mean() * 24 / 1e6).round(2)
    dom_list = [{"day": int(d), "net_flow_m": float(v)} for d, v in dom.items()]
    names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    dow = (df.groupby("dow")["net_flow_usd"].mean() * 24 / 1e6).round(2)
    dow_list = [{"day_name": names[int(d)], "net_flow_m": float(v)} for d, v in dow.items()]
    mdl = _LAST_MODEL.get(round(default_level(False), 4))
    feat_imp = []
    if mdl is not None:
        feat_imp = sorted([{"feature": f, "importance": round(float(v) * 100, 1)}
                           for f, v in zip(FEATS, mdl.feature_importances_)], key=lambda x: -x["importance"])[:6]
    daily = df.groupby("date_str")["net_flow_usd"].sum()
    worst = daily.nsmallest(4)
    p95, p98 = float(np.quantile(NEED, .95)), float(np.quantile(NEED, .98))
    eq_ret = float(_sp[-1] / _sp[0] - 1)
    repo_eff = float(REPO_APY.mean()) / 100 * LOCK_H / 24
    bond_apy = float(df["tier2_bond_yield_pct"].mean()) / 100
    be_months = FEE_BOND.mean() / max(bond_apy - repo_eff, 1e-9) * 12
    dom1 = float(df[df.dom == 1].groupby("date_str").net_flow_usd.sum().mean()) / 1e6
    dr = float(df[df.dom.isin([2, 3, 16, 17])].groupby("date_str").net_flow_usd.sum().mean()) / 1e6
    return {
        "traps_discovered": [
            {"id": 1, "title": "The 17:00 Repo Lockup Trap", "metric": f"-${p95/1e6:.1f}M (95% overnight worst-point need)",
             "desc": "Net flows are positive 03:00-12:00 and negative 13:00-23:00, right across the 17:00 sweep. The need is the trough of the cumulative flow, not the 08:00 total."},
            {"id": 2, "title": "Bi-Weekly Payday Tsunami", "metric": f"+${dom1:.1f}M day 1 -> ${dr:.1f}M avg on days 2-3 and 16-17",
             "desc": "Salary inflows on days 1 and 15 are withdrawn over the following two days."},
            {"id": 3, "title": "Saturday Settlement Super-Storms",
             "metric": "Worst days: " + ", ".join(f"{d} (${v/1e6:.1f}M)" for d, v in worst.items()),
             "desc": "Post-payday drains landing on a Friday/Saturday produce single-day outflows above $118M."},
            {"id": 4, "title": "Tier-3 Equity Bear Market Trap",
             "metric": f"{eq_ret*100:.1f}% index move + 15% exit cost",
             "desc": f"Index falls from {_sp[0]:,.0f} to {_sp[-1]:,.0f}. Even with the 10% expected APY, exiting costs 15%; allocation is 0."},
        ],
        "tier_economics": {
            "repo_effective_apy_pct": round(repo_eff * 100, 2), "bond_apy_pct": round(bond_apy * 100, 2),
            "bond_breakeven_months_vs_repo": round(be_months, 1),
            "equity_breakeven_years_vs_cash": round(float(FEE_EQ.mean()) / 0.10, 2),
            "need_p95_m": round(p95 / 1e6, 1), "need_p98_m": round(p98 / 1e6, 1),
            "annual_net_flow_m": round(float(NET.sum()) / 1e6, 1)},
        "hourly_cycle": hourly_list, "day_of_month_cycle": dom_list, "day_of_week_cycle": dow_list,
        "ml_feature_importances": feat_imp,
    }

@app.get("/api/simulate")
def simulate(
    normal_buffer_m: float = Query(14.0), elevated_buffer_m: float = Query(38.0),
    superstorm_buffer_m: float = Query(55.0), structural_bond_m: float = Query(400.0),
    shock_multiplier: float = Query(1.0), enable_arbitrage: bool = Query(True),
    rwa_atomic_mode: bool = Query(False),            # accepted for UI compatibility; removed (not in problem statement)
    start_capital_m: float = Query(3000.0), service_level: float = Query(0.0),
    fixed_buffer_m: float = Query(40.0), surge_detector: bool = Query(True),
    shock_date: str = Query("2026-05-02"), shock_hours: int = Query(48),
):
    if math.isnan(start_capital_m) or start_capital_m <= 0:
        raise HTTPException(status_code=422, detail="start_capital_m must be strictly positive (> 0)")
    if math.isnan(shock_multiplier) or shock_multiplier < 0:
        raise HTTPException(status_code=422, detail="shock_multiplier must be non-negative (>= 0)")
    if shock_hours <= 0:
        raise HTTPException(status_code=422, detail="shock_hours must be at least 1")
    if math.isnan(structural_bond_m) or structural_bond_m < 0:
        raise HTTPException(status_code=422, detail="structural_bond_m must be non-negative (>= 0)")
    if service_level < 0 or service_level >= 1.0:
        raise HTTPException(status_code=422, detail="service_level must be between 0 and 1 (exclusive)")

    capital = start_capital_m * 1e6
    bond_core = min(structural_bond_m * 1e6, capital)
    shk = shock_vec(shock_multiplier, shock_date, shock_hours)
    q, aeg_k, R = build_scenario(enable_arbitrage, service_level or None, shk, surge_detector,
                                 fixed_buffer_m * 1e6,
                                 (normal_buffer_m * 1e6, elevated_buffer_m * 1e6, superstorm_buffer_m * 1e6),
                                 capital, bond_core)
    S = {k: stats(v, capital) for k, v in R.items()}
    a, m_, n_ = S["aegis"], S["mse"], S["naive"]
    kpis = {
        "aegis_yield": a["yield_"], "aegis_penalties": a["penalties"], "aegis_net_pnl": a["net_pnl"],
        "aegis_repo_breaks": a["repo_breaks"], "aegis_overdraft_hours": a["overdraft_hours"],
        "aegis_sharpe": a["sharpe"], "aegis_max_drawdown_pct": a["max_drawdown_pct"],
        "aegis_pnl_pct_capital": a["pnl_pct_capital"],
        "mse_ml_net_pnl": m_["net_pnl"], "mse_ml_penalties": m_["penalties"], "mse_ml_repo_breaks": m_["repo_breaks"],
        "naive_net_pnl": n_["net_pnl"], "naive_penalties": n_["penalties"], "naive_repo_breaks": n_["repo_breaks"],
        "oracle_net_pnl": S["oracle"]["net_pnl"],
        "aegis_pct_of_oracle": round(a["net_pnl"] / S["oracle"]["net_pnl"] * 100, 2) if S["oracle"]["net_pnl"] else None,
        "gap_to_oracle": round(S["oracle"]["net_pnl"] - a["net_pnl"], 2),
        "penalties_avoided_vs_naive": round(n_["penalties"] - a["penalties"], 2),
        "start_capital": capital, "bond_core": bond_core, "mode": "overdraft_allowed" if enable_arbitrage else "strict",
        "target_service_level": q,
    }
    # validation of buffers (unshocked need so coverage is about forecast quality)
    n, x, cov = coverage(aeg_k, NEED)
    validation = {"nights_tested": n, "uncovered_nights": x, "coverage": round(cov, 4), "target": q,
                  "kupiec_pvalue": round(kupiec(n, x, q), 4) if q < 1 else None,
                  "avg_buffer_m": round(float(aeg_k[WARM:].mean()) / 1e6, 2),
                  "avg_true_need_m": round(float(NEED[WARM:].mean()) / 1e6, 2)}
    names = {"aegis": "AEGIS walk-forward quantile", "mse": "Mean-forecast model (MSE, +10%)",
             "fixed": f"Fixed ${fixed_buffer_m:.0f}M buffer", "legacy": "Legacy calendar floors (no ML)",
             "repo_only": "AEGIS buffer, no bond core", "oracle": "Oracle (perfect foresight)",
             "naive": "Naive static 4-tier"}
    baselines = [{"strategy": names[k], **S[k]} for k in names] + [{"strategy": "Idle cash (all Tier-0)", "net_pnl": 0.0}]

    # daily series (cumulative PnL at 18:00 each day)
    cum = {k: np.cumsum(v["pnl_row"]) for k, v in R.items()}
    daily = []
    for j, i in enumerate(IDX18):
        daily.append({"date": str(df["date_str"].iloc[i]),
                      "aegis_net_m": round(cum["aegis"][i] / 1e6, 3), "mse_ml_net_m": round(cum["mse"][i] / 1e6, 3),
                      "naive_net_m": round(cum["naive"][i] / 1e6, 3), "fixed_net_m": round(cum["fixed"][i] / 1e6, 3),
                      "legacy_net_m": round(cum["legacy"][i] / 1e6, 3), "oracle_net_m": round(cum["oracle"][i] / 1e6, 3),
                      "idle_net_m": 0.0, "tier0_m": round(R["aegis"]["t0"][i] / 1e6, 2),
                      "tier1_m": round(R["aegis"]["t1"][i] / 1e6, 2), "tier2_m": round(R["aegis"]["t2"][i] / 1e6, 2)})

    # decision log + proof-of-reserves chain from the real AEGIS run
    ev = R["aegis"]["events"]
    sweeps = [e for e in ev if e[1] >= 0]
    others = [e for e in ev if e[1] < 0]
    chosen = set(np.argsort([-e[1] for e in sweeps])[:12].tolist()) | set(np.linspace(0, len(sweeps) - 1, 12).astype(int).tolist())
    logs = []
    for j in sorted(chosen):
        i, b, t0b, swept, t1a, _ = sweeps[j]
        logs.append({"timestamp": str(df["timestamp"].iloc[i]), "type": "17:00_REPO_SWEEP", "regime": regime_label(b),
                     "action": f"Set Tier-0 buffer to ${b/1e6:.1f}M (q={q:.2f}); swept ${swept/1e6:.1f}M into Repo @ {REPO_APY[i]:.2f}% APY."})
    seen = set(); cnt = 0
    for e in others:
        night = int(e[0] // 24)
        if night in seen:
            continue
        seen.add(night); cnt += 1
        if cnt > 12:
            break
        i, code, amt, cost = e[0], e[1], e[2], e[3]
        if code == -1:
            logs.append({"timestamp": str(df["timestamp"].iloc[i]), "type": "OVERDRAFT_BRIDGE", "regime": "OVERNIGHT_SHORTFALL",
                         "action": f"Bridged ${amt/1e6:.2f}M via overdraft (${cost:,.0f}/hr) instead of breaking Repo (${amt*FEE_REPO[i]:,.0f} fee avoided)."})
        else:
            logs.append({"timestamp": str(df["timestamp"].iloc[i]), "type": "REPO_BREAK", "regime": "OVERNIGHT_SHORTFALL",
                         "action": f"Broke ${amt/1e6:.2f}M of Repo, fee ${cost:,.0f}."})
    logs.sort(key=lambda r: r["timestamp"])
    logs = logs[:50]

    prev = "0x" + "0" * 64
    blocks = []; leaves = []
    for j, (i, b, t0b, swept, t1a, t2v) in enumerate(sweeps):
        t0_after = min(t0b, b)
        ok = t0_after >= b - 1.0
        payload = f"{df['timestamp'].iloc[i]}|{t0_after:.0f}|{t1a:.0f}|{t2v:.0f}|{b:.0f}|{prev}"
        h = hashlib.sha256(payload.encode()).hexdigest()
        leaves.append(h)
        blocks.append({"block_id": j + 1, "timestamp": str(df["timestamp"].iloc[i]), "regime": regime_label(b),
                       "tier0_retained_m": round(t0_after / 1e6, 2), "required_buffer_m": round(b / 1e6, 2),
                       "ml_tail_var_m": round(b / 1e6, 2), "swept_repo_m": round(swept / 1e6, 2),
                       "guardrail_status": "VERIFIED (Tier0 >= required buffer)" if ok else "UNDERFUNDED (Tier0 < required buffer)",
                       "prev_hash": prev, "merkle_root": "0x" + h, "hash": "0x" + h})
        prev = "0x" + h
    pick = np.linspace(0, len(blocks) - 1, min(35, len(blocks))).astype(int)

    return {"kpis": kpis, "baselines": baselines, "validation": validation, "daily_series": daily,
            "decision_logs": logs, "por_blocks": [blocks[j] for j in pick],
            "por_merkle_root_all_nights": merkle_root(leaves), "por_chain_head": prev,
            "assumptions": ASSUMPTIONS}

@app.get("/api/replay/{date_str}")
def replay_day(date_str: str = "2026-05-02", enable_arbitrage: bool = Query(True)):
    sub = df[df["date_str"] == date_str]
    if sub.empty:
        raise HTTPException(status_code=404, detail=f"Replay date '{date_str}' not found in dataset")
    q = default_level(enable_arbitrage)
    bk = model_buffers(q, not enable_arbitrage)
    cap = DEFAULT_CAPITAL
    res = run_strategy(to_rows(bk), (cap - DEFAULT_BOND_CORE, 0.0, DEFAULT_BOND_CORE, 0.0), enable_arbitrage)
    rows_of_day = sub.index.to_numpy()
    k_night = [k for k, i in enumerate(SW) if i in set(rows_of_day)]
    buf = float(bk[k_night[0]]) if k_night else float("nan")
    need = float(NEED[k_night[0]]) if k_night else float("nan")
    out = []
    for i in rows_of_day:
        tag = "08:00 REPO MATURITY UNLOCK" if MATURE[i] else "17:00 REPO SWEEP WINDOW" if WINDOW[i] else "INTRADAY CLEARING"
        out.append({"hour": f"{HOUR[i]:02d}:00", "deposits_m": round(DEP[i] / 1e6, 2), "withdrawals_m": round(WD[i] / 1e6, 2),
                    "net_flow_m": round(NET[i] / 1e6, 2), "tier0_m": round(res["t0"][i] / 1e6, 2),
                    "tier1_m": round(res["t1"][i] / 1e6, 2), "ml_q98_var_m": round(buf / 1e6, 2) if not math.isnan(buf) else None,
                    "mse_mean_pred_m": round(float(mse_buffers()[k_night[0]]) / 1e6, 2) if k_night else None,
                    "repo_rate_apy": round(float(REPO_APY[i]), 2), "event": tag})
    return {"date": date_str, "total_net_flow_m": round(float(sub["net_flow_usd"].sum()) / 1e6, 2),
            "required_buffer_m": None if math.isnan(buf) else round(buf / 1e6, 2),
            "actual_overnight_need_m": None if math.isnan(need) else round(need / 1e6, 2), "hours": out}

@app.get("/api/validation")
def validation():
    """Coverage table + leak test. Leak test: scramble every flow after the 17:00 row of night k and require identical buffer."""
    rows = []
    for q, conf in [(0.5, False), (0.7, False), (0.9, True), (0.95, True), (0.977, True)]:
        b = model_buffers(q, conf)
        n, x, cov = coverage(b, NEED)
        rows.append({"service_level": q, "conformal": conf, "coverage": round(cov, 4), "uncovered": x, "nights": n,
                     "kupiec_pvalue": round(kupiec(n, x, q), 4), "avg_buffer_m": round(float(b[WARM:].mean()) / 1e6, 2)})
    k_test = 200
    rng = np.random.default_rng(1)
    net2 = NET.copy()
    net2[SW[k_test]:] = rng.normal(0, 30e6, N - SW[k_test])      # future replaced by noise
    F2 = build_features(net2, np.array([np.maximum(0, -np.cumsum(net2[i:i + LOCK_H])).max() for i in SW]))
    p_true, _ = walk_forward(FEAT_MAT, NEED, "quantile", 0.5, upto=k_test)
    p_alt, _ = walk_forward(F2, np.array([np.maximum(0, -np.cumsum(net2[i:i + LOCK_H])).max() for i in SW]), "quantile", 0.5, upto=k_test)
    passed = bool(abs(p_true[k_test] - p_alt[k_test]) < 1e-6)
    return {"coverage_table": rows, "leak_test": {"night_index": k_test, "buffer_real": float(p_true[k_test]),
            "buffer_with_scrambled_future": float(p_alt[k_test]), "passed": passed}}

@app.get("/api/sensitivity")
def sensitivity(levels: str = "0.3,0.5,0.7,0.9,0.95,0.99"):
    """Net PnL / penalties vs service level, for overdraft-allowed and strict modes (first call is slow: refits the model)."""
    capital, core = DEFAULT_CAPITAL, DEFAULT_BOND_CORE
    init = (capital - core, 0.0, core, 0.0)
    out = []
    for q in [float(x) for x in levels.split(",")]:
        for allow in (True, False):
            b = model_buffers(q, not allow)
            r = run_strategy(to_rows(b), init, allow)
            n, x, cov = coverage(b, NEED)
            out.append({"service_level": q, "mode": "overdraft_allowed" if allow else "strict", "net_pnl": round(r["pnl"], 2),
                        "penalties": round(r["pen"], 2), "repo_breaks": r["breaks"], "overdraft_hours": r["od_hours"],
                        "coverage": round(cov, 4), "avg_buffer_m": round(float(b[WARM:].mean()) / 1e6, 2)})
    return {"curve": out}

@app.get("/api/bond_sweep")
def bond_sweep(enable_arbitrage: bool = Query(True), shock_multiplier: float = Query(1.0),
               shock_date: str = Query("2026-05-02"), shock_hours: int = Query(48)):
    """PnL vs bond core size. Shows the upside of a bigger core and the point where forced sales begin."""
    capital = DEFAULT_CAPITAL
    b = to_rows(model_buffers(default_level(enable_arbitrage), not enable_arbitrage))
    out = []
    for core_m in range(0, 1001, 100):
        core = core_m * 1e6
        r = run_strategy(b, (capital - core, 0.0, core, 0.0), enable_arbitrage, shock_vec(shock_multiplier, shock_date, shock_hours))
        out.append({"bond_core_m": core_m, "net_pnl": round(r["pnl"], 2), "penalties": round(r["pen"], 2),
                    "forced_bond_sales": round(r["bond_sale"], 2), "min_cash_m": round(r["min_cash"] / 1e6, 2),
                    "overdraft_hours": r["od_hours"]})
    return {"curve": out, "note": "The best core depends on the annual cash drain, which is only known in hindsight; treat it as a strategic parameter."}

@app.get("/api/bond_shock")
def bond_shock(shock_bp: float = Query(100.0), bond_core_m: float = Query(400.0)):
    """Duration stress: dP/P ~ -D_mod * dy. Compares the mark-to-market loss with a year of bond carry advantage over repo."""
    D = float(BOND_DUR[-1])
    loss = bond_core_m * 1e6 * D * shock_bp / 1e4
    adv = bond_core_m * 1e6 * (float(df["tier2_bond_yield_pct"].mean()) / 100 - float(REPO_APY.mean()) / 100 * LOCK_H / 24)
    return {"modified_duration": D, "shock_bp": shock_bp, "mtm_loss": round(loss, 2), "annual_carry_advantage_vs_repo": round(adv, 2),
            "survives_one_year": bool(adv >= loss), "note": "Loss is only realised if bonds are sold; held to the horizon it is a mark-to-market move."}

# ----------------------------------------------------------------------------- warm caches at import
for _q, _c in [(0.5, False), (0.95, True)]:
    model_buffers(_q, _c)
mse_buffers()

# CHANGELOG
# v3.0: target = overnight trough; walk-forward; no calendar hardcodes in AEGIS; shared recourse + capital;
#       no free negative cash; computed Sharpe/drawdown/coverage/Kupiec/leak test; oracle + fixed + legacy baselines;
#       RWA atomic mode removed; bond sweep + duration shock endpoints; honest hash-chain naming + real Merkle root.


@app.get("/api/nights")
def nights(enable_arbitrage: bool = Query(True), service_level: float = Query(0.0)):
    """Per-night buffer vs true overnight need (for the 'buffer vs reality' chart)."""
    q = service_level or default_level(enable_arbitrage)
    b = model_buffers(q, not enable_arbitrage)
    return {"service_level": q, "mode": "overdraft_allowed" if enable_arbitrage else "strict",
            "nights": [{"date": str(df["date_str"].iloc[i]), "buffer_m": round(float(b[k]) / 1e6, 2),
                        "need_m": round(float(NEED[k]) / 1e6, 2), "covered": bool(b[k] >= NEED[k] - 1e-6),
                        "warmup": bool(k < WARM)} for k, i in enumerate(SW)]}

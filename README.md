# AEGIS // Algorithmic Treasury & Reserve Juggler

Walk-forward quantile liquidity engine, 4-tier reserve waterfall, and SHA-256 proof-of-reserves hash chain.

---

## 1. Environment & Setup

### Prerequisites
- Python 3.10+ (tested on Python 3.12 / 3.14)
- Node.js 18+ and npm

### Backend Installation
From the repository root:
```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r Backend/requirements.txt
```

### Frontend Installation
```powershell
cd Frontend
npm install
cd ..
```

---

## 2. Running Locally

Run backend and frontend in separate terminals:

### Terminal 1: Backend
```powershell
.\.venv\Scripts\python.exe -m uvicorn Backend.main:app --host 127.0.0.1 --port 8000
```
> **Note:** Startup trains walk-forward quantile GBDT models and computes baseline buffers (takes ~15–20s). When ready, it outputs `Application startup complete`.

### Terminal 2: Frontend
```powershell
cd Frontend
npm run dev -- --host 127.0.0.1
```
Open **`http://127.0.0.1:5173`** in your browser.

---

## 3. Environment Variables

| Variable | Service | Default | Description |
|---|---|---|---|
| `AEGIS_CSV` | Backend | `treasury_4tier_dataset.csv` | Path to the 4-tier dataset CSV. Automatically discovered in the repository root or `Backend/` folder if not set. |
| `VITE_API_URL` | Frontend | `""` (proxies `/api` via Vite) | Base URL of the API for production deployment (e.g. `https://api.aegis.domain.com` or `http://127.0.0.1:8000`). |
| `VITE_API_BASE_URL` | Frontend | `""` | Backward-compatible alias for `VITE_API_URL`. |

---

## 4. API Endpoints

Interactive OpenAPI / Swagger documentation is available at `http://127.0.0.1:8000/docs`.

| Endpoint | Method | Parameters | Description |
|---|---|---|---|
| `/api/health` | `GET` | None | Engine status, rows loaded, active ML models, and night counts. |
| `/api/forensics` | `GET` | None | Forensic analysis of treasury dataset traps, tier economics, and intraday/weekly net flow cycles. |
| `/api/simulate` | `GET` | `enable_arbitrage`, `start_capital_m`, `structural_bond_m`, `shock_multiplier`, `shock_hours`, `shock_date`, etc. | Core simulation engine: runs AEGIS vs baselines (Oracle, Mean-forecast, Fixed, Legacy, Naive, Idle cash), daily series, KPIs, and proof-of-reserves hash chain. |
| `/api/replay/{date_str}` | `GET` | `date_str` (e.g. `2026-05-02`), `enable_arbitrage` | 24-hour hourly replay drill-down of deposits, withdrawals, balances, and sweep actions. |
| `/api/validation` | `GET` | None | Quantile calibration, coverage table across service levels, Kupiec LR test, and lookahead leak test. |
| `/api/sensitivity` | `GET` | None | Buffer sensitivity sweep curves (net PnL vs service level) for Overdraft vs Strict mode. |
| `/api/nights` | `GET` | `enable_arbitrage`, `service_level` | Night-by-night buffer vs true cash deficit and coverage indicators. |
| `/api/bond_sweep` | `GET` | None | Bond core allocation sweep curve, forced bond sales, and optimal non-liquidation threshold. |
| `/api/bond_shock` | `GET` | `shock_bp` (default 100) | Mark-to-market bond portfolio shock and duration impact. |
| `/api/assumptions` | `GET` | None | Full list of disclosed quantitative treasury model assumptions and policy rules. |

---

## 5. Verification & Tests

### Production Build & Linting
```powershell
cd Frontend
npm run build
npm run lint
cd ..
```

### Bad Input & Edge Case Testing
With the backend server running on port 8000:
```powershell
node test_bad_inputs.mjs
```

### Reference Values Check
```powershell
node test_reference_values.mjs
```

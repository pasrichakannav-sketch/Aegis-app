const endpoints = [
  'health',
  'forensics',
  'simulate?enable_arbitrage=true',
  'simulate?enable_arbitrage=false',
  'replay/2026-05-02',
  'validation',
  'sensitivity',
  'nights',
  'bond_sweep',
  'bond_shock?shock_bp=100',
  'assumptions'
];

async function check() {
  console.log('--- CALLING ALL ENDPOINTS ---');
  for (const ep of endpoints) {
    const t0 = performance.now();
    try {
      const res = await fetch('http://127.0.0.1:8000/api/' + ep);
      const data = await res.json();
      const dt = (performance.now() - t0).toFixed(0);
      console.log(`${ep.padEnd(35)} -> HTTP ${res.status} (${dt}ms)`);
    } catch (err) {
      console.log(`${ep.padEnd(35)} -> ERROR: ${err.message}`);
    }
  }
}

check();

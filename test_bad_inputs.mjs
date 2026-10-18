const testCases = [
  // shock_multiplier
  'simulate?shock_multiplier=0',
  'simulate?shock_multiplier=10',
  'simulate?shock_multiplier=-1',
  // start_capital_m
  'simulate?start_capital_m=0',
  'simulate?start_capital_m=100',
  'simulate?start_capital_m=10000',
  // structural_bond_m larger than capital
  'simulate?start_capital_m=1000&structural_bond_m=2000',
  // invalid replay date
  'replay/invalid-date-format',
  'replay/2099-01-01',
  'replay/1900-01-01',
  // shock_hours
  'simulate?shock_hours=0',
  'simulate?shock_hours=9999',
  'simulate?shock_hours=-1'
];

async function runBadInputs() {
  console.log('=== TESTING BAD INPUTS ===');
  for (const tc of testCases) {
    try {
      const res = await fetch('http://127.0.0.1:8000/api/' + tc);
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (e) {
        console.log(`FAIL: Non-JSON response for ${tc} (HTTP ${res.status})`);
        continue;
      }
      
      const containsNanOrInf = text.includes('NaN') || text.includes('Infinity');
      if (res.status === 500) {
        console.log(`FAIL (500 Error): ${tc} -> HTTP 500:`, json);
      } else if (containsNanOrInf) {
        console.log(`FAIL (NaN/Inf): ${tc} -> HTTP ${res.status} contains NaN or Infinity`);
      } else {
        console.log(`PASS: ${tc} -> HTTP ${res.status}`);
      }
    } catch (err) {
      console.log(`FAIL (Fetch error): ${tc} ->`, err.message);
    }
  }
}

runBadInputs();

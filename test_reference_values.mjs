async function testReferenceValues() {
  const [od, strict, val] = await Promise.all([
    fetch('http://127.0.0.1:8000/api/simulate?enable_arbitrage=true&start_capital_m=3000&structural_bond_m=400').then(r => r.json()),
    fetch('http://127.0.0.1:8000/api/simulate?enable_arbitrage=false&start_capital_m=3000&structural_bond_m=400').then(r => r.json()),
    fetch('http://127.0.0.1:8000/api/validation').then(r => r.json())
  ]);

  console.log('=== OVERDRAFT MODE ===');
  console.log('AEGIS net PnL:', (od.kpis.aegis_net_pnl / 1e6).toFixed(4) + 'M', 'expected ~54.37M');
  console.log('Oracle net PnL:', (od.kpis.oracle_net_pnl / 1e6).toFixed(4) + 'M', 'expected ~54.52M');
  console.log('Repo breaks:', od.kpis.aegis_repo_breaks, 'expected 0');
  console.log('Sharpe:', od.kpis.aegis_sharpe, 'expected ~2.78');

  console.log('\n=== STRICT MODE ===');
  console.log('AEGIS net PnL:', (strict.kpis.aegis_net_pnl / 1e6).toFixed(4) + 'M', 'expected ~53.84M');
  console.log('Repo breaks:', strict.kpis.aegis_repo_breaks, 'expected ~63');
  console.log('Penalties:', '$' + (strict.kpis.aegis_penalties / 1e3).toFixed(1) + 'K', 'expected ~$325K');

  console.log('\n=== VALIDATION & POR ===');
  console.log('leak_test.passed:', val.leak_test?.passed);
  console.log('OD has por_merkle_root_all_nights:', Boolean(od.por_merkle_root_all_nights));
  console.log('OD has por_blocks:', Array.isArray(od.por_blocks) && od.por_blocks.length > 0);
  console.log('Strict has por_merkle_root_all_nights:', Boolean(strict.por_merkle_root_all_nights));
  console.log('Strict has por_blocks:', Array.isArray(strict.por_blocks) && strict.por_blocks.length > 0);
}

testReferenceValues().catch(console.error);

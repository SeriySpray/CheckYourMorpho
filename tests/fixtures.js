// Спільні фабрики тестових даних.
// liquidity_usd за замовчуванням не обмежує вихід (0 тепер означає "нічого не можна вивести"), тож вихід визначають ринки.
export const vault = (over = {}) => ({
  address: '0xvault', name: 'Test Vault', version: 'v1', chain_id: 1,
  total_assets_usd: 100e6, liquidity_usd: 1e12, net_apy: 0.03, ...over
});

// Алокація, приєднана до ринку: чистий ринок із повною ліквідністю.
export const alloc = (over = {}) => ({
  market_unique_key: '1:0xabc', is_listed: 1, oracle_address: '0x1', lltv_percent: 86,
  chain_id: 1, collateral_asset_address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', collateral_asset_symbol: 'WETH', loan_asset_symbol: 'USDC',
  warnings_json: '[]', supply_assets_usd: 10e6, total_supply_assets_usd: 1e9, total_borrow_assets_usd: 0,
  peer_supply_usd: 0, collateral_risk_tier: 1, collateral_confidence: 'high', collateral_research_status: 'rated',
  collateral_researched_at: Math.floor(Date.now() / 1000), collateral_category: 'wrapped-crypto', ...over
});

// Collateral without any research record: unrated
export const unrated = (over = {}) => alloc({
  collateral_risk_tier: null, collateral_confidence: null, collateral_research_status: null, collateral_researched_at: null, collateral_category: null, ...over
});

// Десять різних застав по 10% TVL: здоровий vault без прапорців. Адреси синтетичні, усі з research tier 1.
export const diversified = () => Array.from({ length: 10 }, (_, i) =>
  alloc({ market_unique_key: `1:0x${i}`, collateral_asset_address: `0x${String(i + 1).padStart(40, '0')}`, collateral_asset_symbol: `TOK${i}` }));

export const idle = (over = {}) => alloc({
  collateral_asset_symbol: 'NONE', collateral_asset_address: '', lltv_percent: 0, oracle_address: '', ...over
});

// done резолвиться на res.end(): потрібно для обробників, що відповідають асинхронно (fs).
export function mockRes() {
  let finish;
  const res = {
    statusCode: null, headers: {}, body: '', done: new Promise(r => { finish = r; }),
    writeHead(c, h) { this.statusCode = c; this.headers = h || {}; },
    end(b) { this.body += b || ''; finish(this); }
  };
  return res;
}
export const mockReq = (method, url, headers = {}) => ({ method, url, headers, destroy() {}, resume() {} });

// Підміна глобального fetch на час одного тесту.
export async function withFetch(impl, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}
export const jsonResponse = (body, status = 200, headers = {}) => ({
  ok: status < 400, status, statusText: String(status), headers: new Headers(headers), json: async () => body
});

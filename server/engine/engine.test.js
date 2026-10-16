import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateMQI, isMarketClean, getMaterialityThresholdUsd } from './mqiEngine.js';
import { calculateLiquidityMetrics } from './liquidityEngine.js';
import { generateVaultVerdict } from './verdictEngine.js';
import { normalizeVaultV2 } from '../services/normalizers.js';

const market = (over = {}) => ({
  market_unique_key: '1:0xabc', is_listed: 1, oracle_address: '0x1', lltv_percent: 86,
  collateral_asset_symbol: 'WETH', loan_asset_symbol: 'USDC', warnings_json: '[]',
  supply_assets_usd: 0, total_supply_assets_usd: 100e6, total_borrow_assets_usd: 0, ...over
});

test('materiality threshold is capped for very large vaults', () => {
  assert.equal(getMaterialityThresholdUsd(1e9), 250000);
  assert.equal(getMaterialityThresholdUsd(1e6), 10000);
});

test('bad debt in a $1B vault is not laundered by the 1% dust rule', () => {
  const bad = market({ supply_assets_usd: 9.9e6, bad_debt_usd: 5e6 });
  const mqi = calculateMQI({ total_assets_usd: 1e9 }, [bad]);
  assert.equal(mqi.compromisedMarkets.length, 1);
  assert.ok(mqi.mqiPercent < 100);
});

test('liquidity warnings and yellow collateral warnings do not compromise a market', () => {
  const warn = (type, level) => market({ warnings_json: JSON.stringify([{ type, level }]) });
  assert.equal(isMarketClean(warn('sustained_low_liquidity', 'RED')).isClean, true);
  assert.equal(isMarketClean(warn('unrecognized_collateral_asset', 'YELLOW')).isClean, true);
  assert.equal(isMarketClean(warn('not_whitelisted', 'YELLOW')).isClean, false);
  assert.equal(isMarketClean(warn('bad_debt_unrealized', 'RED')).isClean, false);
});

test('tiny historical bad debt does not taint a large market', () => {
  assert.equal(isMarketClean(market({ realized_bad_debt_usd: 500 })).isClean, true);
  assert.equal(isMarketClean(market({ realized_bad_debt_usd: 50000 })).isClean, false);
});

test('V2 instant exit is capped by the vault-reported instant liquidity', () => {
  const vault = { version: 'v2', total_assets_usd: 1e6, liquidity_usd: 200000 };
  const alloc = market({ supply_assets_usd: 1e6 });
  assert.equal(calculateLiquidityMetrics(vault, [alloc]).instantExitCapacityPercent, 20);
  // V1 is capped by reported liquidity too; a reported 0 is a real zero, a missing value leaves exit unknown
  assert.equal(calculateLiquidityMetrics({ ...vault, version: 'v1' }, [alloc]).instantExitCapacityPercent, 20);
  assert.equal(calculateLiquidityMetrics({ ...vault, version: 'v1', liquidity_usd: 0 }, [alloc]).instantExitCapacityPercent, 0);
  assert.equal(calculateLiquidityMetrics({ ...vault, version: 'v1', liquidity_usd: null }, [alloc]).instantExitCapacityPercent, null);
});

test('V2 withdrawable liquidity counts force-deallocatable liquidity net of the adapter penalty', () => {
  const raw = {
    address: '0x1', asset: { decimals: 6, priceUsd: 1 }, chain: { id: 1 }, totalAssets: '8000000000000',
    totalAssetsUsd: 8e6, liquidityUsd: 2e6, forceDeallocatableLiquidityUsd: 6e6,
    adapters: { items: [{ forceDeallocatePenalty: '5000000000000000' }, { forceDeallocatePenalty: '0' }] } // 0.5% and 0%
  };
  assert.equal(normalizeVaultV2(raw).liquidity_usd, 2e6 + 6e6 * 0.995);
  assert.equal(normalizeVaultV2({ ...raw, adapters: { items: [] } }).liquidity_usd, 8e6);
});

test('stressed exit only shares free liquidity with peer vaults, not with direct lenders', () => {
  const vault = { version: 'v1', total_assets_usd: 1e6, liquidity_usd: 1e12 };
  // 90% utilized market: 1M of ours, 99M of other lenders (direct), 10M free liquidity, no peer vaults
  const noPeers = market({ supply_assets_usd: 1e6, total_supply_assets_usd: 100e6, total_borrow_assets_usd: 90e6, peer_supply_usd: 0 });
  const liq = calculateLiquidityMetrics(vault, [noPeers]);
  assert.equal(liq.stressedExitCapacityPercent, liq.instantExitCapacityPercent);
  assert.equal(liq.isCrowded, false);
  // with an equally large peer vault the free liquidity is shared 50/50
  const withPeer = { ...noPeers, supply_assets_usd: 5e6, total_borrow_assets_usd: 98e6, peer_supply_usd: 5e6 };
  const crowded = calculateLiquidityMetrics({ ...vault, total_assets_usd: 5e6 }, [withPeer]);
  assert.equal(crowded.instantExitCapacityUsd, 2e6); // 2M free liquidity
  assert.equal(crowded.stressedExitCapacityUsd, 1e6); // shared 50/50 with the peer vault
});

test('a small but material compromised position still raises the CRITICAL flag', () => {
  const vault = { version: 'v1', address: '0x1', name: 'Big', total_assets_usd: 10e9, liquidity_usd: 0 };
  const bad = market({ supply_assets_usd: 300000, bad_debt_usd: 100000 });
  const verdict = generateVaultVerdict(vault, [bad]);
  assert.equal(verdict.mqi.mqiPercent, 100); // rounded to 0.1, hides a 0.003% share
  assert.ok(verdict.redFlags.some(f => f.level === 'CRITICAL' && /Compromised/.test(f.title)));
});

import { researchTierOf, isImpairedCollateral } from './collateralEngine.js';
import { isIdleReserveMarket } from './hhiEngine.js';
import { getMaterialityThresholdUsd, isMarketClean, isUnpricedVault } from './mqiEngine.js';

export const EVENT_KINDS = Object.freeze([
  // Admin events (V1)
  'fee_changed',
  'timelock_changed',
  'cap_changed',
  'guardian_changed',
  'curator_changed',
  'owner_changed',
  'allocator_changed',
  'skim_recipient_changed',
  'supply_queue_changed',
  'withdraw_queue_changed',
  'reallocation',
  'market_removal_revoked',
  'cap_revoked',
  'skim',
  // Pending timelock configs (V1 and V2)
  'pending_cap_increase',
  'pending_market_removal',
  'pending_timelock_change',
  'pending_guardian_change',
  'pending_fee_change',
  'pending_adapter_change',
  'pending_allocator_change',
  'pending_gate_change',
  'pending_force_deallocate_penalty',
  'pending_abdicate',
  // Derived state transitions (V1 and V2)
  'verdict_worsened',
  'verdict_improved',
  'mqi_dropped',
  'bad_debt_appeared',
  'flagged_collateral_added',
  'tvl_drop',
  'exit_liquidity_low',
  'vault_delisted',
  'collateral_class_share_crossed',
  'collateral_tier_changed'
]);

export const SEVERITY_RANK = Object.freeze({
  info: 1,
  warning: 2,
  critical: 3
});

const INITIAL_ADMIN_BACKFILL_SECONDS = 7 * 86400;
const ZERO_ADDRESS_RE = /^0x0+$/i;

const normAddr = addr => String(addr || '').trim().toLowerCase();

// Morpho state reports fees as a [0..1] fraction while admin/pending events report WAD (1e18 = 100%).
const normalizeFeeFraction = raw => {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n > 1 ? n / 1e18 : n;
};

const toHumanTokenAmount = (rawAmount, decimals = 18) => {
  if (rawAmount === null || rawAmount === undefined || rawAmount === '') return 0;
  const n = Number(rawAmount);
  if (!Number.isFinite(n)) return 0;
  const dec = Number.isFinite(Number(decimals)) ? Number(decimals) : 18;
  return n / (10 ** dec);
};

const marketLabelFromData = market => {
  if (!market) return 'market';
  const coll = market.collateralAsset?.symbol || market.collateral_asset_symbol || 'Idle';
  const loan = market.loanAsset?.symbol || market.loan_asset_symbol || '';
  return loan ? `${coll}/${loan}` : coll;
};

const extractMarketId = market =>
  market?.marketId || market?.uniqueKey || market?.market_unique_key || null;

/**
 * Builds a deterministic deduplication key for vault_events.dedupe_key.
 */
export function buildDedupeKey(source, params = {}) {
  const vaultAddr = normAddr(params.vaultAddress || params.vault_address);
  if (source === 'admin_event') {
    const hash = normAddr(params.hash || params.txHash);
    const type = String(params.type || params.kind || 'unknown');
    const suffix = params.discriminator ? `:${params.discriminator}` : '';
    return `admin:${vaultAddr}:${hash}:${type}${suffix}`;
  }
  if (source === 'pending_config') {
    const fnOrKind = String(params.functionName || params.kind || 'unknown');
    const txHash = normAddr(params.txHash || params.hash || '');
    const validAt = Number(params.validAt ?? params.valid_at ?? 0);
    const targetKey = String(params.targetKey ?? params.newValueHash ?? 'default');
    return `pending:${vaultAddr}:${fnOrKind}:${txHash}:${validAt}:${targetKey}`;
  }
  if (source === 'derived') {
    const kind = String(params.kind || 'unknown');
    const bucket = String(params.bucket || params.transitionKey || '0');
    return `derived:${vaultAddr}:${kind}:${bucket}`;
  }
  throw new Error(`Unsupported event source: ${source}`);
}

const mapSingleAdminEvent = (vaultContext, ev, trackingState, nowSec, disambiguator) => {
  const vaultAddress = vaultContext.address;
  const chainId = Number(vaultContext.chainId ?? vaultContext.chain_id ?? 1);
  const hash = String(ev.hash || '');
  const timestamp = Number(ev.timestamp || nowSec);
  const type = String(ev.type || '');
  const data = ev.data || {};
  let kind = null;
  let severity = 'info';
  let title = '';
  let details = { txHash: hash, rawType: type };

  if (type === 'setFee' || type === 'setFeeRecipient') {
    kind = 'fee_changed';
    if (type === 'setFeeRecipient') {
      const recipient = data.feeRecipient || null;
      severity = 'warning';
      title = 'Fee recipient updated';
      details = { ...details, feeRecipient: recipient };
    } else {
      const newFee = normalizeFeeFraction(data.fee);
      const oldFee = normalizeFeeFraction(data.oldFee ?? trackingState.fee);
      // Compare in percentage points rounded to 4 decimals so IEEE-754 noise at 5.00pp does not false-trigger
      const deltaPp = (newFee !== null && oldFee !== null)
        ? Math.round((newFee - oldFee) * 1e6) / 1e4
        : null;
      severity = (deltaPp !== null && deltaPp > 5) ? 'critical' : 'warning';
      const newPct = newFee !== null ? `${Math.round(newFee * 10000) / 100}%` : 'unknown';
      const oldPct = oldFee !== null ? `${Math.round(oldFee * 10000) / 100}%` : null;
      title = oldPct !== null ? `Performance fee changed from ${oldPct} to ${newPct}` : `Performance fee set to ${newPct}`;
      details = { ...details, oldFee, newFee, deltaPercentagePoints: deltaPp };
      if (newFee !== null) trackingState.fee = newFee;
    }
  } else if (type === 'setTimelock' || type === 'submitTimelock' || type === 'revokePendingTimelock') {
    kind = 'timelock_changed';
    if (type === 'revokePendingTimelock') {
      severity = 'warning';
      title = 'Pending timelock change revoked';
    } else {
      const newTimelock = data.timelock !== undefined && data.timelock !== null ? Number(data.timelock) : null;
      const oldTimelock = data.oldTimelock !== undefined && data.oldTimelock !== null
        ? Number(data.oldTimelock)
        : trackingState.timelock;
      const shrunk = newTimelock !== null && oldTimelock !== null && newTimelock < oldTimelock;
      severity = shrunk ? 'critical' : 'warning';
      title = oldTimelock !== null && newTimelock !== null
        ? `Timelock changed from ${oldTimelock}s to ${newTimelock}s`
        : `Timelock set to ${newTimelock ?? 0}s`;
      details = { ...details, oldTimelock, newTimelock };
      if (newTimelock !== null) trackingState.timelock = newTimelock;
    }
  } else if (type === 'setCap' || type === 'submitCap') {
    kind = 'cap_changed';
    const market = data.market || null;
    const marketId = extractMarketId(market);
    const decimals = market?.loanAsset?.decimals ?? vaultContext.assetDecimals ?? 18;
    const rawCap = data.cap ?? data.supplyCap ?? 0;
    const newCapHuman = toHumanTokenAmount(rawCap, decimals);
    const oldCapHuman = data.oldCap !== undefined
      ? toHumanTokenAmount(data.oldCap, decimals)
      : (marketId && trackingState.caps[marketId] !== undefined ? Number(trackingState.caps[marketId]) : null);
    const raisedOver2x = oldCapHuman !== null && oldCapHuman > 0 && newCapHuman > oldCapHuman * 2;
    severity = raisedOver2x ? 'warning' : 'info';
    const label = marketLabelFromData(market);
    title = `Supply cap updated for ${label}`;
    details = {
      ...details,
      marketId,
      marketLabel: label,
      oldCap: oldCapHuman,
      newCap: newCapHuman,
      rawCap: String(rawCap)
    };
    if (marketId) trackingState.caps[marketId] = newCapHuman;
  } else if (type === 'setGuardian' || type === 'submitGuardian' || type === 'revokePendingGuardian') {
    kind = 'guardian_changed';
    severity = 'warning';
    const guardian = data.guardian || null;
    title = type === 'revokePendingGuardian' ? 'Pending guardian change revoked' : 'Vault guardian updated';
    details = { ...details, guardian };
  } else if (type === 'setCurator') {
    kind = 'curator_changed';
    severity = 'warning';
    const curator = data.curatorAddress || data.curator || null;
    title = 'Vault curator updated';
    details = { ...details, curator };
  } else if (
    type === 'ownershipTransferred' ||
    type === 'ownershipTransferStarted' ||
    type === 'setOwner' ||
    type === 'transferOwnership'
  ) {
    kind = 'owner_changed';
    // A started transfer is not final yet; a completed one hands full control to a new address
    severity = type === 'ownershipTransferStarted' ? 'warning' : 'critical';
    const owner = data.owner || data.newOwner || null;
    title = type === 'ownershipTransferStarted' ? 'Ownership transfer started' : 'Vault owner updated';
    details = { ...details, owner };
  } else if (type === 'setIsAllocator') {
    kind = 'allocator_changed';
    severity = 'warning';
    const allocator = data.allocator || null;
    const isAllocator = Boolean(data.isAllocator);
    title = isAllocator ? 'Allocator enabled' : 'Allocator removed';
    details = { ...details, allocator, isAllocator };
  } else if (type === 'setSkimRecipient') {
    kind = 'skim_recipient_changed';
    severity = 'critical';
    const skimRecipient = data.skimRecipient || null;
    title = 'Skim recipient updated';
    details = { ...details, skimRecipient };
  } else if (type === 'setSupplyQueue') {
    kind = 'supply_queue_changed';
    severity = 'info';
    const queue = Array.isArray(data.supplyQueue) ? data.supplyQueue.map(extractMarketId).filter(Boolean) : [];
    title = `Supply queue updated (${queue.length} markets)`;
    details = { ...details, supplyQueue: queue };
  } else if (type === 'setWithdrawQueue') {
    kind = 'withdraw_queue_changed';
    severity = 'info';
    const queue = Array.isArray(data.withdrawQueue) ? data.withdrawQueue.map(extractMarketId).filter(Boolean) : [];
    title = `Withdraw queue updated (${queue.length} markets)`;
    details = { ...details, withdrawQueue: queue };
  } else if (type === 'revokePendingMarketRemoval' || type === 'revokeMarketRemoval') {
    kind = 'market_removal_revoked';
    severity = 'info';
    const market = data.market || null;
    const marketId = extractMarketId(market);
    const label = marketLabelFromData(market);
    title = `Pending market removal revoked for ${label}`;
    details = { ...details, marketId, marketLabel: label };
  } else if (type === 'revokePendingCap' || type === 'revokeCap') {
    kind = 'cap_revoked';
    severity = 'info';
    const market = data.market || null;
    const marketId = extractMarketId(market);
    const label = marketLabelFromData(market);
    title = `Pending cap change revoked for ${label}`;
    details = { ...details, marketId, marketLabel: label };
  } else if (type === 'skim') {
    kind = 'skim';
    severity = 'critical';
    const assetSymbol = data.asset?.symbol || vaultContext.assetSymbol || 'tokens';
    const decimals = data.asset?.decimals ?? vaultContext.assetDecimals ?? 18;
    const amountHuman = toHumanTokenAmount(data.amount, decimals);
    title = `Skimmed ${assetSymbol} from vault`;
    details = {
      ...details,
      assetAddress: data.asset?.address || null,
      assetSymbol,
      amount: amountHuman,
      rawAmount: data.amount !== undefined ? String(data.amount) : null
    };
  } else {
    return null;
  }

  const dedupeKey = buildDedupeKey('admin_event', {
    vaultAddress,
    hash,
    type,
    discriminator: disambiguator
  });

  return {
    vault_address: vaultAddress,
    chain_id: chainId,
    kind,
    source: 'admin_event',
    severity,
    status: 'final',
    title,
    details_json: JSON.stringify(details),
    dedupe_key: dedupeKey,
    occurred_at: timestamp,
    valid_at: null,
    detected_at: nowSec
  };
};

/**
 * Diffs V1 adminEvents against the previous watch state watermark.
 * On first observation (no prevState or no last_admin_event_ts), only events within the last 7 days are emitted.
 */
export function diffAdminEvents(vaultContext, rawAdminEvents = [], prevState = null, nowSec = Math.floor(Date.now() / 1000)) {
  const list = Array.isArray(rawAdminEvents) ? rawAdminEvents : [];
  const hasPrevWatermark = prevState && prevState.last_admin_event_ts !== null && prevState.last_admin_event_ts !== undefined;
  const cutoff = hasPrevWatermark
    ? Number(prevState.last_admin_event_ts)
    : nowSec - INITIAL_ADMIN_BACKFILL_SECONDS;

  let maxTs = hasPrevWatermark ? Number(prevState.last_admin_event_ts) : cutoff;
  for (const item of list) {
    const ts = Number(item?.timestamp || 0);
    if (ts > maxTs) maxTs = ts;
  }

  const eligible = list
    .filter(item => item && Number(item.timestamp || 0) > cutoff)
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));

  if (eligible.length === 0) {
    return { events: [], lastAdminEventTs: maxTs };
  }

  const initialCaps = {};
  if (Array.isArray(vaultContext?.allocations)) {
    for (const alloc of vaultContext.allocations) {
      const mKey = alloc.market_unique_key || alloc.marketId;
      if (mKey && alloc.supply_cap_human !== undefined && alloc.supply_cap_human !== null) {
        initialCaps[mKey] = Number(alloc.supply_cap_human);
      }
    }
  }
  if (prevState?.caps && typeof prevState.caps === 'object') {
    Object.assign(initialCaps, prevState.caps);
  }

  const trackingState = {
    fee: prevState?.fee !== undefined && prevState?.fee !== null
      ? normalizeFeeFraction(prevState.fee)
      : normalizeFeeFraction(vaultContext?.prevFee ?? null),
    timelock: prevState?.timelock !== undefined && prevState?.timelock !== null
      ? Number(prevState.timelock)
      : (vaultContext?.prevTimelock !== undefined && vaultContext?.prevTimelock !== null ? Number(vaultContext.prevTimelock) : null),
    caps: initialCaps
  };

  const events = [];
  const reallocGroups = new Map();
  const nonRealloc = [];

  for (const ev of eligible) {
    const type = String(ev.type || '');
    if (type === 'reallocateSupply' || type === 'reallocateWithdraw') {
      const hashKey = normAddr(ev.hash || '');
      if (!reallocGroups.has(hashKey)) {
        reallocGroups.set(hashKey, { hash: ev.hash || hashKey, timestamp: Number(ev.timestamp || nowSec), items: [] });
      }
      const grp = reallocGroups.get(hashKey);
      if (Number(ev.timestamp || 0) > grp.timestamp) grp.timestamp = Number(ev.timestamp);
      grp.items.push(ev);
    } else {
      nonRealloc.push(ev);
    }
  }

  // Count (hash, type) pairs so multicalls with multiple identical event types get deterministic discriminators
  const pairCounts = new Map();
  for (const ev of nonRealloc) {
    const k = `${normAddr(ev.hash)}:${ev.type}`;
    pairCounts.set(k, (pairCounts.get(k) || 0) + 1);
  }
  const pairSeen = new Map();

  for (const ev of nonRealloc) {
    const k = `${normAddr(ev.hash)}:${ev.type}`;
    const totalForPair = pairCounts.get(k) || 1;
    let disambiguator = null;
    if (totalForPair > 1) {
      const idx = pairSeen.get(k) || 0;
      pairSeen.set(k, idx + 1);
      const marketId = extractMarketId(ev.data?.market);
      disambiguator = marketId || String(idx);
    }
    const mapped = mapSingleAdminEvent(vaultContext, ev, trackingState, nowSec, disambiguator);
    if (mapped) events.push(mapped);
  }

  const vaultAddress = vaultContext.address;
  const chainId = Number(vaultContext.chainId ?? vaultContext.chain_id ?? 1);
  const priceUsd = Number(vaultContext.assetPriceUsd ?? vaultContext.asset_price_usd ?? 0);
  const defaultDecimals = Number(vaultContext.assetDecimals ?? vaultContext.asset_decimals ?? 18);

  for (const grp of reallocGroups.values()) {
    let totalSupplied = 0;
    let totalWithdrawn = 0;
    const byMarket = new Map();

    for (const item of grp.items) {
      const data = item.data || {};
      const market = data.market || null;
      const marketId = extractMarketId(market) || 'unknown';
      const label = marketLabelFromData(market);
      const decimals = market?.loanAsset?.decimals ?? defaultDecimals;
      if (!byMarket.has(marketId)) {
        byMarket.set(marketId, { marketId, marketLabel: label, suppliedAssets: 0, withdrawnAssets: 0 });
      }
      const entry = byMarket.get(marketId);
      if (item.type === 'reallocateSupply') {
        const amt = toHumanTokenAmount(data.suppliedAssets, decimals);
        entry.suppliedAssets += amt;
        totalSupplied += amt;
      } else {
        const amt = toHumanTokenAmount(data.withdrawnAssets, decimals);
        entry.withdrawnAssets += amt;
        totalWithdrawn += amt;
      }
    }

    const movements = [...byMarket.values()];
    const volumeTokens = Math.max(totalSupplied, totalWithdrawn);
    const volumeUsd = priceUsd > 0 ? Math.round(volumeTokens * priceUsd * 100) / 100 : null;
    const dedupeKey = buildDedupeKey('admin_event', {
      vaultAddress,
      hash: grp.hash,
      type: 'reallocation'
    });

    events.push({
      vault_address: vaultAddress,
      chain_id: chainId,
      kind: 'reallocation',
      source: 'admin_event',
      severity: 'info',
      status: 'final',
      title: `Reallocation across ${movements.length} market${movements.length === 1 ? '' : 's'}`,
      details_json: JSON.stringify({
        txHash: grp.hash,
        marketsCount: movements.length,
        totalSuppliedAssets: Math.round(totalSupplied * 1e6) / 1e6,
        totalWithdrawnAssets: Math.round(totalWithdrawn * 1e6) / 1e6,
        volumeUsd,
        movements
      }),
      dedupe_key: dedupeKey,
      occurred_at: grp.timestamp,
      valid_at: null,
      detected_at: nowSec
    });
  }

  events.sort((a, b) => a.occurred_at - b.occurred_at);
  return { events, lastAdminEventTs: maxTs };
}

const mapSinglePendingConfig = (vaultContext, item, currentCaps, currentTimelocks, nowSec) => {
  const vaultAddress = vaultContext.address;
  const chainId = Number(vaultContext.chainId ?? vaultContext.chain_id ?? 1);
  const fn = String(item.functionName || '');
  const validAt = Number(item.validAt ?? item.valid_at ?? nowSec);
  const txHash = String(item.txHash || item.hash || '');
  const decoded = item.decodedData || {};
  const typename = String(decoded.__typename || '');

  let kind = null;
  let severity = 'warning';
  let title = '';
  let targetKey = 'default';
  let details = { functionName: fn, txHash, validAt };

  if (fn === 'SetCap' || typename === 'VaultSetCapPendingData') {
    kind = 'pending_cap_increase';
    const market = decoded.market || null;
    const marketId = extractMarketId(market);
    const label = marketLabelFromData(market);
    const decimals = market?.loanAsset?.decimals ?? vaultContext.assetDecimals ?? vaultContext.asset_decimals ?? 18;
    const rawCap = decoded.supplyCap ?? decoded.cap ?? 0;
    const newCapHuman = toHumanTokenAmount(rawCap, decimals);
    const oldCapHuman = marketId && currentCaps[marketId] !== undefined ? Number(currentCaps[marketId]) : null;
    if (oldCapHuman !== null && oldCapHuman > 0 && newCapHuman > oldCapHuman * 2) {
      severity = 'critical';
    }
    targetKey = `${marketId || 'market'}:${String(rawCap)}`;
    title = `Pending supply cap increase for ${label}`;
    details = { ...details, marketId, marketLabel: label, oldCap: oldCapHuman, newCap: newCapHuman, rawCap: String(rawCap) };
  } else if (fn === 'RemoveMarket' || typename === 'VaultRemoveMarketPendingData') {
    kind = 'pending_market_removal';
    const market = decoded.market || null;
    const marketId = extractMarketId(market);
    const label = marketLabelFromData(market);
    targetKey = marketId || 'market';
    title = `Pending market removal for ${label}`;
    details = { ...details, marketId, marketLabel: label, caller: decoded.caller?.address || null };
  } else if (fn === 'SetTimelock' || typename === 'VaultSetTimelockPendingData') {
    kind = 'pending_timelock_change';
    const newTimelock = Number(decoded.timelock ?? 0);
    const oldTimelock = vaultContext.timelock !== undefined && vaultContext.timelock !== null
      ? Number(vaultContext.timelock)
      : null;
    if ((oldTimelock !== null && newTimelock < oldTimelock) || newTimelock === 0) {
      severity = 'critical';
    }
    targetKey = String(newTimelock);
    title = `Pending timelock change to ${newTimelock}s`;
    details = { ...details, oldTimelock, newTimelock };
  } else if (fn === 'SetGuardian' || typename === 'VaultSetGuardianPendingData') {
    kind = 'pending_guardian_change';
    const guardian = decoded.guardian?.address ?? (typeof decoded.guardian === 'string' ? decoded.guardian : null);
    if (!guardian || ZERO_ADDRESS_RE.test(guardian)) {
      severity = 'critical';
    }
    targetKey = normAddr(guardian || '0x0');
    title = (!guardian || ZERO_ADDRESS_RE.test(guardian))
      ? 'Pending guardian removal'
      : 'Pending guardian change';
    details = { ...details, guardian };
  } else if (
    fn === 'SetPerformanceFee' ||
    fn === 'SetManagementFee' ||
    fn === 'SetPerformanceFeeRecipient' ||
    fn === 'SetManagementFeeRecipient'
  ) {
    kind = 'pending_fee_change';
    const rawNewFee = decoded.performanceFee ?? decoded.managementFee ?? null;
    const newFee = normalizeFeeFraction(rawNewFee);
    const recipient = decoded.performanceFeeRecipient ?? decoded.managementFeeRecipient ?? null;
    const currentFee = fn === 'SetManagementFee'
      ? normalizeFeeFraction(vaultContext.managementFee ?? null)
      : normalizeFeeFraction(vaultContext.fee ?? vaultContext.performanceFee ?? null);
    if (newFee !== null && currentFee !== null && Math.round((newFee - currentFee) * 1e6) / 1e4 > 5) {
      severity = 'critical';
    }
    targetKey = `${fn}:${rawNewFee ?? recipient ?? item.data ?? 'fee'}`;
    title = `Pending ${fn} update`;
    details = { ...details, oldFee: currentFee, newFee, recipient };
  } else if (fn === 'AddAdapter' || fn === 'RemoveAdapter' || fn === 'SetAdapterRegistry') {
    kind = 'pending_adapter_change';
    const adapter = decoded.adapterAddress || decoded.adapterRegistry || null;
    targetKey = `${fn}:${normAddr(adapter || item.data || 'adapter')}`;
    title = `Pending adapter change (${fn})`;
    details = { ...details, adapterAddress: adapter };
  } else if (fn === 'SetIsAllocator') {
    kind = 'pending_allocator_change';
    const allocator = decoded.account?.address || decoded.allocator || null;
    const isAllocator = decoded.isAllocator !== undefined ? Boolean(decoded.isAllocator) : null;
    targetKey = `${normAddr(allocator || item.data || 'allocator')}:${isAllocator}`;
    title = 'Pending allocator permission change';
    details = { ...details, allocator, isAllocator };
  } else if (
    fn === 'SetReceiveSharesGate' ||
    fn === 'SetSendSharesGate' ||
    fn === 'SetReceiveAssetsGate' ||
    fn === 'SetSendAssetsGate'
  ) {
    kind = 'pending_gate_change';
    const gate = decoded.receiveSharesGate || decoded.sendSharesGate || decoded.receiveAssetsGate || decoded.sendAssetsGate || null;
    targetKey = `${fn}:${normAddr(gate || item.data || 'gate')}`;
    title = `Pending gate change (${fn})`;
    details = { ...details, gate };
  } else if (fn === 'IncreaseTimelock' || fn === 'DecreaseTimelock') {
    kind = 'pending_timelock_change';
    const newTimelock = Number(decoded.timelock ?? 0);
    const selector = decoded.selector || null;
    const targetFn = decoded.functionName || null;
    const oldTimelock = (selector && currentTimelocks[selector] !== undefined)
      ? Number(currentTimelocks[selector])
      : (targetFn && currentTimelocks[targetFn] !== undefined ? Number(currentTimelocks[targetFn]) : null);
    if (fn === 'DecreaseTimelock' || (oldTimelock !== null && newTimelock < oldTimelock)) {
      severity = 'critical';
    }
    targetKey = `${selector || targetFn || item.data || 'tl'}:${newTimelock}`;
    title = `Pending timelock ${fn === 'DecreaseTimelock' ? 'decrease' : 'increase'}${targetFn ? ` for ${targetFn}` : ''}`;
    details = { ...details, targetFunction: targetFn, selector, oldTimelock, newTimelock };
  } else if (fn === 'IncreaseAbsoluteCap' || fn === 'IncreaseRelativeCap') {
    kind = 'pending_cap_increase';
    const rawCap = decoded.cap ?? 0;
    const cfg = decoded.config || {};
    const cfgId = cfg.id || null;
    const market = cfg.data?.market || null;
    const marketId = extractMarketId(market);
    const decimals = market?.loanAsset?.decimals ?? vaultContext.assetDecimals ?? vaultContext.asset_decimals ?? 18;
    const newCapHuman = fn === 'IncreaseRelativeCap'
      ? normalizeFeeFraction(rawCap)
      : toHumanTokenAmount(rawCap, decimals);
    const lookupKey = marketId || cfgId;
    const oldCapHuman = lookupKey && currentCaps[lookupKey] !== undefined ? Number(currentCaps[lookupKey]) : null;
    if (oldCapHuman !== null && oldCapHuman > 0 && newCapHuman !== null && newCapHuman > oldCapHuman * 2) {
      severity = 'critical';
    }
    targetKey = `${cfgId || marketId || item.data || 'cap'}:${String(rawCap)}`;
    title = `Pending cap increase (${fn})`;
    details = { ...details, configId: cfgId, configType: cfg.type || null, marketId, oldCap: oldCapHuman, newCap: newCapHuman, rawCap: String(rawCap) };
  } else if (fn === 'SetForceDeallocatePenalty') {
    kind = 'pending_force_deallocate_penalty';
    const adapterAddress = decoded.adapterAddress || null;
    const penalty = normalizeFeeFraction(decoded.forceDeallocatePenalty);
    targetKey = `${normAddr(adapterAddress || item.data || 'adapter')}:${String(decoded.forceDeallocatePenalty ?? '')}`;
    title = 'Pending force deallocate penalty update';
    details = { ...details, adapterAddress, penalty };
  } else if (fn === 'Abdicate') {
    kind = 'pending_abdicate';
    const targetFn = decoded.functionName || null;
    const selector = decoded.selector || null;
    targetKey = `${selector || targetFn || item.data || 'abdicate'}`;
    title = `Pending abdication${targetFn ? ` of ${targetFn}` : ''}`;
    details = { ...details, targetFunction: targetFn, selector };
  } else {
    return null;
  }

  const dedupeKey = buildDedupeKey('pending_config', {
    vaultAddress,
    functionName: fn,
    kind,
    txHash,
    validAt,
    targetKey
  });

  return {
    vault_address: vaultAddress,
    chain_id: chainId,
    kind,
    source: 'pending_config',
    severity,
    status: 'pending',
    title,
    details_json: JSON.stringify(details),
    dedupe_key: dedupeKey,
    occurred_at: nowSec,
    valid_at: validAt,
    detected_at: nowSec
  };
};

/**
 * Diffs currently active V1/V2 pendingConfigs against existing 'pending' rows in vault_events.
 * Emits pending items and transitions disappeared pending rows to 'applied' (now >= valid_at) or 'revoked' (now < valid_at).
 */
export function diffPendingConfigs(vaultContext, rawPendingConfigs = [], existingPendingRows = [], nowSec = Math.floor(Date.now() / 1000)) {
  const list = Array.isArray(rawPendingConfigs) ? rawPendingConfigs : [];
  const existing = Array.isArray(existingPendingRows) ? existingPendingRows : [];

  const currentCaps = { ...(vaultContext?.caps || {}) };
  if (Array.isArray(vaultContext?.allocations)) {
    for (const alloc of vaultContext.allocations) {
      const mKey = alloc.market_unique_key || alloc.marketId;
      if (mKey && alloc.supply_cap_human !== undefined && alloc.supply_cap_human !== null) {
        currentCaps[mKey] = Number(alloc.supply_cap_human);
      }
    }
  }

  const currentTimelocks = {};
  if (Array.isArray(vaultContext?.timelocks)) {
    for (const tl of vaultContext.timelocks) {
      if (tl?.selector) currentTimelocks[tl.selector] = Number(tl.duration || 0);
      if (tl?.functionName) currentTimelocks[tl.functionName] = Number(tl.duration || 0);
    }
  }

  const events = [];
  const activeKeys = new Set();

  for (const item of list) {
    if (!item) continue;
    const mapped = mapSinglePendingConfig(vaultContext, item, currentCaps, currentTimelocks, nowSec);
    if (mapped) {
      events.push(mapped);
      activeKeys.add(mapped.dedupe_key);
    }
  }

  const statusUpdates = [];
  for (const row of existing) {
    if (!row || row.status !== 'pending') continue;
    if (!activeKeys.has(row.dedupe_key)) {
      const validAt = row.valid_at !== null && row.valid_at !== undefined ? Number(row.valid_at) : null;
      const nextStatus = (validAt !== null && nowSec >= validAt) ? 'applied' : 'revoked';
      statusUpdates.push({
        id: row.id,
        dedupe_key: row.dedupe_key,
        status: nextStatus
      });
    }
  }

  return { events, statusUpdates };
}

const deriveVerdictLevel = (vault, verdict) => {
  if (!verdict || !verdict.mqi) return null;
  if (verdict.mqi.unpriced || isUnpricedVault(vault)) return null;
  if (verdict.mqi.mqiPercent === null && Number(vault?.total_assets_usd || 0) > 0 && Number(verdict.mqi.verifiedAssetsUsd || 0) <= 0) {
    return null;
  }
  const flags = Array.isArray(verdict.redFlags) ? verdict.redFlags : [];
  if (flags.some(f => f.level === 'CRITICAL' || f.level === 'HIGH')) return 'red';
  if (flags.some(f => f.level === 'MEDIUM')) return 'yellow';
  return 'green';
};

/**
 * Builds the compact per-vault watch state object stored in vault_watch_state.state_json.
 */
export function buildWatchState(vault, allocations = [], verdict = null, extra = {}) {
  const totalAssetsUsd = vault?.total_assets_usd !== null && vault?.total_assets_usd !== undefined
    ? Number(vault.total_assets_usd)
    : null;
  const unpriced = verdict?.mqi ? Boolean(verdict.mqi.unpriced) : isUnpricedVault(vault || {});
  const verdictLevel = extra.verdictLevel ?? deriveVerdictLevel(vault || {}, verdict);
  const mqiPercent = verdict?.mqi?.mqiPercent !== undefined ? verdict.mqi.mqiPercent : null;

  const exitUnknown = verdict?.liquidity ? Boolean(verdict.liquidity.exitUnknown) : (vault?.liquidity_usd === null || vault?.liquidity_usd === undefined);
  const instantExitPercent = (!exitUnknown && verdict?.liquidity?.instantExitCapacityPercent !== undefined)
    ? verdict.liquidity.instantExitCapacityPercent
    : null;

  const collateralTier = verdict?.collateral?.tier || 'UNKNOWN';

  const materialityUsd = getMaterialityThresholdUsd(totalAssetsUsd || 0);
  const badDebtMarkets = {};
  const unverifiedBadDebtMarkets = [];
  const flaggedMarkets = {};
  const collateralTiers = {};
  const tokenUsd = new Map();
  const nowSec = extra.nowSec ?? Math.floor(Date.now() / 1000);
  const caps = {};

  for (const alloc of (Array.isArray(allocations) ? allocations : [])) {
    const mKey = alloc.market_unique_key || alloc.marketId;
    if (!mKey) continue;
    if (alloc.supply_cap_human !== undefined && alloc.supply_cap_human !== null) {
      caps[mKey] = Number(alloc.supply_cap_human);
    }
    const supplyUsd = Math.max(0, Number(alloc.supply_assets_usd) || 0);
    if (supplyUsd <= 0) continue;

    const label = `${alloc.collateral_asset_symbol || 'Idle'}/${alloc.loan_asset_symbol || ''}`;
    const badDebtReported = alloc.bad_debt_usd !== null && alloc.bad_debt_usd !== undefined
      && alloc.realized_bad_debt_usd !== null && alloc.realized_bad_debt_usd !== undefined;

    if (!badDebtReported) {
      unverifiedBadDebtMarkets.push(mKey);
    } else {
      const badDebtUsd = Math.max(0, Number(alloc.bad_debt_usd || 0)) + Math.max(0, Number(alloc.realized_bad_debt_usd || 0));
      const dustUsd = Math.max(10, (Number(alloc.total_supply_assets_usd) || 0) * 0.0001);
      if (badDebtUsd > dustUsd && supplyUsd >= Math.min(materialityUsd, 10)) {
        badDebtMarkets[mKey] = {
          marketKey: mKey,
          label,
          badDebtUsd: Math.round(badDebtUsd * 100) / 100,
          supplyUsd: Math.round(supplyUsd * 100) / 100
        };
      }
    }

    if (supplyUsd >= materialityUsd && materialityUsd >= 0 && !isIdleReserveMarket(alloc)) {
      const cleanCheck = isMarketClean(alloc);
      // Only impaired collateral (tier 5, confidence above low) is a flag; unrated collateral is not one
      const impaired = isImpairedCollateral(alloc, nowSec);
      if (!cleanCheck.isClean || impaired) {
        flaggedMarkets[mKey] = {
          marketKey: mKey,
          label,
          collateralSymbol: alloc.collateral_asset_symbol || 'UNKNOWN',
          collateralTier: researchTierOf(alloc, nowSec),
          reasons: cleanCheck.reasons,
          supplyUsd: Math.round(supplyUsd * 100) / 100
        };
      }
    }

    // Tier per token for tokens with a material total, so a tier change shows up as an event
    if (!isIdleReserveMarket(alloc)) {
      const tKey = `${Number(alloc.chain_id ?? vault?.chain_id ?? 1)}:${normAddr(alloc.collateral_asset_address)}`;
      const t = tokenUsd.get(tKey) || { usd: 0, tier: researchTierOf(alloc, nowSec) };
      t.usd += supplyUsd;
      tokenUsd.set(tKey, t);
    }
  }
  for (const [tKey, t] of tokenUsd) if (t.usd >= materialityUsd) collateralTiers[tKey] = t.tier;

  return {
    chain_id: Number(vault?.chain_id ?? vault?.chainId ?? 1),
    name: vault?.name ?? null,
    verdict_level: verdictLevel,
    mqi_percent: mqiPercent,
    total_assets_usd: totalAssetsUsd,
    unpriced,
    instant_exit_percent: instantExitPercent,
    exit_unknown: exitUnknown,
    is_listed: vault?.is_listed !== undefined ? Number(vault.is_listed) : 1,
    missed_syncs: Number(vault?.missed_syncs || 0),
    collateral_tier: collateralTier,
    collateral_model: extra.collateralModel ?? 'none',
    bad_debt_markets: badDebtMarkets,
    unverified_bad_debt_markets: unverifiedBadDebtMarkets,
    flagged_markets: flaggedMarkets,
    collateral_tiers: collateralTiers,
    fee: normalizeFeeFraction(vault?.fee ?? extra.fee ?? null),
    timelock: extra.timelock !== undefined && extra.timelock !== null ? Number(extra.timelock) : null,
    guardian: extra.guardian || null,
    caps,
    last_admin_event_ts: extra.lastAdminEventTs !== undefined ? extra.lastAdminEventTs : null
  };
}

const VERDICT_RANK = { green: 0, yellow: 1, red: 2 };

/**
 * Diffs consecutive watch states for a vault and returns derived events.
 * On first observation (prevState is null/undefined), returns [] so baseline state never triggers derived events.
 */
export function diffDerivedState(prevState, nextState, vaultContext, nowSec = Math.floor(Date.now() / 1000)) {
  if (!prevState || !nextState || !vaultContext?.address) {
    return [];
  }

  const vaultAddress = vaultContext.address;
  const chainId = Number(vaultContext.chainId ?? vaultContext.chain_id ?? 1);
  const syncHourBucket = Math.floor(nowSec / 3600);
  const events = [];
  // A new collateral model changes verdicts and flags without anything happening to the vault, so those two stay quiet for one sync.
  // shortcut: if the first tag fetch fails on one chain only, the model flips for the whole run and a later wave of flag events is possible, accepted
  const sameModel = (prevState.collateral_model ?? 'classes') === nextState.collateral_model;

  const pushDerived = (kind, severity, title, details, transitionKey, stableBucket = false) => {
    events.push({
      vault_address: vaultAddress,
      chain_id: chainId,
      kind,
      source: 'derived',
      severity,
      status: 'final',
      title,
      details_json: JSON.stringify(details),
      dedupe_key: buildDedupeKey('derived', {
        vaultAddress,
        kind,
        bucket: stableBucket ? transitionKey : `${transitionKey}:${syncHourBucket}`
      }),
      occurred_at: nowSec,
      valid_at: null,
      detected_at: nowSec
    });
  };

  // 1. Verdict transitions (ignore null/unknown)
  const prevVerdict = String(prevState.verdict_level ?? prevState.verdictLevel ?? '').toLowerCase();
  const nextVerdict = String(nextState.verdict_level ?? nextState.verdictLevel ?? '').toLowerCase();
  if (sameModel && prevVerdict in VERDICT_RANK && nextVerdict in VERDICT_RANK && prevVerdict !== nextVerdict) {
    if (VERDICT_RANK[nextVerdict] > VERDICT_RANK[prevVerdict]) {
      pushDerived(
        'verdict_worsened',
        nextVerdict === 'red' ? 'critical' : 'warning',
        `Vault audit verdict worsened from ${prevVerdict.toUpperCase()} to ${nextVerdict.toUpperCase()}`,
        { previousVerdict: prevVerdict, currentVerdict: nextVerdict },
        `${prevVerdict}->${nextVerdict}`
      );
    } else {
      pushDerived(
        'verdict_improved',
        'info',
        `Vault audit verdict improved from ${prevVerdict.toUpperCase()} to ${nextVerdict.toUpperCase()}`,
        { previousVerdict: prevVerdict, currentVerdict: nextVerdict },
        `${prevVerdict}->${nextVerdict}`
      );
    }
  }

  // 2. MQI drop (>= 10 points in one sync interval, both numeric)
  const prevMqi = prevState.mqi_percent ?? prevState.mqiPercent;
  const nextMqi = nextState.mqi_percent ?? nextState.mqiPercent;
  if (
    typeof prevMqi === 'number' && Number.isFinite(prevMqi) &&
    typeof nextMqi === 'number' && Number.isFinite(nextMqi) &&
    !prevState.unpriced && !nextState.unpriced
  ) {
    const drop = Math.round((prevMqi - nextMqi) * 100) / 100;
    if (drop >= 10) {
      pushDerived(
        'mqi_dropped',
        'warning',
        `Market Quality Index dropped by ${drop} points (${prevMqi}% to ${nextMqi}%)`,
        { previousMqi: prevMqi, currentMqi: nextMqi, drop },
        `${Math.round(prevMqi)}->${Math.round(nextMqi)}`
      );
    }
  }

  // 3. Bad debt appeared on a market of the vault
  const prevBadDebt = prevState.bad_debt_markets ?? prevState.badDebtMarkets ?? {};
  const nextBadDebt = nextState.bad_debt_markets ?? nextState.badDebtMarkets ?? {};
  const prevUnverifiedBd = new Set(prevState.unverified_bad_debt_markets ?? prevState.unverifiedBadDebtMarkets ?? []);
  for (const [mKey, info] of Object.entries(nextBadDebt)) {
    if (!prevBadDebt[mKey] && !prevUnverifiedBd.has(mKey)) {
      pushDerived(
        'bad_debt_appeared',
        'critical',
        `Bad debt detected in ${info.label || mKey} ($${info.badDebtUsd})`,
        { marketKey: mKey, marketLabel: info.label || mKey, badDebtUsd: info.badDebtUsd, supplyUsd: info.supplyUsd },
        mKey
      );
    }
  }

  // 4. Flagged collateral / market added with material exposure
  const prevFlagged = prevState.flagged_markets ?? prevState.flaggedMarkets ?? {};
  const nextFlagged = nextState.flagged_markets ?? nextState.flaggedMarkets ?? {};
  for (const [mKey, info] of Object.entries(sameModel ? nextFlagged : {})) {
    if (!prevFlagged[mKey]) {
      pushDerived(
        'flagged_collateral_added',
        'warning',
        `Flagged collateral or market exposure added: ${info.label || mKey}`,
        {
          marketKey: mKey,
          marketLabel: info.label || mKey,
          collateralSymbol: info.collateralSymbol,
          collateralTier: info.collateralTier,
          reasons: info.reasons || [],
          supplyUsd: info.supplyUsd
        },
        mKey
      );
    }
  }

  // 4b. Research tier of a material collateral token changed from one number to another (unrated to rated is not an event)
  const prevTiers = prevState.collateral_tiers ?? {};
  for (const [tKey, nextTier] of Object.entries(sameModel ? (nextState.collateral_tiers ?? {}) : {})) {
    const prevTier = prevTiers[tKey];
    if (Number.isInteger(prevTier) && Number.isInteger(nextTier) && prevTier !== nextTier) {
      const symbol = (vaultContext.allocations ?? []).find(a => `${Number(a.chain_id ?? chainId)}:${normAddr(a.collateral_asset_address)}` === tKey)?.collateral_asset_symbol || tKey;
      pushDerived(
        'collateral_tier_changed',
        nextTier >= 4 ? 'warning' : 'info',
        `Collateral ${symbol} risk tier changed from ${prevTier} to ${nextTier} (AI research)`,
        { tokenKey: tKey, collateralSymbol: symbol, previousTier: prevTier, currentTier: nextTier },
        `${tKey}:${nextTier}`
      );
    }
  }

  // 5. TVL drop (warning at <= -15%, critical at <= -30%)
  const prevTvl = prevState.total_assets_usd ?? prevState.totalAssetsUsd;
  const nextTvl = nextState.total_assets_usd ?? nextState.totalAssetsUsd;
  if (
    typeof prevTvl === 'number' && Number.isFinite(prevTvl) && prevTvl > 0 &&
    typeof nextTvl === 'number' && Number.isFinite(nextTvl) && nextTvl >= 0 &&
    !prevState.unpriced && !nextState.unpriced
  ) {
    const changeRatio = Math.round(((nextTvl - prevTvl) / prevTvl) * 1e6) / 1e6;
    if (changeRatio <= -0.15) {
      const dropPct = Math.round(Math.abs(changeRatio) * 1000) / 10;
      const severity = changeRatio <= -0.30 ? 'critical' : 'warning';
      pushDerived(
        'tvl_drop',
        severity,
        `Vault TVL dropped by ${dropPct}%`,
        { previousTvlUsd: prevTvl, currentTvlUsd: nextTvl, dropPercent: dropPct },
        `${severity}:${Math.round(dropPct)}`
      );
    }
  }

  // 6. Exit liquidity low (first falls under 20% from >= 20%)
  const prevExit = prevState.instant_exit_percent ?? prevState.instantExitCapacityPercent;
  const nextExit = nextState.instant_exit_percent ?? nextState.instantExitCapacityPercent;
  if (
    !prevState.exit_unknown && !nextState.exit_unknown &&
    typeof prevExit === 'number' && Number.isFinite(prevExit) &&
    typeof nextExit === 'number' && Number.isFinite(nextExit)
  ) {
    if (prevExit >= 20 && nextExit < 20) {
      pushDerived(
        'exit_liquidity_low',
        'warning',
        `Instant exit capacity fell below 20% (${nextExit}%)`,
        { previousExitPercent: prevExit, currentExitPercent: nextExit },
        `${Math.round(prevExit)}->${Math.round(nextExit)}`
      );
    }
  }

  // 7. Vault delisted
  const prevListed = prevState.is_listed ?? prevState.isListed;
  const nextListed = nextState.is_listed ?? nextState.isListed;
  if (prevListed !== null && prevListed !== undefined && nextListed !== null && nextListed !== undefined) {
    if (Number(prevListed) === 1 && Number(nextListed) === 0) {
      const vaultName = vaultContext.name ?? prevState.name ?? null;
      pushDerived(
        'vault_delisted',
        'warning',
        vaultName ? `Vault ${vaultName} was delisted from Morpho registry` : 'Vault was delisted from Morpho registry',
        { vaultName, previousListed: 1, currentListed: 0 },
        'delisted',
        true
      );
    }
  }

  return events;
}

/**
 * CheckYourMorpho: plain-language explanations of vault events.
 * For every event kind says what changed and what it means for a depositor of the vault.
 * Pure functions only: the activity panel renders the result.
 */

const NO_LIMIT_UNITS = 1e12; // caps at or above this many tokens are "unlimited" in practice (e.g. idle markets)
const ZERO_ADDRESS_RE = /^0x0*$/i;

/** "$1.2M", "$950K", "$12". Empty for missing values. */
function usd(value) {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return '';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${Math.round(abs)}`;
}

/** Token amount in compact form: "2.5M", "120K", "0.5". */
function amount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n * 100) / 100);
}

/** Fraction (0.25) or percent (25) to "25%". */
function percent(value, isFraction = true) {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return '';
  const p = isFraction ? n * 100 : n;
  return `${Math.round(p * 100) / 100}%`;
}

/** Seconds to "7 days", "1 day 12 hours", "30 minutes", "no delay". */
function duration(sec) {
  const s = Number(sec);
  if (sec === null || sec === undefined || sec === '' || !Number.isFinite(s)) return '';
  if (s <= 0) return 'no delay';
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `${plural(d, 'day')} ${plural(h, 'hour')}` : plural(d, 'day');
  if (h > 0) return m > 0 ? `${plural(h, 'hour')} ${plural(m, 'minute')}` : plural(h, 'hour');
  return m > 0 ? plural(m, 'minute') : plural(s, 'second');
}

/** "21 Oct 2026, 08:12" in the viewer's time zone. */
export function formatEventDate(ts) {
  const n = Number(ts);
  if (ts === null || ts === undefined || ts === '' || !Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n * 1000);
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function shortAddress(addr) {
  const s = String(addr || '');
  return s.length > 12 ? `${s.slice(0, 6)}...${s.slice(-4)}` : s;
}

/** "1 market", "3 markets", "several markets". */
function marketsPhrase(n) {
  const k = Number(n);
  return Number.isFinite(k) && k > 0 ? `${k} market${k === 1 ? '' : 's'}` : 'several markets';
}

/** True for a usable number (0 included). */
function has(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function isZero(addr) {
  return !addr || ZERO_ADDRESS_RE.test(String(addr).trim());
}

/** What the V2 timelocked function controls, for timelock and abdication texts. */
const FUNCTION_ROLES = Object.freeze({
  setIsAllocator: 'adding or removing allocators',
  addAdapter: 'adding new strategies (adapters)',
  removeAdapter: 'removing strategies (adapters)',
  setAdapterRegistry: 'changing the adapter registry',
  increaseAbsoluteCap: 'raising absolute allocation caps',
  increaseRelativeCap: 'raising relative allocation caps',
  increaseTimelock: 'lengthening timelocks',
  decreaseTimelock: 'shortening timelocks',
  setPerformanceFee: 'changing the performance fee',
  setManagementFee: 'changing the management fee',
  setPerformanceFeeRecipient: 'changing the performance fee recipient',
  setManagementFeeRecipient: 'changing the management fee recipient',
  setForceDeallocatePenalty: 'changing the emergency exit penalty',
  setReceiveSharesGate: 'restricting who can receive vault shares',
  setSendSharesGate: 'restricting who can withdraw or transfer shares',
  setReceiveAssetsGate: 'restricting who can receive withdrawn assets',
  setSendAssetsGate: 'restricting who can deposit',
  abdicate: 'giving up curator powers'
});

/** Which access a V2 gate controls, keyed by its setter. */
const GATE_ACTIONS = Object.freeze({
  SetSendAssetsGate: { who: 'deposit into the vault', exit: false },
  SetReceiveSharesGate: { who: 'receive vault shares (deposit or accept a transfer)', exit: false },
  SetSendSharesGate: { who: 'withdraw or transfer vault shares', exit: true },
  SetReceiveAssetsGate: { who: 'receive assets when withdrawing', exit: true }
});

function roleOf(fn) {
  return FUNCTION_ROLES[fn] || (fn ? `calling ${fn}` : 'this function');
}

/** "cbBTC" from "cbBTC/USDC" or "wmGLO collateral". */
function collateralOf(label) {
  return String(label || '').split('/')[0].replace(/ collateral$/i, '').trim();
}

/** Cap texts shared by pending_cap_increase and cap_changed. */
function explainCap(d, c, pending) {
  if (!has(d.newCap)) return null;
  const label = d.marketLabel || '';
  // A collateral cap limits every market that lends against that token, not one market
  const collateralCap = d.configType === 'Collateral' || / collateral$/i.test(label);
  const target = collateralCap ? `markets with ${collateralOf(label)} collateral` : (label || 'one allocation target');
  const into = collateralCap ? 'these markets together' : (label ? 'this market' : 'it');
  const relative = d.capKind === 'relative' || d.functionName === 'IncreaseRelativeCap';
  const unlimited = !relative && Number(d.newCap) >= NO_LIMIT_UNITS;
  const newCap = Number(d.newCap);
  const hasOld = d.oldCap !== null && d.oldCap !== undefined && d.oldCap !== '';
  let size; // how much may go there, as a phrase
  let capValue;
  let share = '';

  if (relative) {
    size = `${percent(newCap)} of the vault's deposits`;
    capValue = hasOld ? `${percent(d.oldCap)} to ${percent(newCap)}` : percent(newCap);
  } else if (unlimited) {
    size = 'any amount of deposits';
    capValue = 'No practical limit';
  } else {
    const inUsd = c.price > 0 ? usd(newCap * c.price) : '';
    size = `${amount(newCap)} ${c.sym}${inUsd ? ` (about ${inUsd})` : ''} of deposits`;
    capValue = hasOld ? `${amount(d.oldCap)} to ${amount(newCap)} ${c.sym}` : `${amount(newCap)} ${c.sym}`;
    const added = d.tvlShareAdded !== null && d.tvlShareAdded !== undefined && Number.isFinite(Number(d.tvlShareAdded))
      ? Number(d.tvlShareAdded)
      : (c.price > 0 && c.tvl > 0 ? (newCap * c.price) / c.tvl : null);
    if (added !== null && added > 0) {
      share = added >= 1 ? `${Math.round(added * 10) / 10}x the vault's current size` : `${percent(added)} of the vault's current size`;
    }
  }
  const facts = [{ label: relative ? 'Relative cap' : 'Supply cap', value: capValue }];
  if (label) facts.push({ label: collateralCap ? 'Collateral' : 'Market', value: collateralCap ? collateralOf(label) : label });
  if (share) facts.push({ label: 'Room added', value: share });

  const when = pending ? 'Once executed, the' : 'The';
  if (/^idle\b/i.test(label)) {
    return {
      summary: unlimited ? 'Limit on idle cash removed' : `Idle cash limit raised to ${capValue.split(' to ').pop()}`,
      what: `The curator ${pending ? 'submitted' : 'set'} a higher cap for the idle market ${label}.`,
      impact: `An idle market has no borrowers: money there earns no interest but carries no collateral risk. ${when} vault can keep more of your deposit as cash, which makes withdrawals easier but lowers the yield.`,
      facts
    };
  }

  if (hasOld && Number(d.oldCap) === newCap) {
    return {
      summary: `Cap on ${target} stays at ${capValue.split(' to ').pop()}`,
      what: `The curator ${pending ? 'submitted' : 'set'} the same cap for ${target} that it already has.`,
      impact: 'The limit does not change, so nothing changes for depositors.',
      facts
    };
  }

  const isNew = d.capWasZero === true || (!hasOld && !relative);
  const raised = !isNew && share && Number(d.oldCap) > 0; // share is then the increment, not the whole cap
  const collateral = collateralOf(label);
  const headline = `${unlimited ? 'any amount' : `up to ${share || size.replace(/ of deposits$/, '')}`} can go to ${target}`;
  return {
    summary: raised ? `Cap on ${target} grows by ${share}` : (isNew ? `New exposure: ${headline}` : headline[0].toUpperCase() + headline.slice(1)),
    what: `The curator ${pending ? 'submitted' : 'set'} a higher ${relative ? 'relative ' : ''}cap for ${target}.${isNew ? ' Until now the cap there was zero, so the vault could not lend there at all: this opens a new exposure.' : ''}`,
    impact: `${when} allocator can put ${unlimited ? '' : 'up to '}${size} into ${into}${share ? `, ${share}${raised ? ' more than before' : ''}` : ''}. `
      + (collateral
        ? `Your deposit then depends more on ${collateral} and on the oracle that prices it: if the collateral loses value faster than liquidators can act, the market takes bad debt and the vault's depositors share the loss.`
        : 'Your deposit then depends more on whatever that target lends against; open the vault audit to see its markets.'),
    facts
  };
}

function explainTimelock(d, c, pending) {
  if (!has(d.newTimelock)) return null;
  const oldT = d.oldTimelock, newT = Number(d.newTimelock);
  const hasOld = oldT !== null && oldT !== undefined && oldT !== '';
  const decrease = d.functionName === 'DecreaseTimelock' || (hasOld && newT < Number(oldT));
  const role = d.targetFunction ? roleOf(d.targetFunction) : 'risky curator changes';
  const Role = role[0].toUpperCase() + role.slice(1);
  const facts = [{ label: 'Timelock', value: hasOld ? `${duration(oldT)} to ${duration(newT)}` : duration(newT) }];
  if (d.targetFunction) facts.push({ label: 'Applies to', value: d.targetFunction, mono: true });
  const base = 'A timelock is the delay between a curator submitting a risky change and being able to execute it: the time depositors have to notice and leave.';
  return {
    summary: decrease
      ? (newT <= 0 ? `${Role} would take effect instantly, with no warning` : `Less warning before ${role}: ${duration(newT)}`)
      : `More warning before ${role}: ${duration(newT)}`,
    what: `The curator ${pending ? 'submitted' : 'set'} a new timelock for ${role}: ${hasOld ? `from ${duration(oldT)} to ${duration(newT)}` : duration(newT)}.`,
    impact: decrease
      ? `${base} ${newT <= 0 ? 'With no delay, such changes take effect the moment they are submitted, so you would only learn about them afterwards.' : 'A shorter delay leaves you less time to react to future changes.'}`
      : `${base} A longer delay gives you more time to react, which is good for depositors.`,
    facts
  };
}

function explainGuardian(d, c, pending) {
  const removed = isZero(d.guardian);
  return {
    summary: removed ? 'No one would be able to veto curator changes' : 'A new address can veto curator changes',
    what: removed
      ? `The curator ${pending ? 'submitted the removal of' : 'removed'} the vault guardian.`
      : `The ${pending ? 'curator submitted a new' : 'vault has a new'} guardian ${shortAddress(d.guardian)}.`,
    impact: removed
      ? 'The guardian can cancel pending changes during the timelock. Without one, depositors are protected only by the waiting period itself.'
      : 'The guardian can cancel pending curator changes during the timelock. It protects depositors only if it is independent from the curator, so check who controls this address.',
    facts: removed ? [] : [{ label: 'Guardian', value: d.guardian, mono: true }]
  };
}

function explainFee(d, c, pending) {
  const recipient = d.feeRecipient || d.recipient;
  if (recipient) {
    return {
      summary: 'Fees go to a new address; your yield is unchanged',
      what: `The fee recipient ${pending ? 'will change' : 'changed'} to ${shortAddress(recipient)}.`,
      impact: 'Only the destination of the curator\'s fees changes. The fee rate and your net yield stay the same.',
      facts: [{ label: 'Recipient', value: recipient, mono: true }]
    };
  }
  const hasNew = d.newFee !== null && d.newFee !== undefined && d.newFee !== '';
  if (!hasNew) return null;
  const newFee = Number(d.newFee);
  const hasOld = d.oldFee !== null && d.oldFee !== undefined && d.oldFee !== '';
  const up = hasOld && newFee > Number(d.oldFee);
  const apy = Number(c.vault?.apy);
  const netAfter = Number.isFinite(apy) && apy > 0 ? percent(apy * (1 - newFee)) : '';
  const facts = [{ label: 'Performance fee', value: hasOld ? `${percent(d.oldFee)} to ${percent(newFee)}` : percent(newFee) }];
  if (netAfter) facts.push({ label: 'Net APY at this fee', value: netAfter });
  return {
    summary: hasOld ? `Fee ${up ? 'rises' : 'falls'} to ${percent(newFee)} of the interest you earn` : `Fee set to ${percent(newFee)} of the interest you earn`,
    what: `The performance fee ${pending ? 'will change' : 'changed'} ${hasOld ? `from ${percent(d.oldFee)} ` : ''}to ${percent(newFee)}.`,
    impact: `The fee is taken from the interest the vault earns, not from your deposit.${netAfter ? ` At today's gross APY of ${percent(apy)} you would keep about ${netAfter}.` : ''}${up ? ' A higher fee lowers your net yield.' : ''}`,
    facts
  };
}

function explainAllocator(d, c, pending) {
  const enabled = d.isAllocator !== false;
  return {
    summary: enabled ? 'A new address can move deposits between markets' : 'An address loses the right to move deposits',
    what: `${shortAddress(d.allocator) || 'An address'} ${pending ? 'will be' : 'was'} ${enabled ? 'added as' : 'removed as'} an allocator.`,
    impact: enabled
      ? 'Allocators decide which markets your deposit is lent to, within the caps the curator set. They cannot exceed caps, but they choose where inside them your money goes.'
      : 'This address can no longer move deposits between markets.',
    facts: d.allocator ? [{ label: 'Allocator', value: d.allocator, mono: true }] : []
  };
}

const EXPLAINERS = {
  pending_cap_increase: (d, c) => explainCap(d, c, c.pending),
  cap_changed: (d, c) => {
    if (Number(d.newCap) === 0) {
      return {
        summary: `No new deposits will be lent in ${d.marketLabel || 'this market'}`,
        what: `The curator set the supply cap for ${d.marketLabel || 'a market'} to zero.`,
        impact: 'The vault stops sending new money to this market. Funds already there stay until they are withdrawn or moved. A zero cap is usually the first step before a market is removed.',
        facts: [{ label: 'Market', value: d.marketLabel || shortAddress(d.marketId) }, { label: 'Supply cap', value: '0' }]
      };
    }
    return explainCap(d, c, false);
  },

  pending_market_removal: (d) => ({
    summary: `${d.marketLabel || 'A market'} leaves the vault`,
    what: `The curator submitted the removal of ${d.marketLabel || 'a market'} from the vault.`,
    impact: 'After execution the vault can no longer lend to this market. Removing an empty market changes nothing for your balance. If the vault still has money there at that moment, it is written off and depositors take the loss, so a removal while funds remain is a warning sign.',
    facts: [{ label: 'Market', value: d.marketLabel || shortAddress(d.marketId) }]
  }),
  market_removal_revoked: (d) => ({
    summary: `${d.marketLabel || 'Market'} stays in the vault`,
    what: `A pending removal of ${d.marketLabel || 'a market'} was cancelled.`,
    impact: 'The market stays in the vault and nothing changes for depositors.',
    facts: [{ label: 'Market', value: d.marketLabel || shortAddress(d.marketId) }]
  }),
  cap_revoked: (d) => ({
    summary: `Cap increase for ${d.marketLabel || 'a market'} cancelled`,
    what: `A pending cap increase for ${d.marketLabel || 'a market'} was cancelled.`,
    impact: 'The vault keeps its current limit for this market; the extra exposure will not happen.',
    facts: [{ label: 'Market', value: d.marketLabel || shortAddress(d.marketId) }]
  }),

  pending_timelock_change: (d, c) => explainTimelock(d, c, c.pending),
  timelock_changed: (d, c) => explainTimelock(d, c, false),
  pending_guardian_change: (d, c) => explainGuardian(d, c, c.pending),
  guardian_changed: (d, c) => explainGuardian(d, c, false),
  pending_fee_change: (d, c) => explainFee(d, c, c.pending),
  fee_changed: (d, c) => explainFee(d, c, false),
  pending_allocator_change: (d, c) => explainAllocator(d, c, c.pending),
  allocator_changed: (d, c) => explainAllocator(d, c, false),

  curator_changed: (d) => !d.curator ? null : ({
    summary: 'Someone new manages the vault\'s risk settings',
    what: `The vault curator changed to ${shortAddress(d.curator)}.`,
    impact: 'The curator chooses which markets the vault may use and how much it may lend to each. A new curator can follow a different risk policy, so watch the next cap and market changes.',
    facts: d.curator ? [{ label: 'Curator', value: d.curator, mono: true }] : []
  }),
  owner_changed: (d) => !d.owner ? null : ({
    summary: d.rawType === 'ownershipTransferStarted' ? 'Vault ownership is being handed over' : 'The vault has a new owner',
    what: d.rawType === 'ownershipTransferStarted'
      ? `The owner started transferring the vault to ${shortAddress(d.owner)}; it completes when the new owner accepts.`
      : `The vault owner changed to ${shortAddress(d.owner)}.`,
    impact: 'The owner appoints the curator and the guardian and sets the timelock, so it has the final say over the vault\'s rules.',
    facts: d.owner ? [{ label: 'Owner', value: d.owner, mono: true }] : []
  }),
  skim_recipient_changed: (d) => !d.skimRecipient ? null : ({
    summary: 'Stray tokens go to a new address; deposits unaffected',
    what: `The skim recipient changed to ${shortAddress(d.skimRecipient)}.`,
    impact: 'Skim only collects tokens sent to the vault by mistake or received as rewards. It cannot touch deposits.',
    facts: d.skimRecipient ? [{ label: 'Recipient', value: d.skimRecipient, mono: true }] : []
  }),
  skim: (d) => !has(d.amount) ? null : ({
    summary: 'Stray tokens collected; deposits unaffected',
    what: `${amount(d.amount)}${d.assetSymbol ? ` ${d.assetSymbol}` : ''} were skimmed from the vault.`,
    impact: 'Skim collects tokens that are not part of deposits, such as rewards. Your balance does not change.',
    facts: []
  }),

  pending_adapter_change: (d) => {
    const remove = d.functionName === 'RemoveAdapter';
    const registry = d.functionName === 'SetAdapterRegistry';
    return {
      summary: registry ? 'Rules for allowed strategies change' : (remove ? 'The vault drops a strategy' : 'The vault can start using a new strategy'),
      what: registry
        ? `The curator submitted a new adapter registry ${shortAddress(d.adapterAddress)}.`
        : `The curator submitted ${remove ? 'the removal of' : 'a new'} adapter ${shortAddress(d.adapterAddress)}.`,
      impact: registry
        ? 'The registry limits which adapters the vault may add. A different registry can allow strategies that were not possible before.'
        : (remove
          ? 'An adapter is a strategy the vault lends through. After removal the vault no longer puts money into it.'
          : 'An adapter is a strategy the vault lends through. Once it is added and given caps, part of your deposit can go into it and carry its risk.'),
      facts: d.adapterAddress ? [{ label: registry ? 'Registry' : 'Adapter', value: d.adapterAddress, mono: true }] : []
    };
  },
  pending_gate_change: (d) => {
    const gate = GATE_ACTIONS[d.functionName] || { who: 'use the vault', exit: false };
    const open = isZero(d.gate);
    return {
      summary: open ? `Anyone will be able to ${gate.who.split(' (')[0]}` : `Only approved addresses could ${gate.who.split(' (')[0]}`,
      what: `The curator submitted ${open ? 'the removal of the' : 'a new'} gate controlling who can ${gate.who}.`,
      impact: open
        ? 'Without a gate, anyone can do this.'
        : `A gate is a contract that approves or blocks addresses. After execution only addresses it allows can ${gate.who}.${gate.exit ? ' This gate sits on the way out, so it could block your withdrawal.' : ''}`,
      facts: [{ label: 'Setter', value: d.functionName, mono: true }, ...(open ? [] : [{ label: 'Gate', value: d.gate, mono: true }])]
    };
  },
  pending_force_deallocate_penalty: (d) => !has(d.penalty) ? null : ({
    summary: `Emergency exit through this strategy costs ${percent(d.penalty)}`,
    what: `The curator submitted a force deallocation penalty of ${percent(d.penalty)} for adapter ${shortAddress(d.adapterAddress)}.`,
    impact: 'When the vault has no cash, any depositor can force it to pull money out of a strategy to withdraw. The penalty is what that emergency exit costs you, paid from the amount withdrawn. The protocol caps it at 2%.',
    facts: [{ label: 'Penalty', value: percent(d.penalty) }, ...(d.adapterAddress ? [{ label: 'Adapter', value: d.adapterAddress, mono: true }] : [])]
  }),
  pending_abdicate: (d) => ({
    summary: `The curator gives up ${roleOf(d.targetFunction)} for good`,
    what: `The curator submitted a permanent abdication of ${d.targetFunction || 'a function'}.`,
    impact: `After execution no one can call ${d.targetFunction || 'this function'} again, so ${roleOf(d.targetFunction)} becomes impossible forever and the current setting is locked in. This cannot be undone and usually makes the vault more predictable.`,
    facts: d.targetFunction ? [{ label: 'Function', value: d.targetFunction, mono: true }] : []
  }),

  verdict_worsened: (d) => !d.currentVerdict ? null : ({
    summary: `Audit level fell to ${String(d.currentVerdict || '').toUpperCase()}`,
    what: `Our audit level for the vault changed from ${String(d.previousVerdict || '').toUpperCase()} to ${String(d.currentVerdict || '').toUpperCase()}.`,
    impact: 'RED means at least one serious problem, such as bad debt, collateral we cannot price or verify, or very little cash for withdrawals. YELLOW means a moderate one. Open the vault audit to see which flags caused it.',
    facts: []
  }),
  verdict_improved: (d) => !d.currentVerdict ? null : ({
    summary: `Audit level improved to ${String(d.currentVerdict || '').toUpperCase()}`,
    what: `Our audit level for the vault changed from ${String(d.previousVerdict || '').toUpperCase()} to ${String(d.currentVerdict || '').toUpperCase()}.`,
    impact: 'The problems behind the previous level are no longer detected.',
    facts: []
  }),
  mqi_dropped: (d) => !has(d.currentMqi) ? null : ({
    summary: `Clean collateral share fell to ${percent(d.currentMqi, false)}`,
    what: `The Market Quality Index fell from ${percent(d.previousMqi, false)} to ${percent(d.currentMqi, false)}.`,
    impact: 'The index is the share of deposits lent against collateral we consider clean and verified. A drop means more of your deposit now backs loans with riskier or unverified collateral.',
    facts: []
  }),
  bad_debt_appeared: (d) => !has(d.badDebtUsd) ? null : ({
    summary: `${usd(d.badDebtUsd)} of unrecoverable debt in a market the vault uses`,
    what: `Borrowers in ${d.marketLabel || 'a market'} left ${usd(d.badDebtUsd)} of debt that their collateral could not cover.${d.afterDataGap ? ' It was first seen after a gap in data, so it may be older than this alert.' : ''}`,
    impact: `In Morpho a market's bad debt is shared by all of its lenders. The vault has ${usd(d.supplyUsd) || 'money'} in this market, so part of the loss falls on the vault's depositors and lowers the value of each share.`,
    facts: [{ label: 'Market', value: d.marketLabel || shortAddress(d.marketKey) }, { label: 'Vault supply there', value: usd(d.supplyUsd) }]
  }),
  flagged_collateral_added: (d) => !has(d.supplyUsd) ? null : ({
    summary: `${usd(d.supplyUsd)} now lent against flagged ${d.collateralSymbol || 'collateral'}`,
    what: `The vault now lends ${usd(d.supplyUsd)} in ${d.marketLabel || 'a market'} whose collateral${d.collateralSymbol ? ` ${d.collateralSymbol}` : ''} we flag${d.collateralClass ? ` (class ${d.collateralClass.toLowerCase()})` : ''}.`,
    impact: 'If that collateral loses its price or its oracle fails, the market can take bad debt and the vault\'s depositors share the loss.',
    facts: [{ label: 'Market', value: d.marketLabel || shortAddress(d.marketKey) }, ...((d.reasons || []).length ? [{ label: 'Reasons', value: d.reasons.join(', ') }] : [])]
  }),
  tvl_drop: (d, c) => {
    if (!has(d.previousTvlUsd) || !has(d.currentTvlUsd)) return null;
    const liq = Number(c.vault?.liquidityUsd), tvl = Number(c.vault?.totalAssetsUsd);
    const fresh = c.nowSec - Number(c.occurredAt) < 86400;
    const liqNow = fresh && Number.isFinite(liq) && tvl > 0 ? ` Right now ${usd(liq)} (${percent(liq / tvl)} of the vault) can be withdrawn instantly.` : '';
    return {
      summary: `${usd(Number(d.previousTvlUsd) - Number(d.currentTvlUsd))} left the vault in 24 hours`,
      what: `Deposits fell from ${usd(d.previousTvlUsd)} to ${usd(d.currentTvlUsd)} (-${d.dropPercent}%) within 24 hours.`,
      impact: `Large outflows often mean big holders leaving, sometimes in reaction to news or risk. They use up the vault's cash and push its markets' utilization up, which can make the next withdrawals slower.${liqNow}`,
      facts: [{ label: 'Change', value: `${usd(d.previousTvlUsd)} to ${usd(d.currentTvlUsd)}` }]
    };
  },
  exit_liquidity_low: (d) => !has(d.currentExitPercent) ? null : ({
    summary: `Only ${percent(d.currentExitPercent, false)} of deposits can be withdrawn right now`,
    what: `The share of deposits that can be withdrawn instantly fell from ${percent(d.previousExitPercent, false)} to ${percent(d.currentExitPercent, false)}.`,
    impact: 'The rest is lent to borrowers. A withdrawal larger than the available cash has to wait until borrowers repay or rising rates attract new lenders.',
    facts: []
  }),
  vault_delisted: () => ({
    summary: 'The vault is no longer in Morpho\'s public list',
    what: 'Morpho removed the vault from its public listing.',
    impact: 'Delisting does not move any funds, but the vault disappears from the Morpho app and may no longer be actively managed. Check the curator\'s announcements.',
    facts: []
  }),
  collateral_class_share_crossed: (d) => !d.currentLevel ? null : ({
    summary: `Collateral risk mix moved to ${d.currentLevel}`,
    what: `The vault's collateral risk mix changed from ${d.previousLevel} to ${d.currentLevel}.`,
    impact: `${d.highPercent !== undefined ? `High-risk collateral now backs ${percent(d.highPercent, false)} of deposits` : 'The share of riskier collateral changed'}${d.mediumPlusPercent !== undefined ? `, medium or higher backs ${percent(d.mediumPlusPercent, false)}` : ''}.`,
    facts: []
  }),

  reallocation: (d) => ({
    summary: `${usd(d.volumeUsd) || 'Funds'} moved between ${marketsPhrase(d.marketsCount)}`,
    what: `The allocator moved ${usd(d.volumeUsd) || 'funds'} between ${marketsPhrase(d.marketsCount)} in one transaction.`,
    impact: 'Reallocations are routine, but each one changes which collateral your deposit is exposed to.',
    facts: [],
    movements: (Array.isArray(d.movements) ? d.movements : []).map(m => ({
      label: (m.marketLabel || shortAddress(m.marketId)) + (has(m.lltvPercent) ? ` · LLTV ${percent(m.lltvPercent, false)}` : ''),
      change: Number(m.suppliedAssets || 0) - Number(m.withdrawnAssets || 0)
    }))
  }),
  supply_queue_changed: (d) => ({
    summary: 'Markets that receive new deposits changed',
    what: `The supply queue was updated; it now lists ${marketsPhrase((d.supplyQueue || []).length)}.`,
    impact: 'New deposits go only to the markets in this queue, in this order. Money already deposited stays where it is.',
    facts: [],
    markets: d.supplyQueue || []
  }),
  withdraw_queue_changed: (d) => ({
    summary: 'Markets that pay out withdrawals changed',
    what: `The withdraw queue was updated; it now lists ${marketsPhrase((d.withdrawQueue || []).length)}.`,
    impact: 'Withdrawals take cash from these markets in this order. A market missing from the queue cannot be used to pay out withdrawals.',
    facts: [],
    markets: d.withdrawQueue || []
  })
};

/** One paragraph about when a timelocked change takes effect, from its status and valid_at. */
export function describeTiming(event, nowSec = Math.floor(Date.now() / 1000)) {
  const status = String(event?.status || '').toLowerCase();
  if (status === 'applied') return 'The change has been executed and is in effect now.';
  if (status === 'revoked') return 'The change was revoked before it took effect. Nothing changed for depositors.';
  if (status !== 'pending') return '';
  const validAt = Number(event.valid_at ?? event.validAt);
  if (!Number.isFinite(validAt) || validAt <= 0) return '';
  // After the timelock anyone may execute a change; a V1 market removal is completed by an allocator updating the withdraw queue
  const who = event.kind === 'pending_market_removal' ? 'an allocator' : 'anyone';
  if (validAt > nowSec) {
    return `From ${formatEventDate(validAt)}, in ${duration(validAt - nowSec)}, ${who} can execute it. Until then it can still be revoked, and depositors who disagree have time to withdraw.`;
  }
  return `The waiting period ended on ${formatEventDate(validAt)}. Since then ${who} can execute it, but no one has yet.`;
}

/**
 * Explains an event for a depositor: { summary, what, impact, timing, facts, movements?, markets? }.
 * Unknown kinds or details fall back to the stored title, so the result is never empty.
 */
export function explainEvent(event, vault = null, nowSec = Math.floor(Date.now() / 1000)) {
  const details = event?.details && typeof event.details === 'object' ? event.details : {};
  const ctx = {
    vault,
    sym: vault?.asset?.symbol || 'tokens',
    price: Number(vault?.asset?.priceUsd) || 0,
    tvl: Number(vault?.totalAssetsUsd) || 0,
    pending: !['applied', 'revoked', 'final'].includes(String(event?.status || '').toLowerCase()),
    nowSec,
    occurredAt: event?.occurred_at ?? event?.occurredAt
  };
  const explainer = EXPLAINERS[String(event?.kind || '')];
  let out = null;
  try {
    out = explainer ? explainer(details, ctx) : null;
  } catch {
    out = null; // malformed details: the generic text below is still correct
  }
  const title = String(event?.title || '');
  const revoked = String(event?.status || '').toLowerCase() === 'revoked';
  return {
    summary: out?.summary ? (revoked ? `Cancelled: ${out.summary}` : out.summary) : '',
    what: out?.what || title,
    impact: revoked ? 'It never took effect, so nothing changed for depositors.' : (out?.impact || ''),
    timing: describeTiming(event, nowSec),
    facts: (out?.facts || []).filter(f => f && f.value !== '' && f.value !== null && f.value !== undefined),
    movements: out?.movements || [],
    markets: out?.markets || []
  };
}

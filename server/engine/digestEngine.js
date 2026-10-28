const MQI_CHANGE_POINTS = 10;
const APY_DROP_RATIO = 0.2;
const APY_DROP_MIN_ABS = 0.005;
const FEE_EPSILON = 0.0001;

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const pct = (fraction, digits = 2) => `${(Math.round(fraction * 100 * 10 ** digits) / 10 ** digits)}%`;

// Plain-language names for the verdict flags: a short label for the state and the sentence that explains it
const RISK_FLAGS = {
  'Restricted Exit Liquidity': ['low exit liquidity', 'Less than 20% of the deposits can be withdrawn immediately'],
  'Negative Net APY (Capital Decay)': ['negative yield', 'The vault is losing depositor principal'],
  'Compromised Market Exposure': ['market risk', 'Capital sits in markets with bad debt or failed checks'],
  'Unpriced Vault': ['unmeasurable risk', 'No USD price is available, so the risk cannot be measured'],
  'Unresolved Exposure': ['unidentified positions', 'Part of the capital sits in positions that could not be identified'],
  'Unverified Markets': ['incomplete data', 'Some markets could not be checked'],
  'Unknown Exit Liquidity': ['incomplete data', 'Withdrawable liquidity is not reported']
};
const RISK_RANK = { green: 0, yellow: 1, red: 2 };

/** Describes a verdict level and its flag titles ("A; B") in words: { label, detail }. Green is "no risk flags". */
export function describeRisk(level, reasons = null) {
  if (level === 'green') return { label: 'no risk flags', detail: '' };
  const known = String(reasons ?? '').split('; ').filter(Boolean).map(t => RISK_FLAGS[t] ?? [t.toLowerCase(), '']);
  if (known.length === 0) return { label: level === 'red' ? 'risk flags' : 'incomplete data', detail: '' };
  return {
    label: [...new Set(known.map(k => k[0]))].join(' and '),
    detail: known.map(k => k[1]).filter(Boolean).join('. ')
  };
}

/**
 * Compares the vault sample from about a day ago with the current one and returns digest items.
 * It is a snapshot diff, so a GREEN to RED to GREEN flap inside the day produces nothing.
 * `avgNetApy7d` is the mean Net APY of the last 7 days (fraction) or null.
 * `recentLevels` are the verdict levels of the last few hourly samples: a level change is reported only once it has
 * held through all of them, so a vault hovering around a threshold does not flip the digest back and forth.
 */
export function diffVaultSamples(baseline, current, avgNetApy7d = null, recentLevels = null) {
  if (!baseline || !current) return [];
  const items = [];

  const vPrev = String(baseline.verdict_level ?? '').toLowerCase();
  const vNow = String(current.verdict_level ?? '').toLowerCase();
  const levelHeld = !Array.isArray(recentLevels) || recentLevels.every(l => String(l ?? '').toLowerCase() === vNow);
  if (vPrev && vNow && vPrev !== vNow && levelHeld) {
    const from = describeRisk(vPrev, baseline.verdict_reasons);
    const to = describeRisk(vNow, current.verdict_reasons);
    const worse = (RISK_RANK[vNow] ?? 0) > (RISK_RANK[vPrev] ?? 0);
    items.push({ type: 'verdict', text: `Risk ${worse ? 'worsened' : 'improved'}: ${from.label} changed to ${to.label}${to.detail ? `. ${to.detail}.` : ''}` });
  }

  if (isNum(baseline.mqi_percent) && isNum(current.mqi_percent)) {
    const delta = Math.round((current.mqi_percent - baseline.mqi_percent) * 10) / 10;
    if (Math.abs(delta) >= MQI_CHANGE_POINTS) {
      items.push({ type: 'mqi', text: `MQI ${delta < 0 ? 'dropped' : 'rose'} from ${baseline.mqi_percent}% to ${current.mqi_percent}%` });
    }
  }

  if (isNum(avgNetApy7d) && isNum(current.net_apy) && avgNetApy7d > 0) {
    const drop = avgNetApy7d - current.net_apy;
    if (drop >= APY_DROP_MIN_ABS && drop / avgNetApy7d >= APY_DROP_RATIO) {
      items.push({ type: 'apy', text: `Net APY ${pct(current.net_apy)} is below its 7-day average of ${pct(avgNetApy7d)}` });
    }
  }

  if (isNum(baseline.fee) && isNum(current.fee) && Math.abs(current.fee - baseline.fee) >= FEE_EPSILON) {
    items.push({ type: 'fee', text: `Performance fee ${current.fee > baseline.fee ? 'increased' : 'decreased'} from ${pct(baseline.fee)} to ${pct(current.fee)}` });
  }

  return items;
}

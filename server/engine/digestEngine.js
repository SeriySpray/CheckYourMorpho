const MQI_CHANGE_POINTS = 10;
const APY_DROP_RATIO = 0.2;
const APY_DROP_MIN_ABS = 0.005;
const FEE_EPSILON = 0.0001;

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const pct = (fraction, digits = 2) => `${(Math.round(fraction * 100 * 10 ** digits) / 10 ** digits)}%`;

/**
 * Compares the vault sample from about a day ago with the current one and returns digest items.
 * It is a snapshot diff, so a GREEN to RED to GREEN flap inside the day produces nothing.
 * `avgNetApy7d` is the mean Net APY of the last 7 days (fraction) or null.
 */
export function diffVaultSamples(baseline, current, avgNetApy7d = null) {
  if (!baseline || !current) return [];
  const items = [];

  const vPrev = String(baseline.verdict_level ?? '').toLowerCase();
  const vNow = String(current.verdict_level ?? '').toLowerCase();
  if (vPrev && vNow && vPrev !== vNow) {
    items.push({ type: 'verdict', text: `Verdict changed from ${vPrev.toUpperCase()} to ${vNow.toUpperCase()}` });
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

import assert from 'node:assert/strict';

const base = { verdict_level: 'green', mqi_percent: 95, net_apy: 0.05, fee: 0.05 };

export default {
  describeRisk: [
    ['green - без прапорців; відомі прапорці мають зрозумілі назви, однакові мітки зливаються, невідомий прапорець лишається як є', ({ describeRisk }) => {
      assert.deepEqual(describeRisk('green', 'ignored'), { label: 'no risk flags', detail: '' });
      const both = describeRisk('red', 'Unverified Markets; Unknown Exit Liquidity; Unpriced Vault');
      assert.equal(both.label, 'incomplete data and unmeasurable risk');
      assert.equal(both.detail.split('. ').length, 3);
      assert.deepEqual(describeRisk('red', 'Some New Flag'), { label: 'some new flag', detail: '' });
    }],
    ['без причини: red - risk flags, yellow - incomplete data', ({ describeRisk }) => {
      assert.equal(describeRisk('red', null).label, 'risk flags');
      assert.equal(describeRisk('yellow').label, 'incomplete data');
    }],
  ],
  diffVaultSamples: [
    ['без змін або без однієї зі сторін -> порожньо', ({ diffVaultSamples }) => {
      assert.deepEqual(diffVaultSamples(base, { ...base }, 0.05), []);
      assert.deepEqual(diffVaultSamples(null, base), []);
      assert.deepEqual(diffVaultSamples(base, null), []);
    }],
    ['гістерезис: зміна рівня потрапляє в дайджест, лише якщо новий рівень тримався в усіх останніх знімках', ({ diffVaultSamples }) => {
      const red = { ...base, verdict_level: 'red' };
      assert.equal(diffVaultSamples(base, red, null, ['red', 'red', 'red']).length, 1);
      assert.deepEqual(diffVaultSamples(base, red, null, ['red', 'green', 'red']), []);
      assert.equal(diffVaultSamples(base, red, null, null).length, 1);
    }],
    ['вердикт: зміна в обидва боки; null/unknown ігноруються; флап GREEN-RED-GREEN за добу не дає нічого', ({ diffVaultSamples }) => {
      assert.match(diffVaultSamples(base, { ...base, verdict_level: 'red' })[0].text, /^Risk worsened: no risk flags changed to risk flags$/);
      assert.match(diffVaultSamples({ ...base, verdict_level: 'red' }, base)[0].text, /^Risk improved: risk flags changed to no risk flags$/);
      assert.match(diffVaultSamples({ ...base, verdict_level: 'red' }, { ...base, verdict_level: 'yellow' })[0].text, /^Risk improved: /);
      assert.deepEqual(diffVaultSamples({ ...base, verdict_level: null }, { ...base, verdict_level: 'red' }), []);
      assert.deepEqual(diffVaultSamples(base, { ...base, verdict_level: 'green' }), []);
    }],
    ['вердикт: причина з verdict_reasons дописується, без неї текст не змінюється', ({ diffVaultSamples }) => {
      const now = { ...base, verdict_level: 'red', verdict_reasons: 'Restricted Exit Liquidity' };
      assert.equal(diffVaultSamples(base, now)[0].text, 'Risk worsened: no risk flags changed to low exit liquidity. Less than 5% of the deposits can be withdrawn immediately.');
      assert.equal(diffVaultSamples(base, { ...now, verdict_reasons: null })[0].text, 'Risk worsened: no risk flags changed to risk flags');
      assert.equal(diffVaultSamples(now, base)[0].text, 'Risk improved: low exit liquidity changed to no risk flags');
    }],
    ['MQI: зміна на 10 пунктів і більше; 9.9 ігнорується', ({ diffVaultSamples }) => {
      assert.match(diffVaultSamples(base, { ...base, mqi_percent: 85 })[0].text, /dropped from 95% to 85%/);
      assert.match(diffVaultSamples({ ...base, mqi_percent: 70 }, { ...base, mqi_percent: 90 })[0].text, /rose/);
      assert.deepEqual(diffVaultSamples(base, { ...base, mqi_percent: 85.1 }), []);
      assert.deepEqual(diffVaultSamples(base, { ...base, mqi_percent: null }), []);
    }],
    ['Net APY: нижче 7-денного середнього на 20% і на 0.5 п.п.; близькі до нуля значення не шумлять; без середнього - нічого', ({ diffVaultSamples }) => {
      assert.match(diffVaultSamples(base, { ...base, net_apy: 0.03 }, 0.05)[0].text, /3% is below its 7-day average of 5%/);
      assert.deepEqual(diffVaultSamples(base, { ...base, net_apy: 0.042 }, 0.05), []);
      assert.deepEqual(diffVaultSamples(base, { ...base, net_apy: 0.0001 }, 0.002), []);
      assert.deepEqual(diffVaultSamples(base, { ...base, net_apy: 0.01 }, null), []);
    }],
    ['fee: і підвищення, і зниження', ({ diffVaultSamples }) => {
      assert.match(diffVaultSamples(base, { ...base, fee: 0.1 })[0].text, /increased from 5% to 10%/);
      assert.match(diffVaultSamples(base, { ...base, fee: 0.0 })[0].text, /decreased from 5% to 0%/);
      assert.deepEqual(diffVaultSamples(base, { ...base, fee: 0.05 + 1e-9 }), []);
    }],
    ['кілька змін дають кілька пунктів у порядку verdict, mqi, apy, fee', ({ diffVaultSamples }) => {
      const items = diffVaultSamples(base, { verdict_level: 'red', mqi_percent: 50, net_apy: 0.01, fee: 0.2 }, 0.05);
      assert.deepEqual(items.map(i => i.type), ['verdict', 'mqi', 'apy', 'fee']);
    }],
  ],
};

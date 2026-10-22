import assert from 'node:assert/strict';

const base = { verdict_level: 'green', mqi_percent: 95, net_apy: 0.05, fee: 0.05 };

export default {
  diffVaultSamples: [
    ['без змін або без однієї зі сторін -> порожньо', ({ diffVaultSamples }) => {
      assert.deepEqual(diffVaultSamples(base, { ...base }, 0.05), []);
      assert.deepEqual(diffVaultSamples(null, base), []);
      assert.deepEqual(diffVaultSamples(base, null), []);
    }],
    ['вердикт: зміна в обидва боки; null/unknown ігноруються; флап GREEN-RED-GREEN за добу не дає нічого', ({ diffVaultSamples }) => {
      assert.match(diffVaultSamples(base, { ...base, verdict_level: 'red' })[0].text, /GREEN to RED/);
      assert.match(diffVaultSamples({ ...base, verdict_level: 'red' }, base)[0].text, /RED to GREEN/);
      assert.deepEqual(diffVaultSamples({ ...base, verdict_level: null }, { ...base, verdict_level: 'red' }), []);
      assert.deepEqual(diffVaultSamples(base, { ...base, verdict_level: 'green' }), []);
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

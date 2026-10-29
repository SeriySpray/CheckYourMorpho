import assert from 'node:assert/strict';

const DAY = 86400;

export default {
  buildHistoryQuery: [
    ['V1 читає netApy з vaultByAddress, V2 читає avgNetApy з vaultV2ByAddress', ({ buildHistoryQuery: f }) => {
      assert.match(f('v1'), /vaultByAddress[\s\S]*netApy\(/);
      assert.match(f('v2'), /vaultV2ByAddress[\s\S]*avgNetApy\(/);
    }],
  ],
  parseHistory: [
    ['об\'єднує APY і TVL за добою, відсортовано від старої до нової', ({ parseHistory: f }) => {
      const data = { vaultByAddress: { historicalState: {
        apy: [{ x: 3 * DAY, y: 0.05 }, { x: 2 * DAY, y: 0.04 }],
        tvl: [{ x: 3 * DAY, y: 300 }, { x: 2 * DAY, y: 200 }]
      } } };
      assert.deepEqual(f(data), [{ day: 2, tvlUsd: 200, netApy: 0.04 }, { day: 3, tvlUsd: 300, netApy: 0.05 }]);
    }],
    ['дні до появи коштів (TVL менше $1) пропускаються', ({ parseHistory: f }) => {
      const data = { vaultV2ByAddress: { historicalState: {
        apy: [{ x: DAY, y: 0 }, { x: 2 * DAY, y: 0.03 }],
        tvl: [{ x: DAY, y: 1e-9 }, { x: 2 * DAY, y: 50 }]
      } } };
      assert.deepEqual(f(data), [{ day: 2, tvlUsd: 50, netApy: 0.03 }]);
    }],
    ['день без APY зберігає TVL і дає netApy null', ({ parseHistory: f }) => {
      const data = { vaultByAddress: { historicalState: { apy: [{ x: DAY, y: null }], tvl: [{ x: DAY, y: 10 }] } } };
      assert.deepEqual(f(data), [{ day: 1, tvlUsd: 10, netApy: null }]);
    }],
    ['порожня або відсутня відповідь дає []', ({ parseHistory: f }) => {
      assert.deepEqual(f(null), []); assert.deepEqual(f({ vaultByAddress: null }), []);
    }],
  ],
};

import assert from 'node:assert/strict';

// syncAllVaults не покрито: він пише в БД і ходить у мережу (потребує повного мока GraphQL).
export default {
  toBigInt: [
    ['рядок -> BigInt', ({ toBigInt: f }) => assert.equal(f('123'), 123n)],
    ['порожнє/null -> 0n', ({ toBigInt: f }) => { assert.equal(f(''), 0n); assert.equal(f(null), 0n); }],
    ['некоректний рядок -> 0n', ({ toBigInt: f }) => assert.equal(f('abc'), 0n)],
    ['дробове число -> 0n', ({ toBigInt: f }) => assert.equal(f(1.5), 0n)],
  ],
  expandMetaMorphoAdapters: [
    ['прямі caps переносяться як є', ({ expandMetaMorphoAdapters: f }) => {
      const r = f({ caps: { items: [{ allocation: '100', absoluteCap: '500', data: { market: { marketId: '0xA' } } }] } }, new Map());
      assert.equal(r.length, 1); assert.equal(r[0].allocation, '100'); assert.equal(r[0].viaVault, undefined);
    }],
    ['MetaMorpho-адаптер розкладається пропорційно', ({ expandMetaMorphoAdapters: f }) => {
      const under = { address: '0xUnder', state: { totalAssets: '1000', allocation: [{ supplyAssets: '600', market: { marketId: '0xA' } }, { supplyAssets: '400', market: { marketId: '0xB' } }] } };
      const r = f({ adapters: { items: [{ type: 'MetaMorpho', assets: '500', metaMorpho: { address: '0xUNDER' } }] } }, new Map([['0xunder', under]]));
      const byKey = Object.fromEntries(r.map(c => [c.data.market.marketId, c]));
      assert.equal(byKey['0xA'].allocation, '300'); assert.equal(byKey['0xB'].allocation, '200');
      assert.equal(byKey['0xA'].viaVault, '0xunder');
    }],
    ['нерозв\'язаний адаптер пропускається', ({ expandMetaMorphoAdapters: f }) => {
      const warn = console.warn; console.warn = () => {};
      try {
        assert.deepEqual(f({ name: 'V', adapters: { items: [{ type: 'MetaMorpho', assets: '500', metaMorpho: { address: '0xnone' } }] } }, new Map()), []);
      } finally { console.warn = warn; }
    }],
    ['адаптер іншого типу ігнорується', ({ expandMetaMorphoAdapters: f }) =>
      assert.deepEqual(f({ adapters: { items: [{ type: 'Other', assets: '5' }] } }, new Map()), [])],
    ['пряма алокація і look-through в одному ринку сумуються', ({ expandMetaMorphoAdapters: f }) => {
      const under = { address: '0xu', state: { totalAssets: '100', allocation: [{ supplyAssets: '100', market: { marketId: '0xA' } }] } };
      const r = f({ caps: { items: [{ allocation: '10', absoluteCap: '0', data: { market: { marketId: '0xA' } } }] },
        adapters: { items: [{ type: 'MetaMorpho', assets: '50', metaMorpho: { address: '0xu' } }] } }, new Map([['0xu', under]]));
      assert.equal(r.length, 1); assert.equal(r[0].allocation, '60'); assert.equal(r[0].viaVault, '0xu');
    }],
  ],
  isSyncing: [
    ['після імпорту синхронізація не активна', ({ isSyncing }) => assert.equal(isSyncing(), false)],
  ],
  getLastSyncResult: [
    ['до першої синхронізації null або об\'єкт', ({ getLastSyncResult }) => {
      const r = getLastSyncResult(); assert.ok(r === null || typeof r === 'object');
    }],
  ],
  onSyncSuccess: [
    ['реєстрація слухача не кидає виняток', ({ onSyncSuccess }) => onSyncSuccess(() => {})],
  ],
};

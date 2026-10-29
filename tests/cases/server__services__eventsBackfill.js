import assert from 'node:assert/strict';

export default {
  HISTORY_ADMIN_TYPES: [
    ['не містить реалокацій і черг (їх сотні на vault, критичність info)', ({ HISTORY_ADMIN_TYPES: t }) => {
      for (const x of ['reallocateSupply', 'reallocateWithdraw', 'setSupplyQueue', 'setWithdrawQueue']) assert.ok(!t.includes(x), x);
    }],
    ['містить зміни комісії, власника, guardian, allocator і cap', ({ HISTORY_ADMIN_TYPES: t }) => {
      for (const x of ['setFee', 'ownershipTransferred', 'setGuardian', 'setIsAllocator', 'setCap']) assert.ok(t.includes(x), x);
    }],
  ],
};

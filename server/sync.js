import { syncAllVaults } from './services/syncEngine.js';

console.log('[Runner] Launching Morpho sync job...');

syncAllVaults({ fetchHistoryForTop: true, minAssetsUsdForHistory: 5000 })
  .then((summary) => {
    console.log('[Runner] Sync job completed successfully!');
    process.exit(0);
  })
  .catch((err) => {
    console.error('[Runner] Sync job failed:', err);
    process.exit(1);
  });

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

export const CONFIG = {
  api: {
    morphoGraphqlUrl: 'https://api.morpho.org/graphql',
    requestTimeoutMs: 15000,
    pageThrottleMs: 250,
    maxRetries: 3
  },
  chains: {
    ethereum: 1,
    base: 8453,
    robinhood: 4663,
    arbitrum: 42161,
    polygon: 137,
    optimism: 10,
    katana: 747474,
    hyperevm: 999,
    unichain: 130,
    worldchain: 480,
    monad: 143,
    stable: 988,
    tempo: 4217,
    arc: 5042
  },
  db: {
    path: path.join(rootDir, 'data', 'morpho.db')
  },
  server: {
    port: 3000,
    host: 'localhost'
  },
  sync: {
    intervalMs: 180000, // 3 minutes for background full sync
    pageSize: 100,
    minTvlUsd: 5000
  }
};

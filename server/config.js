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
    base: 8453
  },
  db: {
    path: path.join(rootDir, 'data', 'morpho.db')
  },
  server: {
    port: 3000,
    host: 'localhost'
  },
  sync: {
    intervalMs: 60000, // 1 minute
    pageSize: 100,
    minTvlUsd: 5000
  }
};

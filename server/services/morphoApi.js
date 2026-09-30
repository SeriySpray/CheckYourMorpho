import { CONFIG } from '../config.js';

/**
 * Helper to pause execution
 * @param {number} ms
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends a GraphQL query to the Morpho API with retries and timeout
 * @param {string} query
 * @param {object} variables
 * @returns {Promise<any>}
 */
export async function fetchMorphoGraphQL(query, variables = {}) {
  let attempt = 0;
  const maxRetries = CONFIG.api.maxRetries;

  while (attempt <= maxRetries) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONFIG.api.requestTimeoutMs);

      const res = await fetch(CONFIG.api.morphoGraphqlUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal
      });

      clearTimeout(timer);

      if (res.status === 429) {
        // Rate limited
        attempt++;
        const backoff = 1000 * Math.pow(2, attempt);
        console.warn(`[MorphoAPI] Rate limited (429). Retrying in ${backoff}ms (attempt ${attempt}/${maxRetries})...`);
        await sleep(backoff);
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const json = await res.json();
      if (json.errors && json.errors.length > 0) {
        throw new Error(`GraphQL Error: ${json.errors[0].message}`);
      }

      return json.data;
    } catch (err) {
      attempt++;
      if (attempt > maxRetries) {
        throw new Error(`Morpho API request failed after ${maxRetries} retries: ${err.message}`);
      }
      const backoff = 800 * attempt;
      console.warn(`[MorphoAPI] Request error: ${err.message}. Retrying in ${backoff}ms...`);
      await sleep(backoff);
    }
  }
}

/**
 * Helper to fetch paginated vault items
 */
async function fetchPaginatedVaults(query, rootKey, where, pageSize) {
  let skip = 0;
  let results = [];
  while (true) {
    const data = await fetchMorphoGraphQL(query, {
      first: pageSize,
      skip: skip,
      where: where
    });
    const items = data?.[rootKey]?.items || [];
    results = results.concat(items);
    if (items.length < pageSize) break;
    skip += pageSize;
    await sleep(CONFIG.api.pageThrottleMs);
  }
  return results;
}

/**
 * Fetches all active & listed MetaMorpho Vaults on Ethereum & Base
 * @param {number[]} chainIds
 * @param {object} options
 * @returns {Promise<any[]>}
 */
export async function fetchAllVaults(chainIds = null, options = {}) {
  const query = `
    query GetVaults($first: Int!, $skip: Int!, $where: VaultFilters) {
      vaults(first: $first, skip: $skip, where: $where) {
        items {
          address
          symbol
          name
          listed
          liquidity {
            underlying
            usd
          }
          chain {
            id
            network
          }
          asset {
            address
            symbol
            decimals
            priceUsd
          }
          state {
            totalAssets
            totalAssetsUsd
            apy
            netApy
            fee
            curator
            owner
            pendingOwner
            allocation {
              market {
                marketId
                lltv
                irmAddress
                oracle {
                  address
                  type
                }
                loanAsset {
                  address
                  symbol
                  decimals
                  priceUsd
                }
                collateralAsset {
                  address
                  symbol
                  decimals
                  priceUsd
                }
                state {
                  supplyAssets
                  supplyAssetsUsd
                  borrowAssets
                  borrowAssetsUsd
                  supplyApy
                  borrowApy
                  utilization
                }
              }
              supplyAssets
              supplyAssetsUsd
              supplyCap
              supplyShares
            }
          }
        }
      }
    }
  `;

  // Strictly fetch only officially listed/published vaults from morpho.org
  const filterListed = { listed: true, ...(chainIds && chainIds.length ? { chainId_in: chainIds } : {}) };
  return await fetchPaginatedVaults(query, 'vaults', filterListed, 100);
}

/**
 * Fetches reallocation history for a specific vault address
 * @param {string} vaultAddress
 * @param {number} limit
 * @returns {Promise<any[]>}
 */
export async function fetchVaultReallocates(vaultAddress, limit = 500) {
  const query = `
    query GetReallocates($first: Int!, $skip: Int!, $vaultAddress: [String!]) {
      vaultReallocates(
        first: $first,
        skip: $skip,
        where: { vaultAddress_in: $vaultAddress },
        orderBy: Timestamp,
        orderDirection: Desc
      ) {
        items {
          id
          timestamp
          hash
          logIndex
          blockNumber
          type
          shares
          assets
          market {
            marketId
          }
          vault {
            address
          }
        }
      }
    }
  `;

  const pageSize = 100;
  let skip = 0;
  let reallocates = [];

  while (reallocates.length < limit) {
    const fetchSize = Math.min(pageSize, limit - reallocates.length);
    const data = await fetchMorphoGraphQL(query, {
      first: fetchSize,
      skip: skip,
      vaultAddress: [vaultAddress]
    });

    const items = data?.vaultReallocates?.items || [];
    reallocates = reallocates.concat(items);

    if (items.length < fetchSize) {
      break;
    }

    skip += fetchSize;
    await sleep(CONFIG.api.pageThrottleMs);
  }

  return reallocates;
}

/**
 * Fetches allocation/reallocation transactions for a Morpho Vault V2
 * @param {string} vaultAddress
 * @param {number} chainId
 * @param {number} limit
 * @returns {Promise<any[]>}
 */
export async function fetchVaultV2AllocationTransactions(vaultAddress, chainId, limit = 200) {
  const query = `
    query GetV2AllocTx($first: Int!, $skip: Int!, $vaultAddress: String!, $chainId: Int!) {
      vaultV2AllocationTransactions(
        first: $first,
        skip: $skip,
        vaultAddress: $vaultAddress,
        chainId: $chainId,
        orderBy: Timestamp,
        orderDirection: Desc
      ) {
        items {
          txHash
          logIndex
          blockNumber
          timestamp
          type
          change
          assets
          ids
        }
      }
    }
  `;

  const pageSize = Math.min(100, limit);
  let skip = 0;
  let allEvents = [];

  while (allEvents.length < limit) {
    const fetchSize = Math.min(pageSize, limit - allEvents.length);
    const data = await fetchMorphoGraphQL(query, {
      first: fetchSize,
      skip: skip,
      vaultAddress: vaultAddress,
      chainId: chainId
    });

    const items = data?.vaultV2AllocationTransactions?.items || [];
    allEvents = allEvents.concat(items);

    if (items.length < fetchSize) {
      break;
    }

    skip += fetchSize;
    await sleep(CONFIG.api.pageThrottleMs);
  }

  return allEvents;
}

/**
 * Fetches all active & listed Morpho Vaults V2 on specified chains
 * @param {number[]} chainIds
 * @param {object} options
 * @returns {Promise<any[]>}
 */
export async function fetchAllVaultV2s(chainIds = null, options = {}) {
  const query = `
    query GetVaultV2s($first: Int!, $skip: Int!, $where: VaultV2sFilters) {
      vaultV2s(first: $first, skip: $skip, where: $where) {
        items {
          address
          name
          symbol
          listed
          chain { id network }
          asset { address symbol decimals priceUsd }
          totalAssets
          totalAssetsUsd
          liquidity
          liquidityUsd
          forceDeallocatableLiquidity
          forceDeallocatableLiquidityUsd
          apy
          netApy
          performanceFee
          curator { address }
          owner { address }
          caps {
            items {
              allocation
              absoluteCap
              data {
                ... on MarketV1CapData {
                  market {
                    marketId
                    lltv
                    irmAddress
                    oracle { address }
                    loanAsset { address symbol decimals priceUsd }
                    collateralAsset { address symbol decimals priceUsd }
                    state {
                      supplyAssets
                      supplyAssetsUsd
                      borrowAssets
                      borrowAssetsUsd
                      supplyApy
                      borrowApy
                      utilization
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  // Strictly fetch only officially listed/published V2 vaults from morpho.org (pageSize: 25 to respect query complexity limits)
  const filterListed = { listed: true, ...(chainIds && chainIds.length ? { chainId_in: chainIds } : {}) };
  return await fetchPaginatedVaults(query, 'vaultV2s', filterListed, 25);
}

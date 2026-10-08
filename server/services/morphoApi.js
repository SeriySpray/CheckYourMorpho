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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.api.requestTimeoutMs);
    let res;

    try {
      res = await fetch(CONFIG.api.morphoGraphqlUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal
      });
    } catch (err) {
      attempt++;
      if (attempt > maxRetries) {
        throw new Error(`Morpho API request failed after ${maxRetries} retries: ${err.message}`);
      }
      const backoff = 800 * attempt;
      console.warn(`[MorphoAPI] Request error: ${err.message}. Retrying in ${backoff}ms...`);
      await sleep(backoff);
      continue;
    } finally {
      clearTimeout(timer);
    }

    try {
      if (res.status === 429) {
        // Rate limited
        attempt++;
        if (attempt > maxRetries) {
          throw new Error(`Morpho API rate limit (429) exceeded after ${maxRetries} retries`);
        }
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

  throw new Error(`Morpho API request failed: maximum retries (${maxRetries}) exceeded`);
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
                listed
                lltv
                irmAddress
                oracle {
                  address
                  type
                }
                warnings {
                  type
                  level
                }
                badDebt {
                  usd
                }
                realizedBadDebt {
                  usd
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
          curators {
            items {
              name
            }
          }
          owner { address }
          caps {
            items {
              allocation
              absoluteCap
              data {
                ... on MarketV1CapData {
                  market {
                    marketId
                    listed
                    lltv
                    irmAddress
                    oracle { address type }
                    warnings { type level }
                    badDebt { usd }
                    realizedBadDebt { usd }
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

  // Strictly fetch only officially listed/published V2 vaults from morpho.org (pageSize: 10 to respect query complexity limits)
  const filterListed = { listed: true, ...(chainIds && chainIds.length ? { chainId_in: chainIds } : {}) };
  return await fetchPaginatedVaults(query, 'vaultV2s', filterListed, 10);
}

/**
 * Fetches the directory of all official curators and their addresses from Morpho GraphQL.
 * @returns {Promise<Map<string, string>>} Lowercase address -> Curator name map
 */
export async function fetchCuratorDirectory() {
  const query = `
    query GetCurators {
      curators(first: 100) {
        items {
          id
          name
          addresses {
            address
            chainId
          }
        }
      }
    }
  `;

  try {
    const data = await fetchMorphoGraphQL(query);
    const items = data?.curators?.items || [];
    const curatorMap = new Map();

    for (const c of items) {
      if (!c.name) continue;
      for (const a of (c.addresses || [])) {
        if (a?.address) {
          curatorMap.set(a.address.toLowerCase(), c.name);
        }
      }
    }

    // Known ecosystem addresses not yet indexed in GraphQL
    curatorMap.set('0xdd00059904ddf45e30b4131345957f76f26b8f6c', 'HyperEVM');

    return curatorMap;
  } catch (err) {
    console.warn('[MorphoAPI] Could not fetch curator directory, using fallbacks:', err.message);
    return new Map();
  }
}



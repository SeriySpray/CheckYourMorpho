import { CONFIG } from '../config.js';

/**
 * Helper to pause execution
 * @param {number} ms
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fields of a V1 vault admin event, shared by the vault list query and the per-vault backfill
const ADMIN_EVENT_ITEMS = `items {
  hash
  timestamp
  type
  data {
    __typename
    ... on SetGuardianEventData { guardian }
    ... on SetCuratorEventData { curatorAddress }
    ... on OwnershipEventData { owner }
    ... on SetIsAllocatorEventData { allocator isAllocator }
    ... on SetSkimRecipientEventData { skimRecipient }
    ... on SetFeeEventData { fee }
    ... on SetFeeRecipientEventData { feeRecipient }
    ... on TimelockEventData { timelock }
    ... on CapEventData {
      cap
      market {
        marketId
        loanAsset { symbol decimals }
        collateralAsset { symbol }
      }
    }
    ... on SetSupplyQueueEventData {
      supplyQueue { marketId }
    }
    ... on SetWithdrawQueueEventData {
      withdrawQueue { marketId }
    }
    ... on ReallocateSupplyEventData {
      suppliedAssets
      suppliedShares
      market {
        marketId
        lltv
        collateralAsset { symbol }
        loanAsset { symbol decimals }
      }
    }
    ... on ReallocateWithdrawEventData {
      withdrawnAssets
      withdrawnShares
      market {
        marketId
        lltv
        collateralAsset { symbol }
        loanAsset { symbol decimals }
      }
    }
    ... on RevokeCapEventData {
      market {
        marketId
        collateralAsset { symbol }
        loanAsset { symbol }
      }
    }
    ... on RevokePendingMarketRemovalEventData {
      market {
        marketId
        collateralAsset { symbol }
        loanAsset { symbol }
      }
    }
    ... on SkimEventData {
      amount
      asset { address symbol decimals }
    }
  }
}`;

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
    let timer;
    // The abort alone once left fetch pending forever (sync stuck for 22 h on 2026-10-26), so the timer also rejects
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`Request timed out after ${CONFIG.api.requestTimeoutMs}ms`));
      }, CONFIG.api.requestTimeoutMs);
    });
    deadline.catch(() => {});

    try {
      const res = await Promise.race([deadline, fetch(CONFIG.api.morphoGraphqlUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal
      })]);

      if (res.status === 429) {
        attempt++;
        if (attempt > maxRetries) {
          throw new Error(`Morpho API rate limit (429) exceeded after ${maxRetries} retries`);
        }
        const retryAfterSec = parseInt(res.headers.get('retry-after') || '0', 10);
        const backoff = retryAfterSec > 0
          ? Math.min(retryAfterSec * 1000, 60000)
          : (1000 * Math.pow(2, attempt)) + Math.floor(Math.random() * 500);
        console.warn(`[MorphoAPI] Rate limited (429). Retrying in ${backoff}ms (attempt ${attempt}/${maxRetries})...`);
        await sleep(backoff);
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const json = await Promise.race([deadline, res.json()]);
      if (json.errors && json.errors.length > 0 && json.data) {
        console.warn(`[MorphoAPI] Partial GraphQL response, ${json.errors.length} error(s): ${json.errors[0]?.message}`);
        return json.data;
      }
      if (json.errors && json.errors.length > 0) {
        const firstErrMsg = json.errors[0]?.message || 'Unknown GraphQL Error';
        const isTransient = json.errors.some(e => {
          const m = (e.message || '').toLowerCase();
          return m.includes('timeout') || m.includes('rate') || m.includes('try again') || m.includes('overloaded');
        });
        if (!isTransient) {
          throw new Error(`Fatal GraphQL Error: ${firstErrMsg}`);
        }
        throw new Error(`Transient GraphQL Error: ${firstErrMsg}`);
      }

      return json.data;
    } catch (err) {
      if (err.message && err.message.startsWith('Fatal GraphQL Error:')) {
        throw err;
      }
      attempt++;
      if (attempt > maxRetries) {
        throw new Error(`Morpho API request failed after ${maxRetries} retries: ${err.message}`);
      }
      const backoff = (1000 * Math.pow(2, attempt)) + Math.floor(Math.random() * 500);
      console.warn(`[MorphoAPI] Request error: ${err.message}. Retrying in ${backoff}ms (attempt ${attempt}/${maxRetries})...`);
      await sleep(backoff);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`Morpho API request failed: maximum retries (${maxRetries}) exceeded`);
}

const ADMIN_PAGE_SIZE = 100;
const ADMIN_MAX_PAGES = 50;

/**
 * Fetches the admin events of one V1 vault, newest first, page by page until `sinceTs` is passed.
 * The vault list query only carries the latest 25 events: a busy vault or a sync gap needs more,
 * and a cut in the middle of a transaction would keep only some of its reallocation legs.
 */
export async function fetchVaultAdminEvents(address, chainId, sinceTs, maxPages = ADMIN_MAX_PAGES) {
  const query = `
    query GetVaultAdminEvents($address: String!, $chainId: Int!, $first: Int!, $skip: Int!) {
      vaultByAddress(address: $address, chainId: $chainId) {
        adminEvents(first: $first, skip: $skip) {
          ${ADMIN_EVENT_ITEMS}
        }
      }
    }
  `;
  const items = [];
  for (let page = 0; page < maxPages; page++) {
    const data = await fetchMorphoGraphQL(query, { address, chainId: Number(chainId), first: ADMIN_PAGE_SIZE, skip: page * ADMIN_PAGE_SIZE });
    const list = data?.vaultByAddress?.adminEvents?.items;
    if (!Array.isArray(list)) throw new Error(`Malformed adminEvents response for ${address}`);
    items.push(...list);
    const oldest = list.length ? Math.min(...list.map(i => Number(i.timestamp || 0))) : 0;
    if (list.length < ADMIN_PAGE_SIZE || oldest <= sinceTs) return items;
    await sleep(CONFIG.api.pageThrottleMs);
  }
  throw new Error(`adminEvents of ${address} exceed ${maxPages * ADMIN_PAGE_SIZE} items since ${sinceTs}`);
}

/**
 * Helper to fetch paginated vault items
 */
export async function fetchPaginatedVaults(query, rootKey, where, pageSize, isComplete) {
  let skip = 0;
  let results = [];
  while (true) {
    const data = await fetchMorphoGraphQL(query, {
      first: pageSize,
      skip: skip,
      where: where
    });
    // A partial GraphQL answer can null out nested fields or a whole page: never feed that to the sync
    const root = data?.[rootKey];
    if (!root || !Array.isArray(root.items)) {
      throw new Error(`Malformed ${rootKey} response`);
    }
    const broken = root.items.find(item => !isComplete(item));
    if (broken) {
      throw new Error(`Incomplete ${rootKey} item ${broken.address || '?'} (partial GraphQL response)`);
    }
    const items = root.items;
    results = results.concat(items);
    const countTotal = root.pageInfo?.countTotal;
    if (!Number.isFinite(countTotal)) {
      throw new Error(`Missing countTotal in ${rootKey} response`);
    }
    // Stop on countTotal too: an API that ignores skip would otherwise return full pages forever
    if (items.length < pageSize || results.length >= countTotal) {
      if (results.length < countTotal) {
        throw new Error(`Incomplete ${rootKey} fetch: got ${results.length} of ${countTotal}`);
      }
      break;
    }
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
        pageInfo { countTotal }
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
          metadata { description }
          asset {
            address
            symbol
            decimals
            price { usd }
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
            guardian
            timelock
            pendingConfigs {
              items {
                validAt
                functionName
                txHash
                decodedData {
                  __typename
                  ... on VaultSetCapPendingData {
                    supplyCap
                    market {
                      marketId
                      loanAsset { symbol decimals }
                      collateralAsset { symbol }
                    }
                  }
                  ... on VaultRemoveMarketPendingData {
                    caller { address }
                    market {
                      marketId
                      loanAsset { symbol }
                      collateralAsset { symbol }
                    }
                  }
                  ... on VaultSetTimelockPendingData {
                    timelock
                  }
                  ... on VaultSetGuardianPendingData {
                    guardian { address }
                  }
                }
              }
            }
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
                  price { usd }
                }
                collateralAsset {
                  address
                  symbol
                  decimals
                  price { usd }
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
          adminEvents(first: 25) {
            ${ADMIN_EVENT_ITEMS}
          }
        }
      }
    }
  `;

  // Strictly fetch only officially listed/published vaults from morpho.org
  const filterListed = { listed: true, ...(chainIds && chainIds.length ? { chainId_in: chainIds } : {}) };
  return await fetchPaginatedVaults(query, 'vaults', filterListed, 100, item => Boolean(item.state && item.asset && item.chain?.id));
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
        pageInfo { countTotal }
        items {
          address
          name
          symbol
          listed
          chain { id network }
          asset { address symbol decimals price { usd } }
          totalAssets
          totalAssetsUsd
          liquidity
          liquidityUsd
          liquidityData { ... on MarketV1LiquidityData { market { marketId } } }
          forceDeallocatableLiquidity
          forceDeallocatableLiquidityUsd
          apy
          netApy
          performanceFee
          managementFee
          metadata { description }
          curator { address }
          curators {
            items {
              name
            }
          }
          owner { address }
          timelocks {
            functionName
            selector
            duration
          }
          pendingConfigs {
            items {
              validAt
              functionName
              txHash
              data
              decodedData {
                __typename
                ... on VaultV2TimelockPendingData {
                  timelock
                  selector
                  functionName
                }
                ... on VaultV2SetPerformanceFeePendingData {
                  performanceFee
                }
                ... on VaultV2SetManagementFeePendingData {
                  managementFee
                }
                ... on VaultV2SetPerformanceFeeRecipientPendingData {
                  performanceFeeRecipient
                }
                ... on VaultV2SetManagementFeeRecipientPendingData {
                  managementFeeRecipient
                }
                ... on VaultV2AdapterPendingData {
                  adapterAddress
                }
                ... on VaultV2SetAdapterRegistryPendingData {
                  adapterRegistry
                }
                ... on VaultV2SetIsAllocatorPendingData {
                  isAllocator
                  account { address }
                }
                ... on VaultV2SetReceiveSharesGatePendingData {
                  receiveSharesGate
                }
                ... on VaultV2SetSendSharesGatePendingData {
                  sendSharesGate
                }
                ... on VaultV2SetReceiveAssetsGatePendingData {
                  receiveAssetsGate
                }
                ... on VaultV2SetSendAssetsGatePendingData {
                  sendAssetsGate
                }
                ... on VaultV2IncreaseCapPendingData {
                  cap
                  config {
                    id
                    type
                    data {
                      __typename
                      ... on MarketV1CapData {
                        market {
                          marketId
                          collateralAsset { symbol }
                          loanAsset { symbol decimals }
                        }
                      }
                      ... on AdapterCapData {
                        adapterAddress
                      }
                      ... on CollateralCapData {
                        collateralAddress
                        collateralToken { symbol }
                      }
                    }
                  }
                }
                ... on VaultV2SetForceDeallocatePenaltyPendingData {
                  adapterAddress
                  forceDeallocatePenalty
                }
                ... on VaultV2AbdicatePendingData {
                  selector
                  functionName
                }
              }
            }
          }
          adapters {
            items {
              type
              assets
              forceDeallocatePenalty
              ... on MetaMorphoAdapter { metaMorpho { address } }
            }
          }
          caps {
            items {
              id
              allocation
              absoluteCap
              relativeCap
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
                    loanAsset { address symbol decimals price { usd } }
                    collateralAsset { address symbol decimals price { usd } }
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
  return await fetchPaginatedVaults(query, 'vaultV2s', filterListed, 10,
    item => Boolean(item.asset && item.chain?.id && item.totalAssets != null && Array.isArray(item.caps?.items) && Array.isArray(item.adapters?.items)));
}

/**
 * Fetches the directory of all official curators and their addresses from Morpho GraphQL.
 * @returns {Promise<Map<string, string>>} Lowercase address -> Curator name map
 */
export async function fetchCuratorDirectory() {
  const query = `
    query GetCurators($first: Int!, $skip: Int!) {
      curators(first: $first, skip: $skip) {
        pageInfo { countTotal }
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
    const items = [];
    for (let skip = 0; ; skip += 100) {
      const data = await fetchMorphoGraphQL(query, { first: 100, skip });
      const page = data?.curators?.items || [];
      items.push(...page);
      if (page.length < 100) break;
    }
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



# CheckYourMorpho

[![Live](https://img.shields.io/badge/Live-checkyourmorpho.duckdns.org-2470FF?style=flat-square&logo=googlechrome&logoColor=white)](https://checkyourmorpho.duckdns.org)
[![Node.js](https://img.shields.io/badge/Node.js-22.13%2B-161B22?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Tests](https://github.com/SeriySpray/CheckYourMorpho/actions/workflows/tests.yml/badge.svg)](https://github.com/SeriySpray/CheckYourMorpho/actions/workflows/tests.yml)

CheckYourMorpho is a risk dashboard for Morpho vaults (MetaMorpho V1 and Morpho Vaults V2). It looks at a vault from the depositor's side: where the capital is lent, how concentrated the collateral behind it is, and how much of it can be withdrawn right now. The server has no npm dependencies; it uses Node's built-in `node:http` and `node:sqlite`.

## What it does

- Lists every vault that Morpho marks as listed, on all chains the Morpho API returns, with search by name, symbol, curator or address and filters by network, asset and curator.
- Sorts vaults by TVL, APY, liquidity, MQI or low-risk share of collateral.
- Opens an audit panel for a vault: its allocations by market, MQI, collateral facts collected about each token, instant and crowded exit capacity, and a list of red flags.
- Lets you pin vaults in the browser (stored in `localStorage`).
- Shows the vaults as a WebGL 2 particle sphere.

## How it works

1. Data comes from the public Morpho GraphQL API (`https://api.morpho.org/graphql`): listed V1 vaults with their allocations, listed V2 vaults with their market caps and adapters, and the curator directory.
2. The server syncs 5 seconds after start-up and then every 180 seconds. A sync writes vaults, markets and allocations in one SQLite transaction. Unlisted vaults are deleted, and a vault that is missing from 3 syncs in a row is deleted too. A V2 vault that holds a V1 vault through a MetaMorpho adapter is expanded into that V1 vault's markets pro rata.
3. Everything is stored in `data/morpho.db` (SQLite in WAL mode). The metrics are not stored: they are computed on each request from the current rows.
4. A small REST API serves the vault list and the per-vault audit, and keeps the computed results in memory until the next finished sync or a short timeout.
5. Collateral facts do not come from the sync. A background collector in the server downloads public data about each collateral token and stores it in `token_data` (see Token data collector below).
6. The client in `client/` is plain HTML, CSS and JavaScript. It polls the API every 60 seconds.

## Metrics

**MQI (Market Quality Index)** is the share of the verified vault capital that sits in clean markets, from 0 to 100%. A market is clean when all of these hold:

- Morpho lists it.
- Its bad debt and realized bad debt, added together, are under a dust level of $10 or 0.01% of the market's supply, whichever is larger. If the API does not report them, the market is unverified, not debt free.
- It has an oracle address (not empty, `0x` or the zero address). Idle markets (no collateral asset, or LLTV 0) are exempt.
- Morpho has not flagged it `not_whitelisted` and has given it no RED warning other than a liquidity warning. Liquidity warnings are left to the exit metrics. Warnings the API did not report, or that cannot be read, make the market unverified.

A failing market only lowers MQI when it is material: the allocation is at least 1% of TVL or $250K, whichever is smaller, or the failing allocations and the capital the sync could not expand (see Limitations) together reach that amount; in that case any single position above a tenth of that amount counts too (all of them from $1 when the smaller ones add up to that amount on their own). Unallocated cash counts as clean. If the verified capital left is below that amount and the rest is unverified, MQI is not scored.

Missing data does not lower the score. A market is compromised only for a known defect. A market whose bad debt or warnings the API did not return, and capital the sync could not expand (see Limitations), are unverified: they are left out of the MQI denominator and reported separately as `unverifiedPercent`, with the market shown as UNVERIFIED, until the data returns. MQI is `null` when nothing could be verified. A vault that holds assets but has no USD price also gets MQI `null` (unknown), not 100%; the price is taken from the vault's own markets when the API omits it.

**Collateral token facts.** A background collector downloads public data about every collateral token from fixed sources, parses it with plain code and stores one record per token. The collector does not judge: a value it could not find stays `null` and is never read as "fine". The rating is done by a separate engine, `server/engine/tokenRisk.js` (see Token risk rating below). The audit panel shows a compact fact card under each collateral token.

Each record (table `token_data`, the last 20 versions in `token_data_history`) has these groups:

| Group | What it holds |
| --- | --- |
| `identity` | Name, symbol, decimals, total supply, token type, contract name |
| `contract` | Verified on Sourcify and Blockscout, proxy type and implementation (also from the EIP-1967 implementation slot), deployer, creator, creation date, and which kinds of functions the ABI has (mint, burn, pause, blacklist, upgrade, permit and so on, by function name only). `fn.upgrade_via_proxy` is `true` for any proxy, because its admin can replace the code even when the ABI has no upgrade function |
| `control` | Values read from the explorer "Read contract" page (owner, admin, proxyAdmin, authority, accessControl, governor, getCCIPAdmin, pauser, minter and similar) and the EIP-1967 admin slot read over public JSON-RPC (role `proxy_admin`). For each address: its name, whether it is a contract, whether it is a Safe (owners, threshold), `is_multisig`, `is_eoa_delegated` (an EOA with EIP-7702 delegation), `safe_checked` (the Safe service exists on the chain) and, for a timelock, `timelock_delay_sec` |
| `holders` | Holder count, share of the top 1 and top 10 holders, the same shares without Morpho Blue and without contracts named as a pool or protocol (`top1_nonprotocol_pct`, `top10_nonprotocol_pct`), how many of the top 10 are contracts, share held by Morpho Blue, and the GeckoTerminal top-10 share (`null` when it reports more than 100) |
| `price` | USD price, its confidence and time, a 30-day chart, market cap, 24-hour volume, and for an ERC-4626 vault `share_price_assets` (its own totalAssets over totalSupply, in asset units) |
| `liquidity` | DEX pools with their reserve and volume, and a Kyber swap quote for $100K and $1M into USDC: price impact against the requested size (never below 0), output, Kyber's own input value `kyber_in_usd`, gas and dexes. A refused quote is `no_route` or `error` with a short `reason` from Kyber's answer; the chain's USDC itself gets `na` |
| `pendle` | For a Pendle principal token: the active market, implied APY, expiry, and `expired` (from the market or from the PT contract's `expiry` and `isExpired`). `null` for other tokens |
| `rwa` | Data from app.rwa.xyz for tokenised real-world assets. `null` for other tokens |
| `oracle_feeds` | Chainlink data feeds of the token, and whether one of them is a proof-of-reserves feed. A feed named as a pair (`nvPRIME / PRIME`) belongs only to the base of the pair |
| `meta` | Collection time, every source request with its HTTP status and duration, and the coverage |

Sources: Sourcify, Blockscout (one instance per chain), DefiLlama prices, GeckoTerminal, KyberSwap, the Etherscan-family "Read contract" pages (Etherscan, Basescan, Arbiscan), Safe Transaction Service, Pendle, the Chainlink reference data directory, app.rwa.xyz and public JSON-RPC nodes (publicnode.com: EIP-1967 slots and timelock delays on Ethereum, Base, Arbitrum, Optimism, Polygon and Unichain). The collector builds every URL from a template and an address it has checked, and a host outside its allowlist is refused.

`status` is `ok` when the record has a price, at least one source about the token itself (Blockscout or GeckoTerminal) and a coverage of at least 0.4; `partial` when it has a price or at least the identity of the contract; `failed` otherwise. A token on a chain the collector does not support is always `partial`. `coverage` is the share of fields that hold a value, from 0 to 1; `pendle` and `rwa` are left out of the count when they do not apply. Chains with a full set of sources are Ethereum, Base, Arbitrum, Optimism, Polygon and Unichain. Monad, HyperEVM and Katana get a price, pools and, where Kyber supports the chain, a swap quote. Any other chain gets Sourcify only and is marked `chain_supported: false`.

**Token stability ranking.** `server/engine/tokenRisk.js` turns a stored record into a stability score from 0 to 100 (higher is steadier), a grade and a confidence. The rank answers one question: how well does the token hold its price and how easily can it be sold. Who holds its keys is a separate metric (`control_score`) that is shown next to the rank and does not move it. It uses fixed rules only, with no network, no database and no language model, so the same record always gets the same result. Each rule reads named fields of the record and ends in one of four states: `flag` (the fact is present and costs points), `clear` (checked and fine), `unknown` (an input is `null`) or `na` (the rule does not apply, for example a NAV check on a token without a NAV). An unknown rule costs 35% of its maximum (60% for exit liquidity, 50% for price, 20% for holders), so a missing fact never scores as well as a checked one. When the largest own holder or the Morpho Blue share is unknown but the top-10 share is known, the unknown costs a share of the worst band that top-10 share still allows: neither can hold more than the ten largest holders together. The model version is `token-risk-3`. Every flag lists its evidence as `{path, value}` pairs from the record.

The rules are grouped in six pillars; the first four make the stability score and the rank, the last two make `control_score`:

| Pillar | Weight | Rules |
|---|---|---|
| Exit liquidity | 1.0 | Kyber impact for $100K (0 points at 0.3%, 6 at 1%, 16 at 3%, 30 from 10% or with no route) and for $1M (0 at 1%, 12 at 25%, 18 from 60% or with no route), DEX pool reserves (10 points under $100K, 6 at $1M, 2.5 at $10M, 0 from $100M; an aggregator quote through the token's own contract does not make up for thin pools), 24-hour volume (20 points under $1K, 8 at $10K, 2 at $100K, 0 from $1M). A live PT is judged by its Pendle market liquidity alone (24 points under $1M, 12 at $5M, 6 at $20M, 0 from $100M) plus 4 points for trading on one pool; its volume is not judged, because the pool index does not see the Pendle AMM. For a matured PT swap liquidity is ignored, since it redeems 1:1 |
| Price | 1.0 | Price confidence and age, 30-day price range (0.8 points per percent, steeper above 20%, at most 45: a peg at 0.1% costs 0.08, ETH at 16% about 13, a 40% month 44), gap to the NAV (RWA) and to the vault's own share value (ERC-4626, when the asset's price is stored), matured PT (35 points) |
| Holders | 0.6 | Holder count, largest own holder and top-10 share without Morpho Blue and named pools (Aave and Spark aToken proxies, Compound-fork markets, AMM and margin pools, staking wrappers count as pools), share held in Morpho Blue (6 points from 25%, 15 from 50%, 25 from 75%) |
| Scale | 0.6 | Market cap (16 points under $1M, 10 at $10M, 5 at $100M, 2 at $1B, 0 from $10B), contract age |

The dollar and percent thresholds are curves: the points move linearly between the listed knots (on a log scale for dollar amounts), so a token just over an old band edge no longer jumps 10 points.
| Control and code | 0, own score | Blacklist or freeze, pause and mint functions; upgradeable (an upgrade function or any proxy); an EOA or EIP-7702 delegated EOA among the controllers (critical when the token is upgradeable); a Safe with threshold 1 or 2; a timelock delay under 24 h, or no timelock in front of the controllers; a controller contract of unchecked kind |
| Transparency | 0, own score | Verified source, Chainlink feed (Proof of Reserve included) |

The score is 100 minus the sum of each stability pillar's weight times its points, cut to 0..100. Grades: A from 85, B from 70, C from 55, D from 40, E below 40. `confidence` is `high` with a coverage of at least 0.75 and at most 15% unknown rules, `medium` with at least 0.5 and 35%, and `low` otherwise; a medium-confidence score is capped at 84.9 (no A) and a low-confidence one at 69.9 (no A or B). A record with a coverage below 0.4, without a price, from an unsupported chain or from a failed collection gets grade `NR` (not rated) with a `not_rated_reason`. `stability_score` is the score itself and `control_score` (100 minus the control and transparency points) is reported apart, to tell an unstable token from one whose keys are held badly. All thresholds sit in one object at the top of the file.

`rankTokens` sorts the rated tokens by score, then confidence, then the penalty before the cut to 0 (35 dead markets score 0 and still differ in how dead they are), then market cap, then chain and address, and puts the NR tokens after them. Records collected before the current collector are read through their raw values: the swap impact is recomputed from `out_usd`, the PT expiry from the contract values, the own-holder share from the top list. Such a record has only the top 5 holders and the all-holder top-10 share, so its own top-10 is bounded: the top-10 share minus the pools and protocols seen in the list, plus what own holders below the tenth place could add.

On the 336 records of October 2026 the grades are A 26, B 35, C 36, D 30, E 134 and NR 75 (with `token-risk-2`: A 30, B 38, C 42, D 36, E 115). The top starts with USDC, USDT, USDe, USDC on Arbitrum, sUSDe and USDC on Base, followed by WBTC, cbBTC, gold tokens and large staked stablecoins; WETH and wstETH sit around 87. 103 of the 134 E tokens have no working $100K exit (5% or more lost, no route, or no quote) or are matured PTs, 12 trade under $2K a day and 9 moved 22% or more in 30 days.

`node scripts/token-ranking.mjs` prints the top of the ranking from `data/morpho.db` (opened read only; another file with `--db <path>`), or from a JSONL file with `--file <path>` (one `{chainId, address, symbol, status, coverage, data}` per line). It writes the full report to `reports/token-ranking.md`: tokens per grade, the 20 steadiest, the 20 least stable and the not rated tokens with their reasons; the table shows the stability score and the control score side by side.

The Morpho asset tags (`btc`, `eth`, `lst`, `rwa` and so on) are synced into `token_tags` and shown as small labels next to a token. They have no effect on a flag.

The HHI (Herfindahl-Hirschman Index) engine is still in the code and in the audit response for reference, but no longer drives a flag or the summary: it counted each token separately and marked a vault holding only cbBTC as extremely concentrated.

**Instant exit** is the share of the verified capital (TVL minus capital behind unexpanded adapters, reported as `unverifiedPercent`) a depositor could withdraw now: idle cash plus, for each market, the smaller of the vault's supply and the market's free liquidity (supply minus borrow). The result is capped by the vault liquidity that Morpho reports, always applied, for both V1 and V2. If Morpho reports no liquidity figure at all, the vault has no USD price, or none of its capital could be verified, the exit is shown as unknown (`null`, N/A in the client) instead of 100%. Under 20% the vault is marked illiquid.

**Crowded exit** is the same figure when every other vault in the database that lends to the same markets withdraws at once and free liquidity is shared pro rata. Only peer positions above $1K count, and V2 look-through positions are skipped so the same capital is not counted twice. A market is crowded when the peers' supply is at least its free liquidity, the vault's own exit there drops by more than 30% (or the market has no free liquidity), and the vault's position is over 1% of TVL.

**Verdict** combines the above into a one-line summary and red flags:

| Flag | Level |
|---|---|
| Compromised Market Exposure (a material market fails the MQI check) | CRITICAL |
| Restricted Exit Liquidity (instant exit under 20%) | HIGH |
| Critical Crowded Exit Deficit / Elevated Crowded Exit Contagion | CRITICAL / HIGH, depending on how far crowded exit falls below instant exit and how much TVL sits in crowded markets |
| Unresolved Exposure (capital whose underlying markets could not be resolved) | HIGH |
| Unverified Markets (bad debt or warnings data missing; left out of MQI) | MEDIUM |
| Unpriced Vault (assets without a USD price) | HIGH |
| Unknown Exit Liquidity (Morpho reported no liquidity figure) | MEDIUM |
| Negative Net APY | CRITICAL below -5%, otherwise HIGH |

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/status` | Row counts, time of the last full sync, whether a sync is running, last sync result, `stale` (no successful sync for over three sync intervals) and `lastSuccessAt`. |
| GET | `/api/vaults` | Vault list with MQI, and exit metrics per vault. Query: `limit` (default 500, max 1000), `offset`, `chainId`, `listedOnly`, `search` (up to 64 characters), `sortBy` (`liquidity_usd`, `total_assets_usd`, `net_apy`, `apy`, `name`), `sortOrder` (`asc`/`desc`). |
| GET | `/api/vaults/:address` | Full audit for one vault: vault data, verdict and allocations. Each allocation carries the Morpho tags of its collateral token (`collateralTags`); the facts come from `/api/tokens`. |
| GET | `/api/tokens/:chainId/:address` | The collected facts of one collateral token: `status`, `coverage`, `collectedAt`, `stale` (older than two refresh periods), `data` (the groups above) and `risk` (the token risk rating with every flag and its evidence). 404 until the token has been collected. |
| GET | `/api/tokens/ranking` | Every collected token from the safest to the riskiest, NR last: `rank` (the place in the whole ranking, kept under filters), `score`, `grade`, `confidence`, `stability_score`, `control_score`, `market_cap_usd`, `top_flags` (up to 3 stability flags), `control_flags` (up to 2) and `not_rated_reason`. Query: `limit` (default 100, max 500), `offset`, `chainId`, `grade` (`A` to `E` or `NR`, anything else is 400). Recomputed at most once a minute. |
| POST | `/api/sync` | Starts a sync. Needs `Authorization: Bearer <SYNC_TOKEN>`. Returns 202, or waits and returns 200 with `?await=1`. Returns 403 if `SYNC_TOKEN` is not set, 401 for a wrong token, 409 while a sync is running and 413 for a body over 1 KB. |

GET routes also answer HEAD. Unknown `/api/` paths return 404; every other path is served from `client/`. Requests to `/api/` are limited per client IP (300 per minute, set in `server/config.js`) and get 429 above that.

## Running locally

Requirements: Node.js 22.13 or newer (`node:sqlite` needs no flag from that version on). On Windows, `start.bat` and `sync.bat` download a portable Node 22.14 into `.node/` if no suitable Node is installed.

```bash
git clone https://github.com/SeriySpray/CheckYourMorpho.git
cd CheckYourMorpho
npm start        # or start.bat on Windows
```

The server listens on http://localhost:3000 (`start.bat` also opens it in the browser) and fills an empty database with the first sync about 5 seconds after start. To sync once without the server, run `npm run sync` (or `sync.bat`).

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port. |
| `HOST` | `localhost` | Bind address. |
| `SYNC_TOKEN` | not set | Enables `POST /api/sync`. When it is not set, manual sync is disabled. |
| `TOKEN_DATA_DISABLED` | not set | Set to `1` to turn off the background token collector. |

The sync interval, database path and Morpho API URL are fixed in `server/config.js`.

## Token data collector

The server collects the token facts itself, in the background. One tick runs every 10 minutes, 60 seconds after start-up for the first time, and collects tokens one after another for at most 8 minutes. The queue takes every collateral token in the `markets` table: tokens never collected first, biggest vault capital first, then the oldest. A good record is collected again after a day, a `partial` or `failed` one after an hour.

Requests to one host run in order with a pause (6 s for GeckoTerminal, 1.5 s for Safe, 1 s for Kyber, 0.3 s for the rest), a request times out after 30 seconds, a body is cut at 1 MB (6 MB for the Chainlink catalog, which is cached for 6 hours), and a 429 or a 502/503/504 answer is retried once. A token takes about 20 to 25 seconds, so a tick handles roughly 20 tokens.

Set `TOKEN_DATA_DISABLED=1` to turn the collector off, for example on a machine that must not call these sources. The code is in `server/services/tokenCollector.js` (fetching, storage, queue, loop) and `server/services/tokenParsers.js` (pure parsers, covered by tests on saved real responses in `tests/data/collector/`).

## Tests

```bash
npm test             # all cases, prints a summary, exits 1 on failure
npm run tests:tui    # interactive terminal runner
npm run tests        # browser runner at http://127.0.0.1:4173
```

The tests need neither network nor a synced database. The Morpho API is mocked, and the runner works on a temporary copy of `data/morpho.db` (an empty one if the file does not exist). GitHub Actions runs `npm test` on Node 22 for every push and pull request to `main`.

## Deployment

The public instance runs on an Oracle Cloud VM as a systemd service behind nginx, which proxies to `127.0.0.1:3000` and serves HTTPS. The deploy scripts and nginx config are not in the repository. `.github/workflows/deploy-pages.yml` publishes `docs/time_audit.html` to GitHub Pages.

## Limitations

- The analysis is per vault and from the lender's side. There are no user positions, health factors or borrower views.
- Crowded exit only knows about listed vaults in the database. Direct lenders and unlisted vaults in the same market are not counted as competitors.
- V2 adapters other than MetaMorpho, and MetaMorpho adapters whose underlying vault is not in the sync, are not expanded. The same holds for V1 positions the API returns without a market, a V1 vault whose allocation is missing, and MorphoMarketV1 assets that the market caps cover by less than 99.5% (a smaller gap is taken as accrued interest and counted as cash; the live API shows no gap at all). Such capital is not counted as cash: it is flagged as Unresolved Exposure, left out of the MQI score (shown as unverified once material), left out of the collateral shares and of the exit figure (both are measured on the verified capital).
- The collector reads public sources, which can be wrong, outdated (a day between collections), incomplete or unavailable; a field it could not fill is `null`, never evidence either way. Pages rendered by JavaScript may come back empty. Only the chains listed above get more than Sourcify data.
- The token rating judges only what the record holds. A vault share does not inherit the risk of its asset. A token without DEX liquidity of its own (an RWA redeemed with the issuer, a vault share) is rated as hard to exit. A `ProxyAdmin` contract is not followed to its owner, and a protocol contract without a telling name counts as one holder.
- Only the current state is kept. There is no history, no charts over time and no alerts.

# CheckYourMorpho

[![Live](https://img.shields.io/badge/Live-checkyourmorpho.duckdns.org-2470FF?style=flat-square&logo=googlechrome&logoColor=white)](https://checkyourmorpho.duckdns.org)
[![Node.js](https://img.shields.io/badge/Node.js-22.13%2B-161B22?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Tests](https://github.com/SeriySpray/CheckYourMorpho/actions/workflows/tests.yml/badge.svg)](https://github.com/SeriySpray/CheckYourMorpho/actions/workflows/tests.yml)

CheckYourMorpho is a risk dashboard for Morpho vaults (MetaMorpho V1 and Morpho Vaults V2). It looks at a vault from the depositor's side: where the capital is lent, how concentrated the collateral behind it is, and how much of it can be withdrawn right now. The server has no npm dependencies; it uses Node's built-in `node:http` and `node:sqlite`.

## What it does

- Lists every vault that Morpho marks as listed, on all chains the Morpho API returns, with search by name, symbol, curator or address and filters by network, asset and curator.
- Sorts vaults by TVL, APY, liquidity, MQI or low-risk share of collateral.
- Opens an audit panel for a vault: its allocations by market, MQI, collateral facts collected about each token, instant exit capacity, and a list of red flags.
- Lets you pin vaults in the browser (stored in `localStorage`).
- Shows the vaults as a WebGL 2 particle sphere next to the list. Phones get the list only.
- Sends alerts about starred vaults to a Telegram bot, and shows the same events in an activity panel (see Alerts below).

## How it works

1. Data comes from the public Morpho GraphQL API (`https://api.morpho.org/graphql`): listed V1 vaults with their allocations, listed V2 vaults with their market caps and adapters, and the curator directory.
2. The server syncs 5 seconds after start-up and then every 180 seconds. A sync writes vaults, markets and allocations in one SQLite transaction. Unlisted vaults are deleted, and a vault that is missing from 3 syncs in a row is deleted too. A V2 vault that holds a V1 vault through a MetaMorpho adapter is expanded into that V1 vault's markets pro rata.
3. Everything is stored in `data/morpho.db` (SQLite in WAL mode). The metrics are not stored: they are computed on each request from the current rows.
4. A small REST API serves the vault list and the per-vault audit, and keeps the computed results in memory until the next finished sync or a short timeout.
5. Each sync also compares every vault with its previous state and writes events (pending cap, market and guardian changes, bad debt, TVL outflow) to `vault_events`, and stores an hourly sample of the vault (TVL, verdict, MQI, Net APY, fee) in `vault_samples` for the daily digest (see Alerts below).
6. Collateral facts do not come from the sync. A background collector in the server downloads public data about each collateral token and stores it in `token_data` (see Token data collector below).
7. The client in `client/` is plain HTML, CSS and JavaScript. It polls the API every 60 seconds.

## Metrics

**MQI (Market Quality Index)** is the share of the verified vault capital that sits in clean markets, from 0 to 100%. It is a plain proportion: every position counts at its exact size and there is no materiality cut-off. A market is clean when all of these hold:

- Morpho lists it.
- Its bad debt and realized bad debt, added together, are under a dust level of $10 or 0.01% of the market's supply, whichever is larger. If the API does not report them, the market is unverified, not debt free.
- It has an oracle address (not empty, `0x` or the zero address). Idle markets (no collateral asset, or LLTV 0) are exempt.
- Morpho has not flagged it `not_whitelisted` and has given it no RED warning other than a liquidity warning. Liquidity warnings are left to the exit metrics. Warnings the API did not report, or that cannot be read, make the market unverified.

A failing market lowers MQI by its exact share of the verified capital. A known defect never rounds up to 100: with any compromised capital MQI is at most 99.9, so 100 means there is none. A position under one cent is treated as rounding residue and ignored. Unallocated cash counts as clean, unless a position of unreadable size (missing, not a number or negative) could be hiding in it: then the remainder is unverified, not cash.

Missing data does not lower the score. A market is compromised only for a known defect. A market whose bad debt or warnings the API did not return, and capital the sync could not expand (see Limitations), are unverified: they are left out of the MQI denominator and reported separately as `unverifiedPercent`, with the market shown as UNVERIFIED, until the data returns. MQI is `null` when nothing could be verified, and also when the verified capital is smaller than the unverified capital, because a score built on a sliver of the vault says nothing about it. A vault that holds assets but has no USD price also gets MQI `null` (unknown), not 100%; the price is taken from the vault's own markets when the API omits it.

**Collateral token facts.** A background collector downloads public data about every collateral token from fixed sources, parses it with plain code and stores one record per token. The collector does not judge: a value it could not find stays `null` and is never read as "fine". The audit panel shows a compact fact card under each collateral token.

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

The Morpho asset tags (`btc`, `eth`, `lst`, `rwa` and so on) are synced into `token_tags` and shown as small labels next to a token. They have no effect on a flag.

The HHI (Herfindahl-Hirschman Index) engine is still in the code and in the audit response for reference, but no longer drives a flag or the summary: it counted each token separately and marked a vault holding only cbBTC as extremely concentrated.

**Instant exit** is the share of the verified capital (TVL minus capital behind unexpanded adapters, reported as `unverifiedPercent`) a depositor could withdraw now: idle cash plus, for each market, the smaller of the vault's supply and the market's free liquidity (supply minus borrow). The result is capped by the vault liquidity that Morpho reports, always applied, for both V1 and V2. If Morpho reports no liquidity figure at all, the vault has no USD price, or none of its capital could be verified, the exit is shown as unknown (`null`, N/A in the client) instead of 100%. Under 20% the vault is marked illiquid.

**Verdict** combines the above into a one-line summary and red flags. MQI counts every dollar, but a flag needs the capital behind it to be material: 1% of TVL, at most $250K. That threshold applies to Compromised Market Exposure, Unresolved Exposure, Unverified Markets and to alerts. It does not change MQI, so a vault with $145 in a failing market shows MQI 99.9 and no red flag.

| Flag | Level |
|---|---|
| Compromised Market Exposure (failing markets hold a material amount) | CRITICAL |
| Restricted Exit Liquidity (instant exit under 20% and under $10M) | HIGH |
| Unresolved Exposure (a material amount whose underlying markets could not be resolved) | HIGH |
| Unverified Markets (a material amount with bad debt or warnings data missing; left out of MQI) | MEDIUM |
| Unpriced Vault (assets without a USD price) | HIGH |
| Unknown Exit Liquidity (Morpho reported no liquidity figure) | MEDIUM |
| Negative Net APY | CRITICAL below -5%, otherwise HIGH |

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/status` | Row counts, time of the last full sync, whether a sync is running, last sync result, `stale` (no successful sync for over three sync intervals) and `lastSuccessAt`. |
| GET | `/api/vaults` | Vault list with MQI, and exit metrics per vault. Query: `limit` (default 500, max 1000), `offset`, `chainId`, `listedOnly`, `search` (up to 64 characters), `sortBy` (`liquidity_usd`, `total_assets_usd`, `net_apy`, `apy`, `name`), `sortOrder` (`asc`/`desc`). |
| GET | `/api/vaults/:address` | Full audit for one vault: vault data, verdict and allocations. Each allocation carries the Morpho tags of its collateral token (`collateralTags`); the facts come from `/api/tokens`. |
| GET | `/api/tokens/:chainId/:address` | The collected facts of one collateral token: `status`, `coverage`, `collectedAt`, `stale` (older than two refresh periods), `data` (the groups above). 404 until the token has been collected. |
| GET | `/api/events` | Event log, newest first. Query: `address` or `addresses` (comma separated), `kinds`, `severity`, `status`, `since` (unix seconds), `before`, `limit` (default 50, max 200). |
| GET | `/api/events/pending` | Pending timelock changes that have not taken effect yet, including those whose timelock already elapsed and can be executed now (up to 200, oldest `valid_at` first), same filters. |
| GET | `/api/tg/config` | Whether the Telegram bot is running and its username. |
| PUT | `/api/tg/subscription` | Stores the starred vaults (up to 100 addresses) of a browser-generated `sub_id`. Body: `{ "sub_id": "...", "vaults": ["0x..."] }`. |
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
| `TELEGRAM_BOT_TOKEN` | not set | Token of a bot made in BotFather. Without it the bot and the alerts are off. |
| `SITE_URL` | `https://checkyourmorpho.duckdns.org` | Address the bot links to when it sends someone to the site. |

The sync interval, database path and Morpho API URL are fixed in `server/config.js`.

## Token data collector

The server collects the token facts itself, in the background. One tick runs every 10 minutes, 60 seconds after start-up for the first time, and collects tokens one after another for at most 8 minutes. The queue takes every collateral token in the `markets` table: tokens never collected first, biggest vault capital first, then the oldest. A good record is collected again after a day, a `partial` or `failed` one after an hour.

Requests to one host run in order with a pause (6 s for GeckoTerminal, 1.5 s for Safe, 1 s for Kyber, 0.3 s for the rest), a request times out after 30 seconds, a body is cut at 1 MB (6 MB for the Chainlink catalog, which is cached for 6 hours), and a 429 or a 502/503/504 answer is retried once. A token takes about 20 to 25 seconds, so a tick handles roughly 20 tokens.

Set `TOKEN_DATA_DISABLED=1` to turn the collector off, for example on a machine that must not call these sources. The code is in `server/services/tokenCollector.js` (fetching, storage, queue, loop) and `server/services/tokenParsers.js` (pure parsers, covered by tests on saved real responses in `tests/data/collector/`).

## Alerts

Alerts are for depositors. They are addressed to the vaults a user stars on the site, not to wallet addresses, and there are no borrower positions or health factors.

Setup: create a bot in BotFather and start the server with `TELEGRAM_BOT_TOKEN`. The site generates a random `sub_id` in the browser and sends the starred vaults with `PUT /api/tg/subscription`. The user opens the bot through the link with that code (`/start <sub_id>`) and the chat is bound to the browser's favorites; the list follows later stars and unstars by itself. A chat that starts the bot without the site gets its own code and a link to the site. The bot answers `/status`, `/list`, `/upcoming`, `/help`, `/pause`, `/resume` and `/stop`. `/pause` only silences the chat; `/stop` unsubscribes it completely: the subscription and the pinned message are removed, and the chat reconnects through the site's Telegram button (a plain `/start` makes a separate list the site does not know about). Every message has the same shape (bold title, short paragraphs, vault name with chain and short address). The bot also keeps one pinned message per chat, Upcoming changes: the pending timelock changes of the followed vaults grouped by vault, split into those that can be applied now and those still waiting. It is edited in place when the set of changes moves (checked every minute, no API call when nothing changed), sent and pinned again if the user deletes it, and refreshed by `/upcoming`. Times are Kyiv time.

Sent immediately:

- a cap increase that adds 5% or more of the vault's assets, or opens a new cap;
- a market added or removed;
- a guardian change or a shorter timelock;
- bad debt appearing in a market. If the market had no bad debt data at the previous sync, the alert still goes out once, marked as first seen after a gap in data;
- a sharp TVL outflow (15% or more in 24 hours and at least $500K).

Sent in the daily digest at 09:00 Kyiv time: verdict and MQI changes, a Net APY drop against the vault's 7-day average, fee changes, delisting and a summary of reallocations. Instant control changes, a RED verdict on its own, low exit capacity and single reallocations are not sent.

Events are kept for 180 days (pending ones until they take effect) and vault samples for 8 days. The activity panel in the client (bell button) shows the same event log for the starred vaults.

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
- V2 adapters other than MetaMorpho, and MetaMorpho adapters whose underlying vault is not in the sync, are not expanded. The same holds for V1 positions the API returns without a market, a V1 vault whose allocation is missing or empty, and MorphoMarketV1 assets that the market caps cover by less than 99.5% (a smaller gap is taken as accrued interest and counted as cash; the live API shows no gap at all). Such capital is not counted as cash: it is flagged as Unresolved Exposure, left out of the MQI score (shown as unverified), left out of the collateral shares and of the exit figure (both are measured on the verified capital).
- The collector reads public sources, which can be wrong, outdated (a day between collections), incomplete or unavailable; a field it could not fill is `null`, never evidence either way. Pages rendered by JavaScript may come back empty. Only the chains listed above get more than Sourcify data.
- Only the current state is kept, plus the event log and a few days of vault samples that the alerts use. There are no charts over time.

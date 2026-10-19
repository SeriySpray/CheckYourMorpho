# CheckYourMorpho

[![Live](https://img.shields.io/badge/Live-checkyourmorpho.duckdns.org-2470FF?style=flat-square&logo=googlechrome&logoColor=white)](https://checkyourmorpho.duckdns.org)
[![Node.js](https://img.shields.io/badge/Node.js-22.13%2B-161B22?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Tests](https://github.com/SeriySpray/CheckYourMorpho/actions/workflows/tests.yml/badge.svg)](https://github.com/SeriySpray/CheckYourMorpho/actions/workflows/tests.yml)

CheckYourMorpho is a risk dashboard for Morpho vaults (MetaMorpho V1 and Morpho Vaults V2). It looks at a vault from the depositor's side: where the capital is lent, how concentrated the collateral behind it is, and how much of it can be withdrawn right now. The server has no npm dependencies; it uses Node's built-in `node:http` and `node:sqlite`.

## What it does

- Lists every vault that Morpho marks as listed, on all chains the Morpho API returns, with search by name, symbol, curator or address and filters by network, asset and curator.
- Sorts vaults by TVL, APY, liquidity, MQI or HHI.
- Opens an audit panel for a vault: its allocations by market, MQI, collateral concentration, instant and crowded exit capacity, and a list of red flags.
- Lets you pin vaults in the browser (stored in `localStorage`).
- Shows the vaults as a WebGL 2 particle sphere.

## How it works

1. Data comes from the public Morpho GraphQL API (`https://api.morpho.org/graphql`): listed V1 vaults with their allocations, listed V2 vaults with their market caps and adapters, and the curator directory.
2. The server syncs 5 seconds after start-up and then every 180 seconds. A sync writes vaults, markets and allocations in one SQLite transaction. Unlisted vaults are deleted, and a vault that is missing from 3 syncs in a row is deleted too. A V2 vault that holds a V1 vault through a MetaMorpho adapter is expanded into that V1 vault's markets pro rata.
3. Everything is stored in `data/morpho.db` (SQLite in WAL mode). The metrics are not stored: they are computed on each request from the current rows.
4. A small REST API serves the vault list and the per-vault audit, and keeps the computed results in memory until the next finished sync or a short timeout.
5. The client in `client/` is plain HTML, CSS and JavaScript. It polls the API every 60 seconds.

## Metrics

**MQI (Market Quality Index)** is the share of the verified vault capital that sits in clean markets, from 0 to 100%. A market is clean when all of these hold:

- Morpho lists it.
- Its bad debt and realized bad debt, added together, are under a dust level of $10 or 0.01% of the market's supply, whichever is larger. If the API does not report them, the market is unverified, not debt free.
- It has an oracle address (not empty, `0x` or the zero address). Idle markets (no collateral asset, or LLTV 0) are exempt.
- Morpho has not flagged it `not_whitelisted` and has given it no RED warning other than a liquidity warning. Liquidity warnings are left to the exit metrics. Warnings the API did not report, or that cannot be read, make the market unverified.

A failing market only lowers MQI when it is material: the allocation is at least 1% of TVL or $250K, whichever is smaller, or the failing allocations and the capital the sync could not expand (see Limitations) together reach that amount; in that case any single position above a tenth of that amount counts too. Unallocated cash counts as clean.

Missing data does not lower the score. A market is compromised only for a known defect. A market whose bad debt or warnings the API did not return, and capital the sync could not expand (see Limitations), are unverified: they are left out of the MQI denominator and reported separately as `unverifiedPercent`, with the market shown as UNVERIFIED, until the data returns. MQI is `null` when nothing could be verified. A vault that holds assets but has no USD price also gets MQI `null` (unknown), not 100%; the price is taken from the vault's own markets when the API omits it.

**HHI (Herfindahl-Hirschman Index)** measures how concentrated the collateral behind the vault's loans is. It groups active allocations by collateral asset and ignores idle markets (no collateral asset, or LLTV 0). The response also gives the number of effective assets and the top collateral with its share of TVL. A tier needs both the HHI level and a minimum share of TVL in the top collateral:

| Tier | HHI | Top collateral share of TVL |
|---|---|---|
| EXTREME | above 0.50 | 40% or more |
| CONCENTRATED | 0.25 or more | 20% or more |
| MODERATE | 0.15 or more | 10% or more |
| DIVERSIFIED | anything else | |

A vault with less than 30% of TVL in active collateral is DIVERSIFIED regardless of HHI. A vault with less than 1% is UNALLOCATED and gets no HHI.

**Instant exit** is the share of TVL a depositor could withdraw now: idle cash plus, for each market, the smaller of the vault's supply and the market's free liquidity (supply minus borrow). The result is capped by the vault liquidity that Morpho reports, always applied, for both V1 and V2. If Morpho reports no liquidity figure at all, or the vault has no USD price, the exit is shown as unknown (`null`, N/A in the client) instead of 100%. Under 20% the vault is marked illiquid.

**Crowded exit** is the same figure when every other vault in the database that lends to the same markets withdraws at once and free liquidity is shared pro rata. Only peer positions above $1K count, and V2 look-through positions are skipped so the same capital is not counted twice. A market is crowded when the peers' supply is at least its free liquidity, the vault's own exit there drops by more than 30% (or the market has no free liquidity), and the vault's position is over 1% of TVL.

**Verdict** combines the above into a one-line summary and red flags:

| Flag | Level |
|---|---|
| Compromised Market Exposure (a material market fails the MQI check) | CRITICAL |
| Extreme Collateral Concentration (tier EXTREME) | HIGH |
| Elevated Collateral Concentration (tier CONCENTRATED) | MEDIUM |
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
| GET | `/api/vaults` | Vault list with MQI, HHI and exit metrics per vault. Query: `limit` (default 500, max 1000), `offset`, `chainId`, `listedOnly`, `search` (up to 64 characters), `sortBy` (`liquidity_usd`, `total_assets_usd`, `net_apy`, `apy`, `name`), `sortOrder` (`asc`/`desc`). |
| GET | `/api/vaults/:address` | Full audit for one vault: vault data, verdict and allocations. |
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

The sync interval, database path and Morpho API URL are fixed in `server/config.js`.

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
- V2 adapters other than MetaMorpho, and MetaMorpho adapters whose underlying vault is not in the sync, are not expanded. The same holds for V1 positions the API returns without a market, a V1 vault whose allocation is missing, and MorphoMarketV1 assets that the market caps cover by less than 99.5% (a smaller gap is taken as accrued interest and counted as cash; the live API shows no gap at all). Such capital is not counted as cash: it is flagged as Unresolved Exposure, left out of the MQI score (shown as unverified once material), left out of HHI, and counted as not withdrawable in the exit figure.
- Only the current state is kept. There is no history, no charts over time and no alerts.

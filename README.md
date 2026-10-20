# CheckYourMorpho

[![Live](https://img.shields.io/badge/Live-checkyourmorpho.duckdns.org-2470FF?style=flat-square&logo=googlechrome&logoColor=white)](https://checkyourmorpho.duckdns.org)
[![Node.js](https://img.shields.io/badge/Node.js-22.13%2B-161B22?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Tests](https://github.com/SeriySpray/CheckYourMorpho/actions/workflows/tests.yml/badge.svg)](https://github.com/SeriySpray/CheckYourMorpho/actions/workflows/tests.yml)

CheckYourMorpho is a risk dashboard for Morpho vaults (MetaMorpho V1 and Morpho Vaults V2). It looks at a vault from the depositor's side: where the capital is lent, how concentrated the collateral behind it is, and how much of it can be withdrawn right now. The server has no npm dependencies; it uses Node's built-in `node:http` and `node:sqlite`.

## What it does

- Lists every vault that Morpho marks as listed, on all chains the Morpho API returns, with search by name, symbol, curator or address and filters by network, asset and curator.
- Sorts vaults by TVL, APY, liquidity, MQI or low-risk share of collateral.
- Opens an audit panel for a vault: its allocations by market, MQI, collateral tiers from AI research, instant and crowded exit capacity, and a list of red flags.
- Lets you pin vaults in the browser (stored in `localStorage`).
- Shows the vaults as a WebGL 2 particle sphere.

## How it works

1. Data comes from the public Morpho GraphQL API (`https://api.morpho.org/graphql`): listed V1 vaults with their allocations, listed V2 vaults with their market caps and adapters, and the curator directory.
2. The server syncs 5 seconds after start-up and then every 180 seconds. A sync writes vaults, markets and allocations in one SQLite transaction. Unlisted vaults are deleted, and a vault that is missing from 3 syncs in a row is deleted too. A V2 vault that holds a V1 vault through a MetaMorpho adapter is expanded into that V1 vault's markets pro rata.
3. Everything is stored in `data/morpho.db` (SQLite in WAL mode). The metrics are not stored: they are computed on each request from the current rows.
4. A small REST API serves the vault list and the per-vault audit, and keeps the computed results in memory until the next finished sync or a short timeout.
5. Collateral risk tiers do not come from the sync. An AI research agent runs on the owner's PC and posts one result per token to the server (see AI research runner below); the server validates and stores it.
6. The client in `client/` is plain HTML, CSS and JavaScript. It polls the API every 60 seconds.

## Metrics

**MQI (Market Quality Index)** is the share of the verified vault capital that sits in clean markets, from 0 to 100%. A market is clean when all of these hold:

- Morpho lists it.
- Its bad debt and realized bad debt, added together, are under a dust level of $10 or 0.01% of the market's supply, whichever is larger. If the API does not report them, the market is unverified, not debt free.
- It has an oracle address (not empty, `0x` or the zero address). Idle markets (no collateral asset, or LLTV 0) are exempt.
- Morpho has not flagged it `not_whitelisted` and has given it no RED warning other than a liquidity warning. Liquidity warnings are left to the exit metrics. Warnings the API did not report, or that cannot be read, make the market unverified.

A failing market only lowers MQI when it is material: the allocation is at least 1% of TVL or $250K, whichever is smaller, or the failing allocations and the capital the sync could not expand (see Limitations) together reach that amount; in that case any single position above a tenth of that amount counts too (all of them from $1 when the smaller ones add up to that amount on their own). Unallocated cash counts as clean. If the verified capital left is below that amount and the rest is unverified, MQI is not scored.

Missing data does not lower the score. A market is compromised only for a known defect. A market whose bad debt or warnings the API did not return, and capital the sync could not expand (see Limitations), are unverified: they are left out of the MQI denominator and reported separately as `unverifiedPercent`, with the market shown as UNVERIFIED, until the data returns. MQI is `null` when nothing could be verified. A vault that holds assets but has no USD price also gets MQI `null` (unknown), not 100%; the price is taken from the vault's own markets when the API omits it.

**Collateral (AI research).** Each collateral token gets a risk tier from 1 to 5 from an AI research agent that reads public sources (issuer documentation, audit reports, block explorers, DefiLlama, post-mortems) and cites them. The tier is a judgement of the model, not a measured value and not an official rating. The agent is told that missing information is never evidence of safety.

| Tier | Meaning |
| --- | --- |
| 1 | Value depends only on long-running (over 2 years), multiply audited contracts or a base chain asset; no admin power to mint or freeze without a timelock; no unresolved incident; deep liquidity. |
| 2 | One additional well-documented dependency with over 1 year of history, audits and no unresolved incident. |
| 3 | Several stacked dependencies, or under 1 year of history, or gated or delayed redemption, or admin powers without a timelock. |
| 4 | Value hard to verify or fragile: off-chain claims with limited transparency, a peg kept by market mechanisms only, thin liquidity, an unresolved past depeg or exploit, or a party that can freeze or mint without delay. |
| 5 | Currently impaired: active depeg or exploit, redemption halted, issuer insolvency or enforcement action. |

The code checks the evidence, not the judgement. A result is accepted only if it follows `server/data/researchSchema.json`, every fact and the tier cite sources that exist, the address and chain are the ones asked for, an unknown backing or redemption leaves the tier at 4, 5 or empty, tier 1 and 2 are not given with low confidence, tier 5 comes with an unresolved incident, and at least one source of the tier was opened (HTTP 200) and names the token. Source URLs must be public https pages; search redirects are resolved to the real page. This lowers the chance of invented sources but does not remove it, and pages rendered by JavaScript can fail the check although the claim is right. Every received result, accepted or not, is kept in `token_research_history` (the last 20 per token).

A tier that is two or more levels better than the current one, or better with lower confidence, is held back until the next run confirms it (within one level); a worse tier is accepted at once. A token without a record, with a record older than 60 days, or with no tier is **unrated** and counted as such, never as safe. Idle markets (no collateral asset, or LLTV 0) are not collateral and are shown separately. Shares are measured against the verified capital: capital behind adapters that could not be expanded is left out of the base and reported as `unverifiedPercent`.

The vault shows the share of capital in tier 1 and 2 (low risk), tier 3 and 4, tier 5 (impaired) and unrated, a per-token breakdown, and next to each token in the market table its tier, category, model date and source links. One flag follows from it: MEDIUM "AI research: impaired collateral" when tier 5 collateral with a confidence above low reaches the materiality amount (1% of TVL or $250K, whichever is smaller). A change of a material token from one tier to another creates a `collateral_tier_changed` event (warning when the new tier is 4 or 5); the first rating of a token creates none. The interface states: "Ratings are judgements by an AI research agent (model, date) from public sources. They may be wrong or outdated and are not financial advice or an official rating."

The Morpho asset tags (`btc`, `eth`, `lst`, `rwa` and so on) are still synced into `token_tags`. They appear as small labels next to a token and as a hint in the research prompt (which says they may be wrong); they have no effect on a tier or a flag.

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
| AI research: impaired collateral (tier 5, confidence above low, material share) | MEDIUM |
| Unpriced Vault (assets without a USD price) | HIGH |
| Unknown Exit Liquidity (Morpho reported no liquidity figure) | MEDIUM |
| Negative Net APY | CRITICAL below -5%, otherwise HIGH |

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/status` | Row counts, time of the last full sync, whether a sync is running, last sync result, `stale` (no successful sync for over three sync intervals) and `lastSuccessAt`. |
| GET | `/api/vaults` | Vault list with MQI, collateral tier shares (`lowRiskCollateralPercent`, `highRiskCollateralPercent`, `impairedCollateralPercent`, `unratedCollateralPercent`) and exit metrics per vault. Query: `limit` (default 500, max 1000), `offset`, `chainId`, `listedOnly`, `search` (up to 64 characters), `sortBy` (`liquidity_usd`, `total_assets_usd`, `net_apy`, `apy`, `name`), `sortOrder` (`asc`/`desc`). |
| GET | `/api/vaults/:address` | Full audit for one vault: vault data, verdict and allocations; each allocation carries `collateralResearch` (tier, category, confidence, model, date, rationale, https sources, `stale`) or `null`. |
| GET | `/api/research/queue` | Tokens that need research, most urgent first (`limit`, default 40, max 200). Needs `Authorization: Bearer <RESEARCH_TOKEN>`; 403 if `RESEARCH_TOKEN` is not set, 401 for a wrong token. |
| POST | `/api/research` | Imports the result for one token: `{runId, model, promptVersion, chainId, address, raw, checks}`. Same token as above. Answers 200 with `{outcome, errors}` (`accepted`, `rejected`, `kept_previous` or `pending_confirmation`), 400 for a malformed body and 413 for a body over 256 KB. |
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
| `RESEARCH_TOKEN` | not set | Enables `GET /api/research/queue` and `POST /api/research`. When it is not set, both answer 403. |

The sync interval, database path and Morpho API URL are fixed in `server/config.js`.

## AI research runner

The research runs on the owner's PC, not on the server (the Oracle VM has under 1 GB of RAM). The runner takes the work queue from the server, researches the tokens with the `agy` CLI (one at a time by default) (Antigravity, model `gemini-3.8-flash-high`) and posts each result back. The server only validates and stores it.

1. Set `RESEARCH_TOKEN` in the server environment. Without it both research endpoints answer 403.
2. Put the same token in `%USERPROFILE%\.checkyourmorpho\research_token` (or point `RESEARCH_TOKEN_FILE` at another file). The runner never writes the token to the log and never passes it to `agy`.
3. Install `agy` (its folder `%LOCALAPPDATA%\agy\bin` is added to `PATH` by the runner) and sign in once.
4. Run it:

```bash
node scripts/research.mjs --api https://checkyourmorpho.duckdns.org --limit 40
```

Options: `--tokens 1:0x...,8453:0x...` researches the listed tokens instead of the queue, `--dry-run` only prints the queue, `--max-minutes 240` stops starting new tokens after that time, `--out dir` sets where raw agent output is saved (default `logs/research/<run id>/`), `--model` overrides the model, `--concurrency N` (1 to 3, default 1) runs that many `agy` calls in parallel, `--min-free-mb 1400` sets the free memory needed to start a call. `research.bat` runs the same command and appends to `logs\research.log`.

Every call is `agy -p <prompt> --output-format json --json-schema server/data/researchSchema.json --model <model> --dangerously-skip-permissions --sandbox --print-timeout 600s`, started in an empty work folder (`%LOCALAPPDATA%\cym-research\work`) with a minimal environment (no secrets). The sandbox is required because the agent sometimes tries to run commands. The prompt allows only web search and page reading, at most about 10 tool calls, and tells the agent to treat page content as data. A call is stopped after 12 minutes. A failed or invalid attempt is repeated once; the last result is posted even when invalid, so the server records it and puts a token that keeps failing on hold for 21 days. The run stops at once on a quota, credits or expired-login message. There is a 5 second pause between tokens.

Before it starts the runner refuses to run with under 1400 MB of free memory (exit code 2, `--min-free-mb` changes the limit). One `agy` process takes about 600 to 750 MB, so check your free RAM before raising `--concurrency`. With several workers the same free memory check is repeated before every `agy` call, not only at the start: when it is too low the worker waits and checks again every 60 seconds, and after 10 minutes the token is skipped (it stays in the queue) and logged. Workers take tokens from one shared list, so a token is never researched twice, the first calls of the workers are 30 seconds apart, `--max-minutes` covers the whole pool, and a quota, credits or expired-login message stops all workers. Every log line starts with the worker number, for example `[w2]`.

The lock file `%LOCALAPPDATA%\cym-research\work\.lock` holds the PID and the start time of the run (exit code 3 when another run holds it). A lock is stale and removed at start when its process no longer exists or it is older than 8 hours, so a killed run does not block the next one. A lock of a live process is respected. With MCP servers enabled the agent opened a browser and used a lot of memory, so the runner disables `playwright`, `context7` and `pencil` through `agy mcp disable` when `agy mcp list` shows them as enabled, and logs it. This changes your `agy` settings; enable them again if you need them elsewhere.

The server listens on IPv6 as well, so for a local API use `--api http://localhost:PORT` and not `http://127.0.0.1:PORT`. `GET /api/research/queue` returns at most 200 tokens per request, which is the upper limit of `--limit`.

Every token in the `markets` table is queued, also those without vault capital: tokens with no record first, then by vault capital, then the oldest. A record is queued again after 7 days. One token takes 2 to 4 minutes and 100 to 250 thousand model tokens, so the first full pass takes several days at 40 tokens a day.

Weekly run with Windows Task Scheduler (PowerShell; adjust the folder):

```powershell
$dir = "C:\path\to\CheckYourMorpho"
$action = New-ScheduledTaskAction -Execute "$dir\research.bat" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 3am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 5)
Register-ScheduledTask -TaskName "CheckYourMorpho research" -Action $action -Trigger $trigger -Settings $settings
```

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
- Collateral tiers are model judgements from public sources. They can be wrong, outdated (up to 7 days between runs, 60 days before a record counts as unrated) or missing, and a much better tier is applied only after a second run confirms it. A token the agent cannot identify stays unrated.
- Only the current state is kept. There is no history, no charts over time and no alerts.

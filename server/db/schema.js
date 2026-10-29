export const SCHEMA_SQL = `
-- Enforce WAL mode and foreign keys
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- Vaults table
CREATE TABLE IF NOT EXISTS vaults (
  address TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  name TEXT,
  symbol TEXT,
  curator_name TEXT,
  asset_address TEXT,
  asset_symbol TEXT,
  asset_decimals INTEGER,
  asset_price_usd REAL,
  total_assets TEXT,
  total_assets_usd REAL,
  apy REAL,
  net_apy REAL,
  fee REAL,
  management_fee REAL DEFAULT 0,
  description TEXT DEFAULT '',
  liquidity_market_key TEXT DEFAULT '',
  owner TEXT,
  pending_owner TEXT,
  version TEXT DEFAULT 'v1',
  liquidity_usd REAL DEFAULT 0,
  is_listed INTEGER DEFAULT 0,
  metadata_updated_at INTEGER,
  missed_syncs INTEGER DEFAULT 0,
  unresolved_exposure_usd REAL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_vaults_version ON vaults(version);
CREATE INDEX IF NOT EXISTS idx_vaults_chain ON vaults(chain_id);
CREATE INDEX IF NOT EXISTS idx_vaults_curator ON vaults(curator_name);
CREATE INDEX IF NOT EXISTS idx_vaults_is_listed ON vaults(is_listed);
CREATE INDEX IF NOT EXISTS idx_vaults_total_assets ON vaults(total_assets_usd DESC);
CREATE INDEX IF NOT EXISTS idx_vaults_liquidity ON vaults(liquidity_usd DESC);
CREATE INDEX IF NOT EXISTS idx_vaults_listed_liq ON vaults(is_listed, liquidity_usd DESC);
CREATE INDEX IF NOT EXISTS idx_vaults_listed_assets ON vaults(is_listed, total_assets_usd DESC);
CREATE INDEX IF NOT EXISTS idx_vaults_listed_net_apy ON vaults(is_listed, net_apy DESC);
CREATE INDEX IF NOT EXISTS idx_vaults_listed_chain_liq ON vaults(is_listed, chain_id, liquidity_usd DESC);
CREATE INDEX IF NOT EXISTS idx_vaults_listed_chain_assets ON vaults(is_listed, chain_id, total_assets_usd DESC);

-- Markets table
CREATE TABLE IF NOT EXISTS markets (
  unique_key TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  loan_asset_address TEXT,
  loan_asset_symbol TEXT,
  loan_asset_decimals INTEGER,
  loan_asset_price_usd REAL,
  collateral_asset_address TEXT,
  collateral_asset_symbol TEXT,
  collateral_asset_decimals INTEGER,
  collateral_asset_price_usd REAL,
  oracle_address TEXT,
  irm_address TEXT,
  lltv TEXT,
  lltv_percent REAL,
  total_supply_assets TEXT,
  total_supply_assets_usd REAL,
  total_borrow_assets TEXT,
  total_borrow_assets_usd REAL,
  free_liquidity_assets REAL,
  free_liquidity_usd REAL,
  utilization REAL,
  borrow_apy REAL,
  supply_apy REAL,
  is_listed INTEGER DEFAULT 1,
  oracle_type TEXT DEFAULT 'ChainlinkOracleV2',
  bad_debt_usd REAL DEFAULT 0,
  realized_bad_debt_usd REAL DEFAULT 0,
  warnings_count INTEGER DEFAULT 0,
  warnings_json TEXT,
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_markets_chain ON markets(chain_id);
CREATE INDEX IF NOT EXISTS idx_markets_loan_collateral ON markets(loan_asset_symbol, collateral_asset_symbol);

-- Vault Allocations table (current composition of underlying markets)
CREATE TABLE IF NOT EXISTS vault_allocations (
  vault_address TEXT NOT NULL,
  market_unique_key TEXT NOT NULL,
  supply_assets TEXT,
  supply_assets_human REAL,
  supply_assets_usd REAL,
  supply_cap TEXT,
  supply_cap_human REAL,
  weight REAL,
  updated_at INTEGER,
  via_vault TEXT,
  PRIMARY KEY (vault_address, market_unique_key),
  FOREIGN KEY (vault_address) REFERENCES vaults(address) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_allocations_vault ON vault_allocations(vault_address);
CREATE INDEX IF NOT EXISTS idx_allocations_vault_supply ON vault_allocations(vault_address, supply_assets_usd DESC);
CREATE INDEX IF NOT EXISTS idx_allocations_market ON vault_allocations(market_unique_key);


-- System state and sync tracking
CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
);

-- Vault events (pending timelock changes, bad debt, TVL outflow, reallocations); history shown in the Vault Activity panel
CREATE TABLE IF NOT EXISTS vault_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vault_address TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'final',
  title TEXT NOT NULL,
  details_json TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  occurred_at INTEGER NOT NULL,
  valid_at INTEGER,
  detected_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vault_events_vault_occurred ON vault_events(vault_address, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_vault_events_occurred ON vault_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_vault_events_status_valid ON vault_events(status, valid_at);

-- Per-vault baseline for bad debt transitions and the admin event watermark
CREATE TABLE IF NOT EXISTS vault_watch_state (
  vault_address TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One sample per vault and hour: windows for TVL outflow, 7-day Net APY average and the daily digest diff
CREATE TABLE IF NOT EXISTS vault_samples (
  vault_address TEXT NOT NULL,
  hour_bucket INTEGER NOT NULL,
  sampled_at INTEGER NOT NULL,
  total_assets REAL,
  total_assets_usd REAL,
  net_apy REAL,
  mqi_percent REAL,
  verdict_level TEXT,
  verdict_reasons TEXT,
  fee REAL,
  is_listed INTEGER,
  PRIMARY KEY (vault_address, hour_bucket)
);

-- One row per vault and UTC day (the last sample of the day wins): the charts of the History tab
CREATE TABLE IF NOT EXISTS vault_daily (
  vault_address TEXT NOT NULL,
  day INTEGER NOT NULL,
  net_apy REAL,
  tvl_usd REAL,
  exit_percent REAL,
  active_markets INTEGER,
  flagged_percent REAL,
  PRIMARY KEY (vault_address, day)
);

-- Telegram subscriptions: sub_id is the secret the browser keeps, chat_id is set when the user presses Start in the bot
CREATE TABLE IF NOT EXISTS tg_subscriptions (
  sub_id TEXT PRIMARY KEY,
  chat_id INTEGER,
  vaults_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  bound_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tg_subscriptions_chat ON tg_subscriptions(chat_id);

-- What has already been sent to a subscription (event dedupe_key or digest:<date>), so a restart never repeats a message
CREATE TABLE IF NOT EXISTS tg_sent (
  sub_id TEXT NOT NULL,
  message_key TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (sub_id, message_key),
  FOREIGN KEY (sub_id) REFERENCES tg_subscriptions(sub_id) ON DELETE CASCADE
);

-- Morpho asset tags per collateral token (NULL = never fetched, 'null' = Morpho does not know the token)
CREATE TABLE IF NOT EXISTS token_tags (
  chain_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  tags_json TEXT,
  price_usd REAL,
  tags_fetched_at INTEGER,
  PRIMARY KEY (chain_id, address)
);

-- Public facts about a collateral token, parsed from fixed sources by services/tokenCollector.js (no judgement, unknown = null)
CREATE TABLE IF NOT EXISTS token_data (
  chain_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  symbol TEXT,
  collected_at INTEGER NOT NULL,
  status TEXT NOT NULL,              -- ok | partial | failed
  coverage REAL,                     -- share of the data fields that hold a value
  data_json TEXT NOT NULL,
  PRIMARY KEY (chain_id, address)
);

CREATE TABLE IF NOT EXISTS token_data_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  collected_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  data_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_token_data_history_token ON token_data_history(chain_id, address, collected_at DESC);
`;

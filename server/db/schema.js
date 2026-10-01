export const SCHEMA_SQL = `
-- Enforce WAL mode and foreign keys
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

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
  owner TEXT,
  pending_owner TEXT,
  version TEXT DEFAULT 'v1',
  liquidity_usd REAL DEFAULT 0,
  is_listed INTEGER DEFAULT 0,
  metadata_updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_vaults_version ON vaults(version);
CREATE INDEX IF NOT EXISTS idx_vaults_chain ON vaults(chain_id);
CREATE INDEX IF NOT EXISTS idx_vaults_curator ON vaults(curator_name);
CREATE INDEX IF NOT EXISTS idx_vaults_is_listed ON vaults(is_listed);

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
  PRIMARY KEY (vault_address, market_unique_key),
  FOREIGN KEY (vault_address) REFERENCES vaults(address) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_allocations_vault ON vault_allocations(vault_address);
CREATE INDEX IF NOT EXISTS idx_allocations_market ON vault_allocations(market_unique_key);


-- Daily historical APYs for backtesting and Monte Carlo calibration
CREATE TABLE IF NOT EXISTS daily_apys (
  vault_address TEXT NOT NULL,
  date TEXT NOT NULL,
  apy REAL,
  net_apy REAL,
  PRIMARY KEY (vault_address, date),
  FOREIGN KEY (vault_address) REFERENCES vaults(address) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_daily_apys_vault ON daily_apys(vault_address);

-- Periodic calculated snapshots of vault safety and liquidity metrics
CREATE TABLE IF NOT EXISTS vault_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vault_address TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  twr_30d REAL,
  twr_90d REAL,
  twr_all_time REAL,
  safety_score REAL,
  discipline_score REAL,
  liquidity_coverage REAL,
  vault_dominance REAL,
  instant_exit_capacity REAL,
  peak_risk_spike REAL,
  FOREIGN KEY (vault_address) REFERENCES vaults(address) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_snapshots_vault_time ON vault_snapshots(vault_address, timestamp);

-- System state and sync tracking
CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
);
`;

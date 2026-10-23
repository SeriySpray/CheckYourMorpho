/**
 * CheckYourMorpho: Main Frontend Controller
 * Connects 3D Particle Sphere, search autocomplete, filters, and audit modal.
 */

import { ParticleSphere } from './sphere.js?v=20261023_ledger';
import { initActivity, onFavoritesChanged, closeActivityPanel } from './activity.js?v=20261023_gap';

// Read live (.matches) so toggling the OS setting applies without a reload
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)');

let sphere = null;
let allVaults = [];
let selectedVaultAddress = null;
let activeAuditData = null;
let isTransitioningVault = false;
const clientAuditCache = new Map();

// Cached audits older than this are shown as a placeholder only and always re-fetched
const AUDIT_CACHE_TTL_MS = 120000;

/** Returns the cached audit for a vault when it is still fresh, otherwise null. */
function getFreshAudit(address) {
  const entry = clientAuditCache.get((address || '').toLowerCase());
  return entry && Date.now() - (entry.cachedAt || 0) < AUDIT_CACHE_TTL_MS ? entry : null;
}

// DOM Elements cache
const DOM = {
  sphereWrapper: document.getElementById('sphere-wrapper'),
  sphereCanvas: document.getElementById('sphere-canvas'),
  headerStatusText: document.getElementById('header-status-text'),
  tooltip: document.getElementById('sphere-tooltip'),
  ttChain: document.getElementById('tt-chain'),
  ttTitle: document.getElementById('tt-title'),
  ttTvl: document.getElementById('tt-tvl'),
  ttLiq: document.getElementById('tt-liq'),
  ttApy: document.getElementById('tt-apy'),
  morphProxy: document.getElementById('morph-proxy'),
  morphProxyRetract: document.getElementById('morph-proxy-retract'),
  auditModal: document.getElementById('audit-modal'),
  auditPanelBody: document.getElementById('audit-panel-body'),
  closeBtn: document.getElementById('modal-close-btn'),
  modalFavBtn: document.getElementById('modal-fav-btn'),

  // Left-side Pinned Rich Informational Pills Container
  pinnedRichPills: document.getElementById('pinned-rich-pills'),

  // Master Vault Explorer Terminal (Right-side 440px)
  vaultExplorerWidget: document.getElementById('vault-explorer-widget'),
  explorerCount: document.getElementById('explorer-count'),
  explorerActivityBtn: document.getElementById('explorer-activity-btn'),
  explorerActivityBadge: document.getElementById('explorer-activity-badge'),
  activityPanel: document.getElementById('activity-panel'),
  explorerFavFilterBtn: document.getElementById('explorer-fav-filter-btn'),
  explorerFavCount: document.getElementById('explorer-fav-count'),
  explorerResetBtn: document.getElementById('explorer-reset-btn'),
  searchInput: document.getElementById('vault-search-input'),
  searchClearBtn: document.getElementById('search-clear-btn'),
  searchShortcutEsc: document.getElementById('search-shortcut-esc'),
  activeFilterChips: document.getElementById('active-filter-chips'),
  chipsContainer: document.getElementById('chips-container'),
  explorerVaultsList: document.getElementById('explorer-vaults-list'),

  // Panel 1: Main & Specs
  modalChainBadge: document.getElementById('modal-chain-badge'),
  modalVersionBadge: document.getElementById('modal-version-badge'),
  modalListedBadge: document.getElementById('modal-listed-badge'),
  modalVaultName: document.getElementById('modal-vault-name'),
  modalCuratorName: document.getElementById('modal-curator-name'),
  modalGrade: document.getElementById('modal-grade'),
  modalScore: document.getElementById('modal-score'),
  modalTvl: document.getElementById('modal-tvl'),
  modalAssetsHuman: document.getElementById('modal-assets-human'),
  modalLiq: document.getElementById('modal-liq'),
  modalExitCapPct: document.getElementById('modal-exit-cap-pct'),
  modalNetApy: document.getElementById('modal-net-apy'),
  modalFee: document.getElementById('modal-fee'),
  overviewMarketsCount: document.getElementById('overview-markets-count'),

  // Panel 2: MQI, collateral classes & Exit
  riskMqiPct: document.getElementById('risk-mqi-pct'),
  riskMqiBar: document.getElementById('risk-mqi-bar'),
  riskMqiDesc: document.getElementById('risk-mqi-desc'),
  riskExitMeterBox: document.getElementById('risk-exit-meter-box'),
  riskExitLabel: document.getElementById('risk-exit-label'),
  riskExitInfoBtn: document.getElementById('risk-exit-info-btn'),
  riskExitPopover: document.getElementById('risk-exit-popover'),
  riskExitPopoverBody: document.getElementById('risk-exit-popover-body'),
  riskExitPct: document.getElementById('risk-exit-pct'),
  riskExitBar: document.getElementById('risk-exit-bar'),
  riskExitDesc: document.getElementById('risk-exit-desc'),
  riskEffectiveAssets: document.getElementById('risk-effective-assets'),
  riskCollateralList: document.getElementById('risk-collateral-list'),
  riskFlagsList: document.getElementById('risk-flags-list'),

  // Panel 3: Markets
  allocationsTbody: document.getElementById('allocations-tbody')
};

/**
 * Initializes application and fetches vaults data.
 */
/** The back-to-top arrow appears once the ledger is scrolled about two screens down. */
function setupLedgerToTop() {
  const ledger = DOM.vaultExplorerWidget;
  const btn = document.getElementById('ledger-to-top');
  if (!ledger || !btn) return;
  ledger.addEventListener('scroll', () => {
    const show = ledger.scrollTop > ledger.clientHeight * 2;
    btn.classList.toggle('show', show);
    btn.tabIndex = show ? 0 : -1;
  }, { passive: true });
  btn.addEventListener('click', () => ledger.scrollTo({ top: 0, behavior: REDUCED_MOTION.matches ? 'auto' : 'smooth' }));
}

async function initApp() {
  // 1. Initialize 3D Particle Sphere
  sphere = new ParticleSphere(DOM.sphereCanvas, {
    totalParticles: 1200,
    onVaultSelect: (vault, pos) => {
      openVaultAudit(vault, pos);
    },
    onVaultHover: (vault, particle) => {
      handleParticleHover(vault, particle);
    },
    onLogoClick: () => {
      if (selectedVaultAddress || !DOM.auditModal.classList.contains('hidden')) {
        closeVaultAudit();
      }
    }
  });
  window.sphere = sphere;
  applySphereLayout(true);
  window.addEventListener('resize', () => applySphereLayout(true));
  // The strip's width changes with the ledger (animated): re-measure once it settles
  if (DOM.pinnedRichPills?.parentElement) {
    bindPinnedScroll(DOM.pinnedRichPills.parentElement);
    new ResizeObserver(() => {
      clearTimeout(pinnedCarouselTimer);
      pinnedCarouselTimer = setTimeout(updatePinnedCarousel, 250);
    }).observe(DOM.pinnedRichPills.parentElement);
  }

  setupLedgerToTop();

  // 2. Bind UI Events
  setupVaultExplorerEvents();
  setupModalEvents();
  setupAuditNavTabs();

  // 3. Fetch Vaults from REST API
  try {
    const res = await apiFetch('/api/vaults?limit=1000&sortBy=total_assets_usd&sortOrder=desc');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allVaults = data.vaults || [];

    if (DOM.headerStatusText) DOM.headerStatusText.textContent = `Live: ${allVaults.length} Vaults`;
    sphere.setVaults(allVaults);
    renderVaultExplorer();
    renderPinnedRichPills();
  } catch (err) {
    console.error('Failed to fetch vaults:', err);
    if (DOM.headerStatusText) DOM.headerStatusText.textContent = 'API Offline';
  }
  refreshStaleIndicator();

  // 4. Start Live Periodic Polling (every 60s)
  startLivePolling();

  // 5. Initialize Vault Activity Panel
  initActivity({
    apiFetch,
    getPinnedAddresses,
    openVaultAudit: (v, pos) => openVaultAudit(v, pos),
    getVault: (addr) => {
      const key = (addr || '').toLowerCase();
      return allVaults.find(v => (v.address || '').toLowerCase() === key) || null;
    },
    formatChainName,
    getChainClass,
    escapeHtml,
    DOM: {
      vaultExplorerWidget: DOM.vaultExplorerWidget,
      explorerVaultsList: DOM.explorerVaultsList,
      explorerSearchBox: document.querySelector('.explorer-search-box'),
      explorerFiltersGrid: document.querySelector('.explorer-filters-grid'),
      activeFilterChips: DOM.activeFilterChips,
      explorerHeading: document.querySelector('.explorer-heading'),
      activityBtn: DOM.explorerActivityBtn,
      activityBadge: DOM.explorerActivityBadge,
      activityPanel: DOM.activityPanel
    },
    onPanelToggle: onActivityPanelToggle,
    getSphereParticlePos: (addr) => sphere?.getParticleScreenPos?.(addr) || null
  });
}

const CATEGORY_LABELS = {
  native_or_wrapped: 'ETH / BTC assets', stablecoin: 'Stablecoins', pendle_pt: 'Pendle PT', real_world_asset: 'Real-world assets',
  vault_or_lp_share: 'Vault / LP shares', other_crypto: 'Other crypto', unclassified: 'Unclassified'
};

let livePollingTimer = null;
let visibilityPollingBound = false;
let isPollingActive = false;

/**
 * fetch() with a timeout so a hung request can never block clicks or live polling forever.
 */
function apiFetch(url, timeoutMs = 15000, cancelSignal = null) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = cancelSignal && AbortSignal.any ? AbortSignal.any([timeout, cancelSignal]) : timeout;
  return fetch(url, { signal });
}


/**
 * Shows a short notice in the header status label, then restores the live counter.
 */
function showStatusNotice(text) {
  if (!DOM.headerStatusText) return;
  DOM.headerStatusText.textContent = text;
  setTimeout(() => {
    DOM.headerStatusText.textContent = allVaults.length > 0 ? `Live: ${allVaults.length} Vaults` : 'API Offline';
  }, 4000);
}

/** "5m ago" style age of an ISO timestamp, or '' when it cannot be parsed. */
function formatDataAge(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const min = Math.max(0, Math.floor(ms / 60000)); // clock skew must not produce "-3m ago"
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/**
 * Shows the stale-data notice when /api/status reports stale === true.
 * A failed request or an older API without the field leaves it hidden.
 */
async function refreshStaleIndicator() {
  let status = null;
  try {
    const res = await apiFetch('/api/status');
    if (res.ok) status = await res.json();
  } catch {
    // Offline state is already reported by the vaults poll
  }
  const stale = status?.stale === true;
  const age = stale ? formatDataAge(status.lastSuccessAt) : '';
  const label = age ? `Stale data · last sync ${age}` : 'Stale data';
  document.querySelectorAll('.stale-indicator').forEach(el => {
    el.classList.toggle('hidden', !stale);
    el.title = stale && age ? `Last successful sync: ${new Date(status.lastSuccessAt).toLocaleString()}` : '';
    const text = el.querySelector('.stale-text');
    if (text) text.textContent = stale ? label : '';
  });
}

/**
 * Periodically polls the server every 60 seconds to refresh vault metrics,
 * particle sphere, explorer list, and actively inspected audit modal.
 */
function startLivePolling() {
  if (livePollingTimer) clearInterval(livePollingTimer);

  const pollOnce = async () => {
    if (document.hidden) return;
    if (isPollingActive) return;
    isPollingActive = true;

    refreshStaleIndicator();
    try {
      // 1. Fetch updated vaults list
      const res = await apiFetch('/api/vaults?limit=1000&sortBy=total_assets_usd&sortOrder=desc');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.vaults) && data.vaults.length > 0) {
          allVaults = data.vaults;
          if (DOM.headerStatusText) {
            DOM.headerStatusText.textContent = `Live: ${allVaults.length} Vaults`;
          }
          if (sphere) {
            sphere.setVaults(allVaults);
          }

          // Preserve scroll position in vault explorer
          const savedScrollTop = DOM.vaultExplorerWidget ? DOM.vaultExplorerWidget.scrollTop : 0;
          renderVaultExplorer();
          if (DOM.explorerVaultsList) {
            if (DOM.vaultExplorerWidget) DOM.vaultExplorerWidget.scrollTop = savedScrollTop;
          }
          renderPinnedRichPills();
        }
      } else if (DOM.headerStatusText) {
        DOM.headerStatusText.textContent = 'Reconnecting...';
      }

      // 2. Quietly refresh full audits for all pinned vaults so they never lag
      const pinnedList = getPinnedAddresses();
      pinnedList.forEach(addr => {
        apiFetch(`/api/vaults/${addr}`)
          .then(r => r.ok ? r.json() : null)
          .then(auditData => {
            if (auditData) applyVaultAuditData(addr, auditData);
          })
          .catch(() => {});
      });

      // 3. If an audit modal is currently open and not animating, quietly refresh it
      if (selectedVaultAddress && !DOM.auditModal.classList.contains('hidden') && !isTransitioningVault) {
        const pollingAddr = selectedVaultAddress;
        const auditRes = await apiFetch(`/api/vaults/${pollingAddr}`);
        if (auditRes.ok) {
          const auditData = await auditRes.json();
          // Ensure user hasn't switched vaults or closed modal during fetch
          if (selectedVaultAddress === pollingAddr && !DOM.auditModal.classList.contains('hidden')) {
            applyVaultAuditData(pollingAddr, auditData);
          }
        }
      }
    } catch (pollErr) {
      console.warn('Live polling quiet error:', pollErr.message);
      if (DOM.headerStatusText) DOM.headerStatusText.textContent = 'Reconnecting...';
    } finally {
      isPollingActive = false;
    }
  };

  livePollingTimer = setInterval(pollOnce, 60000);

  // Catch up right away when the tab becomes visible again instead of waiting up to a minute
  if (!visibilityPollingBound) {
    visibilityPollingBound = true;
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) pollOnce();
    });
  }
}

function formatChainName(chainId) {
  switch (chainId) {
    case 1: return 'ETH';
    case 8453: return 'BASE';
    case 4663: return 'ROBINHOOD';
    case 42161: return 'ARB';
    case 137: return 'POLYGON';
    case 10: return 'OP';
    case 747474: return 'KATANA';
    case 999: return 'HYPEREVM';
    case 130: return 'UNICHAIN';
    case 143: return 'MONAD';
    case 480: return 'WORLD';
    case 988: return 'STABLE';
    case 4217: return 'TEMPO';
    case 5042: return 'ARC';
    default: return `CHAIN ${chainId}`;
  }
}

function getChainClass(chainId) {
  switch (chainId) {
    case 1: return 'ethereum';
    case 8453: return 'base';
    case 4663: return 'robinhood';
    case 42161: return 'arbitrum';
    case 10: return 'optimism';
    case 137: return 'polygon';
    default: return '';
  }
}

function formatCuratorName(name, vaultName = '') {
  const vName = vaultName || '';
  if (/steakhouse/i.test(vName)) return 'Steakhouse Financial';
  if (/gauntlet/i.test(vName)) return 'Gauntlet';
  if (/re7/i.test(vName)) return 'Re7 Labs';
  if (/paypal/i.test(vName)) return 'PayPal USD';
  if (/flagship/i.test(vName)) return 'Morpho Flagship';
  if (/blockanalitica|bprotocol/i.test(vName)) return 'B.Protocol';
  if (!name || name === 'Independent' || name === 'Permissionless') {
    return 'Permissionless';
  }
  if (name.startsWith('0x') && name.length > 10) {
    return `${name.slice(0, 6)}...${name.slice(-4)}`;
  }
  return name;
}

function handleParticleHover(vault, particle) {
  // Hover popup tooltip disabled per user request
  if (DOM.tooltip) {
    DOM.tooltip.classList.add('hidden');
  }
}

const explorerFilters = {
  query: '',
  network: 'all',
  asset: 'all',
  curator: 'all',
  sort: 'tvl_desc',
  pinnedOnly: false
};

/**
 * Closes all open custom dropdown menus.
 */
function closeAllDropdowns() {
  document.querySelectorAll('.custom-dropdown.open').forEach(dropdown => {
    dropdown.classList.remove('open');
    dropdown.querySelector('.dropdown-trigger')?.setAttribute('aria-expanded', 'false');
  });
}

/**
 * Updates a custom dropdown's trigger label and selected item state.
 */
function updateDropdownUI(filterKey, value) {
  const dropdown = document.querySelector(`.custom-dropdown[data-filter="${filterKey}"]`);
  if (!dropdown) return;
  const trigger = dropdown.querySelector('.dropdown-trigger');
  const valEl = dropdown.querySelector('.trigger-value');
  const items = dropdown.querySelectorAll('.dropdown-item');

  let selectedLabel = '';
  items.forEach(item => {
    const itemVal = item.getAttribute('data-value');
    const isSelected = itemVal === value;
    item.classList.toggle('selected', isSelected);
    item.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    if (isSelected) {
      const textSpan = item.querySelector('.item-text');
      selectedLabel = textSpan ? textSpan.textContent.trim() : item.textContent.trim();
    }
  });

  if (valEl && selectedLabel) {
    valEl.textContent = selectedLabel;
  }

  // Highlight trigger if active (non-default)
  const isDefault = (filterKey === 'sort') ? value === 'tvl_desc' : value === 'all';
  trigger?.classList.toggle('is-active', !isDefault);
}

/**
 * Sets a filter value and updates the UI and list.
 */
function setFilterValue(filterKey, value) {
  explorerFilters[filterKey] = value;
  updateDropdownUI(filterKey, value);
  renderVaultExplorer();
}

/**
 * Renders active filter tags and controls in the active chips toolbar.
 * Search query is managed exclusively in the search input and does not appear as a filter chip.
 */
function updateActiveFilterChips() {
  if (!DOM.activeFilterChips || !DOM.chipsContainer) return;

  const hasActiveFilters = Boolean(
    explorerFilters.network !== 'all' ||
    explorerFilters.asset !== 'all' ||
    explorerFilters.curator !== 'all' ||
    explorerFilters.sort !== 'tvl_desc' ||
    explorerFilters.pinnedOnly
  );

  if (!hasActiveFilters) {
    DOM.activeFilterChips.classList.add('hidden');
    DOM.chipsContainer.innerHTML = '';
    return;
  }

  DOM.activeFilterChips.classList.remove('hidden');
  let chipsHtml = '';

  if (explorerFilters.network !== 'all') {
    const chainName = formatChainName(parseInt(explorerFilters.network, 10));
    chipsHtml += `
      <span class="filter-chip" data-type="network">
        <span class="chip-label">${escapeHtml(chainName)}</span>
        <button type="button" class="chip-remove" data-clear="network" aria-label="Remove network filter" title="Remove">&times;</button>
      </span>
    `;
  }

  if (explorerFilters.asset !== 'all') {
    chipsHtml += `
      <span class="filter-chip" data-type="asset">
        <span class="chip-label">${escapeHtml(explorerFilters.asset)}</span>
        <button type="button" class="chip-remove" data-clear="asset" aria-label="Remove asset filter" title="Remove">&times;</button>
      </span>
    `;
  }

  if (explorerFilters.curator !== 'all') {
    const curatorLabels = {
      steakhouse: 'Steakhouse',
      gauntlet: 'Gauntlet',
      re7: 'Re7 Labs',
      flagship: 'Morpho Flagship',
      bprotocol: 'B.Protocol'
    };
    const label = curatorLabels[explorerFilters.curator] || explorerFilters.curator;
    chipsHtml += `
      <span class="filter-chip" data-type="curator">
        <span class="chip-label">${escapeHtml(label)}</span>
        <button type="button" class="chip-remove" data-clear="curator" aria-label="Remove curator filter" title="Remove">&times;</button>
      </span>
    `;
  }

  if (explorerFilters.sort !== 'tvl_desc') {
    const sortLabels = {
      apy_desc: 'APY: High to Low',
      liq_desc: 'Free Liquidity: High to Low',
      mqi_asc: 'Market Quality: Flagged First',
      mqi_desc: 'Market Quality: Clean First',
    };
    const label = sortLabels[explorerFilters.sort] || explorerFilters.sort;
    chipsHtml += `
      <span class="filter-chip" data-type="sort">
        <span class="chip-label">${escapeHtml(label)}</span>
        <button type="button" class="chip-remove" data-clear="sort" aria-label="Remove sort filter" title="Remove">&times;</button>
      </span>
    `;
  }

  if (explorerFilters.pinnedOnly) {
    chipsHtml += `
      <span class="filter-chip" data-type="pinnedOnly">
        <span class="chip-label">&#9733; Favorites</span>
        <button type="button" class="chip-remove" data-clear="pinnedOnly" aria-label="Remove favorites filter" title="Remove">&times;</button>
      </span>
    `;
  }

  DOM.chipsContainer.innerHTML = chipsHtml;

  // Bind individual chip remove buttons
  DOM.chipsContainer.querySelectorAll('.chip-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const toClear = btn.getAttribute('data-clear');
      if (toClear === 'pinnedOnly') {
        explorerFilters.pinnedOnly = false;
      } else if (toClear === 'sort') {
        explorerFilters.sort = 'tvl_desc';
        updateDropdownUI('sort', 'tvl_desc');
      } else {
        explorerFilters[toClear] = 'all';
        updateDropdownUI(toClear, 'all');
      }
      renderVaultExplorer();
    });
  });
}

/**
 * Sets up event listeners for the Master Vault Explorer Terminal.
 */
function setupVaultExplorerEvents() {
  if (DOM.searchInput) {
    let searchDebounceTimer = null;
    DOM.searchInput.addEventListener('input', () => {
      const val = DOM.searchInput.value.trim();
      if (DOM.searchClearBtn) {
        DOM.searchClearBtn.classList.toggle('hidden', val.length === 0);
      }
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        explorerFilters.query = val.toLowerCase();
        renderVaultExplorer();
      }, 120);
    });

    // Escape is handled centrally in setupModalEvents (closes one layer at a time)
    DOM.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        // Apply a pending debounced query first so Enter never opens a stale first row
        clearTimeout(searchDebounceTimer);
        explorerFilters.query = DOM.searchInput.value.trim().toLowerCase();
        renderVaultExplorer();
        const firstItem = DOM.explorerVaultsList?.querySelector('.explorer-vault-item');
        if (firstItem) {
          firstItem.click();
        }
      }
    });
  }

  if (DOM.searchClearBtn) {
    DOM.searchClearBtn.addEventListener('click', () => {
      if (DOM.searchInput) {
        DOM.searchInput.value = '';
        DOM.searchClearBtn.classList.add('hidden');
        explorerFilters.query = '';
        renderVaultExplorer();
        DOM.searchInput.focus();
      }
    });
  }

  if (DOM.searchShortcutEsc) {
    DOM.searchShortcutEsc.addEventListener('click', () => {
      if (DOM.searchInput) {
        DOM.searchInput.value = '';
        if (DOM.searchClearBtn) DOM.searchClearBtn.classList.add('hidden');
        explorerFilters.query = '';
        renderVaultExplorer();
        DOM.searchInput.blur();
        sphere.highlightVault(null);
      }
    });
  }

  // Custom Dropdown triggers and options
  const dropdowns = document.querySelectorAll('.custom-dropdown');
  dropdowns.forEach(dropdown => {
    const trigger = dropdown.querySelector('.dropdown-trigger');
    const menu = dropdown.querySelector('.dropdown-menu');
    const filterKey = dropdown.getAttribute('data-filter');

    if (trigger) {
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasOpen = dropdown.classList.contains('open');
        closeAllDropdowns();
        if (!wasOpen) {
          dropdown.classList.add('open');
          trigger.setAttribute('aria-expanded', 'true');
          // Keyboard activation (detail 0): move focus into the list
          if (e.detail === 0) dropdown.querySelector('.dropdown-item.selected, .dropdown-item')?.focus();
        }
      });
    }

    if (menu) {
      menu.querySelectorAll('.dropdown-item').forEach(item => {
        item.tabIndex = 0;
        item.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            item.click();
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            (e.key === 'ArrowDown' ? item.nextElementSibling : item.previousElementSibling)?.focus();
          }
        });
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          const value = item.getAttribute('data-value');
          setFilterValue(filterKey, value);
          closeAllDropdowns();
          trigger?.focus();
        });
      });
    }
  });

  // Global document click closes open dropdowns
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.custom-dropdown')) {
      closeAllDropdowns();
    }
  });

  if (DOM.explorerFavFilterBtn) {
    DOM.explorerFavFilterBtn.addEventListener('click', () => {
      // From the activity view the star means "show my saved vaults": go back to the table with that filter on
      const fromActivity = DOM.activityPanel && !DOM.activityPanel.classList.contains('hidden');
      if (fromActivity) closeActivityPanel();
      explorerFilters.pinnedOnly = fromActivity ? true : !explorerFilters.pinnedOnly;
      renderVaultExplorer();
    });
  }

  // Opening the activity view first closes an open audit, so the ledger regains its width before the switch
  if (DOM.explorerActivityBtn) {
    DOM.explorerActivityBtn.addEventListener('click', () => {
      if (!DOM.auditModal.classList.contains('hidden')) closeVaultAudit();
    });
  }

  if (DOM.explorerResetBtn) {
    DOM.explorerResetBtn.addEventListener('click', () => {
      resetAllFilters();
    });
  }
}

function resetDropdownFilters() {
  explorerFilters.network = 'all';
  explorerFilters.asset = 'all';
  explorerFilters.curator = 'all';
  explorerFilters.sort = 'tvl_desc';
  explorerFilters.pinnedOnly = false;

  updateDropdownUI('network', 'all');
  updateDropdownUI('asset', 'all');
  updateDropdownUI('curator', 'all');
  updateDropdownUI('sort', 'tvl_desc');

  closeAllDropdowns();
  renderVaultExplorer();
}

function resetAllFilters() {
  explorerFilters.query = '';
  if (DOM.searchInput) DOM.searchInput.value = '';
  if (DOM.searchClearBtn) DOM.searchClearBtn.classList.add('hidden');

  resetDropdownFilters();
  sphere.highlightVault(null);
}

function matchesAssetFilter(assetSym, filter) {
  if (!filter || filter === 'all') return true;
  if (!assetSym) return false;
  const sym = assetSym.toUpperCase();
  const f = filter.toUpperCase();
  if (f === 'ETH') return sym.includes('ETH');
  if (f === 'USDE') return sym.includes('USDE');
  if (f === 'EURC') return sym.includes('EUR');
  return sym === f || sym.includes(f);
}

function matchesCuratorFilter(v, filter) {
  if (!filter || filter === 'all') return true;
  const name = (v.name || '').toLowerCase();
  const curator = (v.curatorName || '').toLowerCase();
  const f = filter.toLowerCase();

  if (f === 'steakhouse') return name.includes('steakhouse') || curator.includes('steakhouse');
  if (f === 'gauntlet') return name.includes('gauntlet') || curator.includes('gauntlet');
  if (f === 're7') return name.includes('re7') || curator.includes('re7');
  if (f === 'flagship') return name.includes('flagship') || name.includes('morpho') || curator.includes('morpho');
  if (f === 'bprotocol') return name.includes('bprotocol') || name.includes('blockanalitica') || curator.includes('bprotocol');
  return false;
}

/* --- Pinned Vaults (Favorites / Watchlist) Management --- */
const PINNED_STORAGE_KEY = 'cym_pinned_vaults';

// In-memory copy used when localStorage is blocked (private mode, disabled storage), so pinning still works
let pinnedMemoryFallback = null;

/**
 * Pinned vault addresses (lowercase). With visibleOnly the list is limited to vaults the API currently
 * returns; the stored list itself is never pruned, so a vault missing for a while keeps its pin.
 */
function getPinnedAddresses(visibleOnly = true) {
  let list = pinnedMemoryFallback;
  if (list === null) {
    try {
      const raw = localStorage.getItem(PINNED_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      list = Array.isArray(parsed) ? parsed.map(a => String(a).toLowerCase()) : [];
    } catch {
      list = [];
    }
  }
  if (visibleOnly && Array.isArray(allVaults) && allVaults.length > 0) {
    const validSet = new Set(allVaults.map(v => (v.address || '').toLowerCase()));
    return list.filter(addr => validSet.has(addr));
  }
  return list;
}

function savePinnedAddresses(addresses) {
  try {
    localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(addresses));
    pinnedMemoryFallback = null;
  } catch (err) {
    pinnedMemoryFallback = addresses;
    console.error('Failed to save pinned vaults to localStorage:', err);
  }
}

function isVaultPinned(address, pinnedSet = null) {
  if (!address) return false;
  const key = address.toLowerCase();
  return pinnedSet ? pinnedSet.has(key) : getPinnedAddresses().includes(key);
}

function togglePinVault(address) {
  if (!address) return;
  const addr = address.toLowerCase();
  let pinned = getPinnedAddresses(false); // raw list: filtering by the current API response would drop other pins
  const exists = pinned.includes(addr);
  if (exists) {
    pinned = pinned.filter(a => a !== addr);
  } else {
    pinned.push(addr);
  }
  savePinnedAddresses(pinned);
  updateFavBtnUI(addr);
  renderPinnedRichPills();
  renderVaultExplorer();
  onFavoritesChanged();
}

function updateFavBtnUI(currentAddress) {
  if (!DOM.modalFavBtn) return;
  const isPinned = isVaultPinned(currentAddress);
  DOM.modalFavBtn.classList.toggle('active', isPinned);
  DOM.modalFavBtn.setAttribute('aria-label', isPinned ? 'Unpin from Favorites' : 'Pin to Favorites');
  DOM.modalFavBtn.title = isPinned ? 'Unpin from Favorites' : 'Pin to Favorites';
}

/**
 * Synchronizes fresh vault audit data across clientAuditCache, allVaults,
 * the active audit modal (if open for this vault), the pinned rich pills,
 * and the vault explorer list.
 */
function applyVaultAuditData(vaultAddress, auditData) {
  if (!vaultAddress || !auditData?.vault || !auditData?.verdict) return;
  const lowerAddr = vaultAddress.toLowerCase();
  auditData.cachedAt = Date.now();
  clientAuditCache.set(lowerAddr, auditData);

  const v = auditData.vault;
  const verdict = auditData.verdict;

  // 1. Synchronize into allVaults item
  const matchingVault = allVaults.find(item => (item.address || '').toLowerCase() === lowerAddr);
  if (matchingVault) {
    if (v) {
      if (v.totalAssetsUsd !== undefined) matchingVault.totalAssetsUsd = v.totalAssetsUsd;
      if (v.totalAssets !== undefined) matchingVault.totalAssets = v.totalAssets;
      if (v.liquidityUsd !== undefined) matchingVault.liquidityUsd = v.liquidityUsd;
      if (v.netApy !== undefined) matchingVault.netApy = v.netApy;
      if (v.apy !== undefined) matchingVault.apy = v.apy;
      if (v.fee !== undefined) matchingVault.fee = v.fee;
      if (v.name) matchingVault.name = v.name;
      if (v.curatorName) matchingVault.curatorName = v.curatorName;
      if (v.asset) {
        matchingVault.asset = Object.assign({}, matchingVault.asset || {}, v.asset);
      }
    }
    if (verdict) {
      if (verdict.mqi?.mqiPercent !== undefined) matchingVault.mqiPercent = verdict.mqi.mqiPercent;
      if (verdict.mqi?.isAllClean !== undefined) matchingVault.isAllClean = verdict.mqi.isAllClean;
      // the list badge reads these too, so they follow the audit together with the score
      if (verdict.mqi?.compromisedMarkets) matchingVault.compromisedCount = verdict.mqi.compromisedMarkets.length;
      if (verdict.mqi?.compromisedPercent !== undefined) matchingVault.compromisedPercent = verdict.mqi.compromisedPercent;
      if (verdict.mqi?.unverifiedPercent !== undefined) matchingVault.unverifiedPercent = verdict.mqi.unverifiedPercent;
      if (verdict.mqi?.unpriced !== undefined) matchingVault.isUnpriced = verdict.mqi.unpriced;
      if (verdict.liquidity?.instantExitCapacityPercent !== undefined) {
        matchingVault.exitCapPercent = verdict.liquidity.instantExitCapacityPercent;
      }
      if (verdict.liquidity?.instantExitCapacityUsd !== undefined) {
        matchingVault.exitCapUsd = verdict.liquidity.instantExitCapacityUsd;
      }
    }
  }

  // 2. Synchronize active audit modal if this vault is currently open and displayed
  if (selectedVaultAddress && selectedVaultAddress.toLowerCase() === lowerAddr && !DOM.auditModal.classList.contains('hidden')) {
    activeAuditData = auditData;
    populateAuditModal(auditData, true);
  }

  // 3. Synchronize pinned rich pill in DOM immediately with exact matching values
  const pinnedList = getPinnedAddresses();
  if (pinnedList.includes(lowerAddr)) {
    const card = DOM.pinnedRichPills?.querySelector(`[data-address="${v?.address || vaultAddress}"]`)
      || DOM.pinnedRichPills?.querySelector(`[data-address="${lowerAddr}"]`);
    if (card && v) {
      const netApyFormatted = formatPercent(v.netApy || 0);
      const feeFormatted = `Fee: ${((v.fee || 0) * 100).toFixed(1)}%`;
      const decimals = v.asset?.decimals ?? matchingVault?.asset?.decimals ?? 6;
      let tokenAmount = 0;
      if (v.totalAssets) {
        tokenAmount = Number(v.totalAssets) / Math.pow(10, decimals);
      } else {
        const price = v.asset?.priceUsd ?? matchingVault?.asset?.priceUsd ?? 1;
        tokenAmount = price > 0 ? (v.totalAssetsUsd || 0) / price : 0;
      }
      const symbol = v.asset?.symbol || matchingVault?.asset?.symbol || '';
      const humanAsset = `${formatNumber(tokenAmount)} ${symbol}`;

      const mqiPercent = firstDefined(verdict?.mqi?.mqiPercent, matchingVault?.mqiPercent, 100);
      const { clean: isClean, text: mqiText } = mqiBadgeInfo(mqiPercent, verdict?.mqi?.isAllClean ?? matchingVault?.isAllClean ?? true, (verdict?.mqi?.compromisedMarkets?.length ?? matchingVault?.compromisedCount ?? 0) > 0, verdict?.mqi?.unpriced ?? matchingVault?.isUnpriced);
      const mqiClass = isClean ? 'clean' : 'flagged';
      const exitCapText = formatExitCap(pickExitMetric(
        verdict?.liquidity?.instantExitCapacityPercent,
        matchingVault?.exitCapPercent,
        // no reported liquidity is unknown, not 0%
        v.totalAssetsUsd > 0 && v.liquidityUsd != null ? Number(((v.liquidityUsd / v.totalAssetsUsd) * 100).toFixed(1)) : null
      ));

      // Update MQI badge
      const mqiBadge = card.querySelector('.rich-pill-mqi-badge');
      if (mqiBadge) {
        mqiBadge.className = `rich-pill-mqi-badge ${mqiClass}`;
        mqiBadge.textContent = mqiText;
      }

      // Update Financials
      const finItems = card.querySelectorAll('.rich-pill-fin-item');
      if (finItems.length >= 3) {
        // Deposits
        const depVal = finItems[0].querySelector('.rich-pill-fin-val');
        const depSub = finItems[0].querySelector('.rich-pill-fin-sub');
        if (depVal) depVal.textContent = formatCurrency(v.totalAssetsUsd);
        if (depSub) depSub.textContent = humanAsset;

        // Liquidity
        const liqVal = finItems[1].querySelector('.rich-pill-fin-val');
        const liqSub = finItems[1].querySelector('.rich-pill-fin-sub');
        if (liqVal) liqVal.textContent = formatCurrency(v.liquidityUsd);
        if (liqSub) liqSub.textContent = exitCapText;

        // Net APY
        const apyVal = finItems[2].querySelector('.rich-pill-fin-val');
        const apySub = finItems[2].querySelector('.rich-pill-fin-sub');
        if (apyVal) apyVal.textContent = netApyFormatted;
        if (apySub) apySub.textContent = feeFormatted;
      }
    }
  }

  syncPinnedClones();

  // 4. Synchronize Vault Explorer list item if present
  const expItem = DOM.explorerVaultsList?.querySelector(`[data-address="${v?.address || vaultAddress}"]`)
    || DOM.explorerVaultsList?.querySelector(`[data-address="${lowerAddr}"]`);
  if (expItem && v) {
    const tvlEl = expItem.querySelector('.vault-item-tvl');
    const apyEl = expItem.querySelector('.vault-item-apy');
    if (tvlEl) tvlEl.textContent = formatCurrency(v.totalAssetsUsd || v.liquidityUsd || 0);
    if (apyEl) apyEl.textContent = `${formatPercent(v.netApy || 0)} APY`;
  }
}

/** Click and hover behaviour of a pinned pill (shared by the cards and the carousel's looped copies). */
function bindPinnedCard(card, v) {
  // Click on unpin white star removes vault; click anywhere else opens full audit
  card.addEventListener('click', (e) => {
    if (e.target.closest('.rich-pill-star-btn')) {
      e.stopPropagation();
      togglePinVault(v.address);
      return;
    }
    openVaultAudit(v);
  });

  // Highlight sphere particle on hover
  card.addEventListener('mouseenter', () => {
    sphere.highlightVault(v.address);
  });

  card.addEventListener('mouseleave', () => {
    if (!selectedVaultAddress) {
      sphere.highlightVault(null);
    }
  });
}

/**
 * Renders the Pinned Vaults as rich informational cards/pills docked on the left.
 */
/** Slow px per second of the pinned carousel. */
const PINNED_SPEED = 22;

/**
 * Loops the pinned pills endlessly when they overflow the strip: a second copy follows the first and the
 * track slides by one copy's width. The slide is a CSS transform (no layout, no JS per frame).
 */
function updatePinnedCarousel() {
  const box = DOM.pinnedRichPills;
  const view = box?.parentElement;
  if (!box || !view) return;
  box.querySelectorAll('.is-clone').forEach(c => c.remove());
  box.classList.remove('is-scrolling');
  const setWidth = box.scrollWidth;
  if (REDUCED_MOTION.matches || pinnedSource.length === 0 || !(setWidth > view.clientWidth + 1)) return;
  pinnedSource.forEach(({ card, v }) => {
    const clone = card.cloneNode(true);
    clone.classList.add('is-clone');
    clone.setAttribute('aria-hidden', 'true');
    clone.tabIndex = -1;
    bindPinnedCard(clone, v);
    box.appendChild(clone);
  });
  box.style.setProperty('--pin-loop', `${setWidth}px`);
  box.style.setProperty('--pin-dur', `${Math.round(setWidth / PINNED_SPEED)}s`);
  box.classList.add('is-scrolling');
}

/** Moves the running carousel by dx px (positive = forward) by shifting its animation clock; wraps by itself. */
function nudgePinnedCarousel(dx) {
  const anim = DOM.pinnedRichPills?.getAnimations?.()[0];
  if (!anim) return false;
  const total = anim.effect.getComputedTiming().duration;
  const t = ((Number(anim.currentTime) || 0) + (dx / PINNED_SPEED) * 1000) % total;
  anim.currentTime = t < 0 ? t + total : t;
  return true;
}

/** Wheel and drag scroll the saved pills while the carousel runs (it is paused under the cursor, not frozen). */
function bindPinnedScroll(view) {
  view.addEventListener('wheel', (e) => {
    const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (nudgePinnedCarousel(dx)) e.preventDefault();
  }, { passive: false });

  let startX = null;
  let moved = 0;
  view.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    startX = e.clientX;
    moved = 0;
  });
  window.addEventListener('pointermove', (e) => {
    if (startX === null) return;
    const dx = e.clientX - startX;
    startX = e.clientX;
    moved += Math.abs(dx);
    if (moved > 5) {
      view.classList.add('is-dragging');
      DOM.pinnedRichPills.style.animationPlayState = 'paused';
      nudgePinnedCarousel(-dx);
    }
  });
  window.addEventListener('pointerup', () => {
    if (startX === null) return;
    startX = null;
    view.classList.remove('is-dragging');
    if (DOM.pinnedRichPills) DOM.pinnedRichPills.style.animationPlayState = '';
  });
  // A drag must not open the vault under the finger
  view.addEventListener('click', (e) => {
    if (moved > 5) { e.stopPropagation(); e.preventDefault(); moved = 0; }
  }, true);
}

/** Copies the live content of the cards into the carousel copies (the audit poll updates only the originals). */
function syncPinnedClones() {
  const box = DOM.pinnedRichPills;
  if (!box?.classList.contains('is-scrolling')) return;
  const clones = [...box.querySelectorAll('.is-clone')];
  pinnedSource.forEach(({ card }, i) => { if (clones[i]) clones[i].innerHTML = card.innerHTML; });
}

let pinnedSource = [];
let pinnedCarouselTimer = null;

function renderPinnedRichPills() {
  if (!DOM.pinnedRichPills) return;
  pinnedSource = [];

  const pinnedAddresses = getPinnedAddresses();
  const pinnedVaults = [];
  for (const addr of pinnedAddresses) {
    const found = allVaults.find(v => (v.address || '').toLowerCase() === addr) || clientAuditCache.get(addr)?.vault;
    if (found) pinnedVaults.push(found);
  }

  // If no pinned vaults exist, or if audit modal is open, keep container hidden
  const isAuditOpen = selectedVaultAddress && !DOM.auditModal.classList.contains('hidden');
  if (pinnedVaults.length === 0 || isAuditOpen) {
    DOM.pinnedRichPills.classList.add('hidden');
    DOM.pinnedRichPills.innerHTML = '';
    return;
  }

  DOM.pinnedRichPills.classList.remove('hidden');
  DOM.pinnedRichPills.innerHTML = '';

  pinnedVaults.forEach(v => {
    const chainClass = getChainClass(v.chainId);
    const chainName = formatChainName(v.chainId);
    const curator = formatCuratorName(v.curatorName, v.name);
    const cachedAudit = getFreshAudit(v.address);

    const totalAssetsUsd = cachedAudit?.vault?.totalAssetsUsd ?? v.totalAssetsUsd ?? 0;
    const liquidityUsd = cachedAudit?.vault?.liquidityUsd ?? v.liquidityUsd ?? null;
    const netApy = cachedAudit?.vault?.netApy ?? v.netApy ?? 0;
    const fee = cachedAudit?.vault?.fee ?? v.fee ?? 0;
    const totalAssets = cachedAudit?.vault?.totalAssets ?? v.totalAssets;

    const netApyFormatted = formatPercent(netApy || 0);
    const feeFormatted = `Fee: ${((fee || 0) * 100).toFixed(1)}%`;

    const decimals = cachedAudit?.vault?.asset?.decimals ?? v.asset?.decimals ?? 6;
    const symbol = cachedAudit?.vault?.asset?.symbol ?? v.asset?.symbol ?? '';
    let tokenAmount = 0;
    if (totalAssets) {
      tokenAmount = Number(totalAssets) / Math.pow(10, decimals);
    } else {
      const price = cachedAudit?.vault?.asset?.priceUsd ?? v.asset?.priceUsd ?? 1;
      tokenAmount = price > 0 ? (totalAssetsUsd / price) : 0;
    }
    const humanAsset = `${formatNumber(tokenAmount)} ${symbol}`;
    const mqiPercent = firstDefined(cachedAudit?.verdict?.mqi?.mqiPercent, v.mqiPercent, 100);
    const { clean: isClean, text: mqiText } = mqiBadgeInfo(mqiPercent, cachedAudit?.verdict?.mqi?.isAllClean ?? v.isAllClean ?? true, (cachedAudit?.verdict?.mqi?.compromisedMarkets?.length ?? v.compromisedCount ?? 0) > 0, cachedAudit?.verdict?.mqi?.unpriced ?? v.isUnpriced);
    const mqiClass = isClean ? 'clean' : 'flagged';
    const exitCapText = formatExitCap(pickExitMetric(
      cachedAudit?.verdict?.liquidity?.instantExitCapacityPercent,
      v.exitCapPercent,
      liquidityUsd === null ? null : (totalAssetsUsd > 0 ? Number(((liquidityUsd / totalAssetsUsd) * 100).toFixed(1)) : 0)
    ));

    const card = document.createElement('div');
    card.className = 'pinned-rich-pill';
    card.dataset.address = v.address;
    card.innerHTML = `
      <div class="rich-pill-top">
        <div class="rich-pill-meta">
          <div class="rich-pill-title-row">
            <span class="badge badge-chain ${chainClass}">${escapeHtml(chainName.slice(0, 4).toUpperCase())}</span>
            <span class="rich-pill-name" title="${escapeHtml(v.name)}">${escapeHtml(v.name)}</span>
          </div>
          <div class="rich-pill-curator">${escapeHtml(curator)} • <span style="color:#ffffff;">${escapeHtml(symbol)}</span></div>
        </div>
        <div class="rich-pill-actions">
          <span class="rich-pill-mqi-badge ${mqiClass}">${escapeHtml(mqiText)}</span>
          <button type="button" class="rich-pill-star-btn" data-unpin="${escapeHtml(v.address)}" title="Unpin from favorites" aria-label="Unpin ${escapeHtml(v.name)}">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="#ffffff" stroke="#ffffff" stroke-width="1.5">
              <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="rich-pill-fin-grid">
        <div class="rich-pill-fin-item">
          <span class="rich-pill-fin-label">Deposits</span>
          <span class="rich-pill-fin-val">${formatCurrency(totalAssetsUsd)}</span>
          <span class="rich-pill-fin-sub">${escapeHtml(humanAsset)}</span>
        </div>
        <div class="rich-pill-fin-item">
          <span class="rich-pill-fin-label">Liquidity</span>
          <span class="rich-pill-fin-val">${formatCurrency(liquidityUsd)}</span>
          <span class="rich-pill-fin-sub highlight">${escapeHtml(exitCapText)}</span>
        </div>
        <div class="rich-pill-fin-item">
          <span class="rich-pill-fin-label">Net APY</span>
          <span class="rich-pill-fin-val green">${netApyFormatted}</span>
          <span class="rich-pill-fin-sub">${feeFormatted}</span>
        </div>
      </div>
    `;

    bindPinnedCard(card, v);
    pinnedSource.push({ card, v });

    DOM.pinnedRichPills.appendChild(card);
  });
  updatePinnedCarousel();

  // Background pre-fetch full audits for pinned vaults to warm cache and ensure exact data
  pinnedAddresses.forEach(addr => {
    if (getFreshAudit(addr)) return; // live polling keeps cached audits fresh
    apiFetch(`/api/vaults/${addr}`)
      .then(res => res.ok ? res.json() : null)
      .then(auditData => {
        if (auditData) {
          applyVaultAuditData(addr, auditData);
        }
      })
      .catch(() => {});
  });
}

/**
 * Renders the filtered and sorted Vaults Explorer list.
 */
/** Rows rendered synchronously, rows per idle chunk after that, and the token that cancels a stale chunk loop. */
const EXPLORER_FIRST_ROWS = 60;
const EXPLORER_CHUNK = 80;
let explorerRenderToken = 0;

/** Star in the header is pressed only while the favorites filter is on and the table (not the activity view) is showing. */
function syncFavFilterButton() {
  if (!DOM.explorerFavFilterBtn) return;
  const pressed = explorerFilters.pinnedOnly && !(DOM.activityPanel && !DOM.activityPanel.classList.contains('hidden'));
  DOM.explorerFavFilterBtn.classList.toggle('active', pressed);
  DOM.explorerFavFilterBtn.setAttribute('aria-pressed', String(pressed));
}

/** The activity view hides the filter chips; when it closes they come back for whatever filters are still on. */
function onActivityPanelToggle() {
  syncFavFilterButton();
  if (DOM.activityPanel?.classList.contains('hidden')) updateActiveFilterChips();
}

function renderVaultExplorer() {
  if (!DOM.explorerVaultsList) return;
  const savedScrollTop = DOM.vaultExplorerWidget ? DOM.vaultExplorerWidget.scrollTop : 0;
  DOM.explorerVaultsList.innerHTML = '';
  explorerRenderToken++;

  const pinnedList = getPinnedAddresses();
  const pinnedSet = new Set(pinnedList); // built once per render instead of once per row
  if (DOM.explorerFavCount) {
    DOM.explorerFavCount.textContent = pinnedList.length;
  }
  syncFavFilterButton();

  const isFiltered = Boolean(
    explorerFilters.query ||
    explorerFilters.network !== 'all' ||
    explorerFilters.asset !== 'all' ||
    explorerFilters.curator !== 'all' ||
    explorerFilters.sort !== 'tvl_desc' ||
    explorerFilters.pinnedOnly
  );

  updateActiveFilterChips();

  let results = allVaults.filter(v => {
    // 0. Pinned / Favorites Filter
    if (explorerFilters.pinnedOnly) {
      if (!isVaultPinned(v.address, pinnedSet)) return false;
    }

    // 1. Text Query Filter
    if (explorerFilters.query) {
      const terms = explorerFilters.query.split(/\s+/).filter(Boolean);
      const name = (v.name || '').toLowerCase();
      const symbol = (v.symbol || '').toLowerCase();
      const curator = (v.curatorName || '').toLowerCase();
      const assetSym = (v.asset?.symbol || '').toLowerCase();
      const address = (v.address || '').toLowerCase();
      const target = `${name} ${symbol} ${curator} ${assetSym} ${address}`;
      const matchesTerms = terms.every(term => target.includes(term));
      if (!matchesTerms) return false;
    }

    // 2. Network Filter
    if (explorerFilters.network !== 'all') {
      if (String(v.chainId) !== String(explorerFilters.network)) {
        return false;
      }
    }

    // 3. Asset Filter
    if (explorerFilters.asset !== 'all') {
      if (!matchesAssetFilter(v.asset?.symbol, explorerFilters.asset)) {
        return false;
      }
    }

    // 4. Curator Filter
    if (explorerFilters.curator !== 'all') {
      if (!matchesCuratorFilter(v, explorerFilters.curator)) {
        return false;
      }
    }

    return true;
  });

  // Sort Results
  results.sort((a, b) => {
    if (explorerFilters.sort === 'apy_desc') {
      return (b.netApy || 0) - (a.netApy || 0);
    }
    if (explorerFilters.sort === 'liq_desc') {
      return (b.liquidityUsd || 0) - (a.liquidityUsd || 0);
    }
    if (explorerFilters.sort === 'mqi_asc') {
      return mqiSortKey(a) - mqiSortKey(b);
    }
    if (explorerFilters.sort === 'mqi_desc') {
      return mqiSortKey(b) - mqiSortKey(a);
    }
    // Default: Total Deposits (TVL)
    return (b.totalAssetsUsd || 0) - (a.totalAssetsUsd || 0);
  });

  if (DOM.explorerCount) {
    if (isFiltered) {
      DOM.explorerCount.textContent = `${results.length} / ${allVaults.length} Vaults`;
    } else {
      DOM.explorerCount.textContent = `${results.length} Vaults`;
    }
  }

  // 3D sphere highlighting
  if (explorerFilters.query && results.length > 0) {
    sphere.highlightVault(results[0].address);
  } else {
    sphere.highlightVault(null);
  }

  if (results.length === 0) {
    const emptyMsg = explorerFilters.pinnedOnly
      ? 'No pinned vaults yet. Tap the star icon on any vault card or in the audit view to add it to favorites.'
      : 'No vaults match your filter criteria. Try resetting filters.';
    const [emptyTitle, ...emptyHint] = emptyMsg.split('. ');
    DOM.explorerVaultsList.innerHTML = `
      <li class="explorer-empty">
        <span class="explorer-empty-title">${emptyTitle}</span>
        <span class="explorer-empty-hint">${emptyHint.join('. ')}</span>
      </li>
    `;
    return;
  }

  // Rows are built in chunks: the first screenful at once, the rest while the browser is idle,
  // so a filter or sort change never blocks a frame for hundreds of rows
  const buildRow = (v) => {
    const li = document.createElement('li');
    li.className = 'explorer-vault-item';
    li.setAttribute('data-address', v.address);
    // Not role="button": the row contains its own star button, and nested interactive content is invalid
    li.tabIndex = 0;

    const chainName = formatChainName(v.chainId);
    const chainClass = getChainClass(v.chainId);
    const assetSym = v.asset?.symbol || '';
    const curator = formatCuratorName(v.curatorName, v.name);
    const tvl = v.totalAssetsUsd || v.liquidityUsd || 0;
    const apy = v.netApy || 0;
    const mqi = v.mqiPercent;
    const isClean = mqi !== null && (v.isAllClean ?? ((mqi ?? 100) === 100));
    const isPinned = isVaultPinned(v.address, pinnedSet);
    const apyClass = apy < 0 ? 'negative' : '';

    const flaggedLabel = mqi === null ? (v.isUnpriced ? 'Unpriced' : 'Unverified')
      : v.compromisedCount > 0
        ? (v.compromisedPercent > 0 ? `${v.compromisedPercent}% Flagged` : `${v.compromisedCount} Flagged`)
        : (v.unverifiedPercent > 0 ? `${v.unverifiedPercent}% Unverified` : 'Unverified');
    const flaggedBadgeHtml = !isClean
      ? `<span class="vault-mini-badge flagged">${flaggedLabel}</span>`
      : '';

    li.innerHTML = `
      <button type="button" class="vault-item-star-btn ${isPinned ? 'active' : ''}" data-pin-addr="${escapeHtml(v.address)}" title="${isPinned ? 'Unpin from favorites' : 'Pin to favorites'}" aria-label="${isPinned ? 'Unpin' : 'Pin'} ${escapeHtml(v.name)}" aria-pressed="${isPinned}">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="${isPinned ? '#ffffff' : 'none'}" stroke="${isPinned ? '#ffffff' : 'rgba(255,255,255,0.45)'}" stroke-width="1.75">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
        </svg>
      </button>
      <span class="vault-item-name-cell">
        <span class="vault-item-name" title="${escapeHtml(v.name)}">${escapeHtml(v.name)}</span>
        <span class="vault-item-sub"><span class="vault-item-chain-inline">${escapeHtml(chainName)}</span><span class="vault-item-asset">${escapeHtml(assetSym)}</span>${flaggedBadgeHtml}</span>
      </span>
      <span class="vault-item-meta">
        <span class="vault-chain-badge ${chainClass}">${escapeHtml(chainName)}</span>
        <span class="vault-item-curator" title="${escapeHtml(curator)}">${escapeHtml(curator)}</span>
      </span>
      <span class="vault-item-tvl">${formatCurrency(tvl)}</span>
      <span class="vault-item-apy ${apyClass}">${formatPercent(apy)} APY</span>
    `;

    const starBtn = li.querySelector('.vault-item-star-btn');
    if (starBtn) {
      starBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePinVault(v.address);
      });
    }

    li.addEventListener('mouseenter', () => {
      sphere.highlightVault(v.address);
    });

    li.addEventListener('mouseleave', () => {
      if (!explorerFilters.query) {
        sphere.highlightVault(null);
      }
    });

    li.addEventListener('click', () => {
      const pos = sphere.getParticleScreenPos(v.address);
      openVaultAudit(v, pos);
    });

    li.addEventListener('keydown', (e) => {
      if (e.target !== li) return; // keys pressed on the inner star button belong to the star
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const pos = sphere.getParticleScreenPos(v.address);
        openVaultAudit(v, pos);
      }
    });

    return li;
  };

  const token = ++explorerRenderToken;
  const appendRows = (from, to) => {
    const fragment = document.createDocumentFragment();
    for (let i = from; i < to; i++) fragment.appendChild(buildRow(results[i]));
    DOM.explorerVaultsList.appendChild(fragment);
    // The saved scroll position is restored as soon as enough rows exist for it
    if (DOM.vaultExplorerWidget && DOM.vaultExplorerWidget.scrollTop < savedScrollTop) DOM.vaultExplorerWidget.scrollTop = savedScrollTop;
    markSelectedRow(document.body.classList.contains('audit-open') ? selectedVaultAddress : null);
  };
  const nextChunk = (from) => {
    if (token !== explorerRenderToken || from >= results.length) return;
    appendRows(from, Math.min(from + EXPLORER_CHUNK, results.length));
    setTimeout(() => nextChunk(from + EXPLORER_CHUNK), 0);
  };
  const first = Math.min(EXPLORER_FIRST_ROWS, results.length);
  appendRows(0, first);
  nextChunk(first);
}

/** Marks the table row of the vault whose audit is open. */
function markSelectedRow(address) {
  const list = DOM.explorerVaultsList;
  if (!list?.querySelectorAll) return;
  list.querySelectorAll('.explorer-vault-item.is-selected').forEach(el => el.classList.remove('is-selected'));
  if (!address) return;
  const key = address.toLowerCase();
  [...list.querySelectorAll('[data-address]')].find(el => (el.getAttribute('data-address') || '').toLowerCase() === key)?.classList.add('is-selected');
}

/** Width in px a CSS length variable resolves to (media queries and clamp() included). */
function measureCssWidth(varName, fallback) {
  const probe = document.createElement('div');
  probe.style.cssText = `position:fixed;visibility:hidden;pointer-events:none;width:var(${varName})`;
  document.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return width > 0 ? width : fallback;
}

/** Viewport box of the audit panel (it stays measurable while hidden): where the flying ball unfolds to. */
function getAuditPanelRect() {
  const r = DOM.auditModal.getBoundingClientRect();
  const radius = getComputedStyle(DOM.auditModal).borderTopLeftRadius || '16px';
  return { left: r.left, top: r.top, width: r.width, height: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, radius };
}

/**
 * Puts the sphere in the free area next to the ledger (home) or next to the audit panel (audit open).
 */
function applySphereLayout(immediate = false, open = document.body.classList.contains('audit-open'), ms) {
  if (!sphere?.setLayout || window.innerWidth <= 768) return; // phones have no sphere
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const auditOpen = open;

  const left = auditOpen
    ? (() => { const r = getAuditPanelRect(); return r.left + r.width + 12; })()
    : measureCssWidth('--ledger-w', 760);
  const regionWidth = Math.max(0, vw - left);
  const radius = Math.max(60, Math.min(regionWidth * 0.43, vh * 0.42));
  sphere.setLayout(left + Math.max(regionWidth, radius * 2) / 2, vh / 2, radius, immediate, ms);
}

/** Switches the page between home and audit layout: the ledger narrows, the sphere moves, the row is marked. */
function setAuditLayout(open, ms) {
  setLedgerCompact(open);
  applySphereLayout(false, open, ms);
}

/** Narrows or widens the ledger (CSS animates the width): the ball always lands on free space. */
function setLedgerCompact(open) {
  document.body.classList.toggle('audit-open', open);
  markSelectedRow(open ? selectedVaultAddress : null);
}


/**
 * Instantly pre-populates vault identity, badges, financials, and specifications
 * from the client-cached vault object so UI never opens empty or delayed.
 */
function populateBasicVaultInfo(v) {
  if (!v) return;

  const chainName = formatChainName(v.chainId);
  const chainClass = getChainClass(v.chainId);

  if (DOM.modalChainBadge) {
    DOM.modalChainBadge.textContent = chainName;
    DOM.modalChainBadge.className = `badge badge-chain ${chainClass}`;
  }
  if (DOM.modalVersionBadge) {
    DOM.modalVersionBadge.textContent = (v.version || 'V1').toUpperCase();
  }
  if (DOM.modalListedBadge) {
    DOM.modalListedBadge.textContent = v.isListed ? 'LISTED' : 'UNLISTED';
    DOM.modalListedBadge.className = `badge ${v.isListed ? 'badge-listed' : 'badge-chain'}`;
  }

  if (DOM.modalVaultName) DOM.modalVaultName.textContent = v.name || 'Morpho Vault';
  if (DOM.modalCuratorName) DOM.modalCuratorName.textContent = formatCuratorName(v.curatorName, v.name);

  // Financials
  if (DOM.modalTvl) DOM.modalTvl.textContent = formatCurrency(v.totalAssetsUsd);
  if (DOM.modalAssetsHuman) {
    let tokenAmount = 0;
    if (v.totalAssets) {
      tokenAmount = Number(v.totalAssets) / Math.pow(10, v.asset?.decimals ?? 6);
    } else {
      const price = v.asset?.priceUsd ?? 1;
      tokenAmount = price > 0 ? (v.totalAssetsUsd || 0) / price : 0;
    }
    DOM.modalAssetsHuman.textContent = `${formatNumber(tokenAmount)} ${v.asset?.symbol || ''}`;
  }
  if (DOM.modalLiq) DOM.modalLiq.textContent = formatCurrency(v.liquidityUsd);
  if (DOM.modalExitCapPct && v.exitCapPercent !== undefined) {
    DOM.modalExitCapPct.textContent = formatExitCap(exitMetric(v.exitCapPercent));
  }
  if (DOM.modalNetApy) DOM.modalNetApy.textContent = formatPercent(v.netApy || 0);
  if (DOM.modalFee) DOM.modalFee.textContent = `Fee: ${((v.fee || 0) * 100).toFixed(1)}%`;
  if (DOM.modalGrade && v.mqiPercent !== undefined) {
    DOM.modalGrade.textContent = v.mqiPercent === null ? 'N/A' : `${v.mqiPercent}%`;
    DOM.modalGrade.dataset.tone = v.mqiPercent === null ? 'bad' : (v.mqiPercent === 100 && v.isAllClean !== false ? 'ok' : (v.mqiPercent >= 80 ? 'warn' : 'bad'));
  }
}

/**
 * Executes the two-stage particle flight and unfold into the Left Floating Terminal.
 * Stage 1: The highlighted orb shoots out across 3D space to the left dock as a ball.
 * Stage 2: Upon arriving at the left side, it smoothly unfolds into the full window panel.
 * Instant Pre-population & In-Memory Cache ensure zero data loading lag.
 */
/**
 * Resets the half-open state left by a failed audit request and tells the user.
 */
function abortFailedAuditOpen() {
  selectedVaultAddress = null;
  isTransitioningVault = false;
  isClosingAudit = false;
  sphere.setSelectedVault(null);
  sphere.highlightVault(null);
  renderPinnedRichPills();
  setAuditLayout(false);
  showStatusNotice('Audit unavailable, try again');
}

let focusBeforeAudit = null;
let isClosingAudit = false;
let auditOpenToken = 0;
let auditAbort = null;

/** Moves keyboard focus into the audit dialog once it is visible. */
function focusAuditModal() {
  document.getElementById('modal-close-btn')?.focus();
}

/** Puts focus back where it was before the audit opened (the row may have been re-rendered since). */
function restoreFocusAfterAudit() {
  const target = focusBeforeAudit;
  focusBeforeAudit = null;
  if (!target) return;
  let el = target.el && document.contains(target.el) ? target.el : null;
  if (!el && target.address && DOM.explorerVaultsList) {
    el = [...DOM.explorerVaultsList.querySelectorAll('[data-address]')].find(n => n.dataset.address === target.address) || null;
  }
  el?.focus?.();
}

/** If a newer audit landed in the cache while the modal was animating in, show it instead of the older data. */
function syncModalWithCache(address, shownData) {
  const latest = clientAuditCache.get((address || '').toLowerCase());
  if (latest && latest !== shownData) {
    activeAuditData = latest;
    populateAuditModal(latest, true);
  }
}

/** Escape while an audit is still loading: abort the request and undo the opening state. */
function cancelPendingAuditOpen() {
  auditOpenToken++;
  auditAbort?.abort();
  DOM.morphProxy?.classList.add('hidden');
  DOM.morphProxyRetract?.classList.add('hidden');
  DOM.auditModal.classList.add('hidden');
  selectedVaultAddress = null;
  isTransitioningVault = false;
  sphere.setSelectedVault(null);
  sphere.highlightVault(null);
  renderPinnedRichPills();
  setAuditLayout(false);
  restoreFocusAfterAudit();
}

/**
 * Opens the audit for a vault. Any failure after the transition started (bad payload, render error)
 * resets the UI instead of leaving it stuck in the transitioning state.
 */
async function openVaultAudit(vault, startPos) {
  if (isTransitioningVault) return;
  const token = ++auditOpenToken;
  try {
    await openVaultAuditFlow(vault, startPos, token);
  } catch (err) {
    console.error('Failed to open vault audit:', err);
    if (token === auditOpenToken) {
      DOM.morphProxy?.classList.add('hidden');
      DOM.morphProxyRetract?.classList.add('hidden');
      abortFailedAuditOpen();
    }
  }
}

async function openVaultAuditFlow(vault, startPos, token) {
  if (isTransitioningVault) return;

  // If clicking the currently open vault, do nothing
  if (selectedVaultAddress && selectedVaultAddress.toLowerCase() === vault.address.toLowerCase() && !DOM.auditModal.classList.contains('hidden')) {
    return;
  }

  DOM.tooltip.classList.add('hidden');
  if (DOM.auditModal.classList.contains('hidden')) {
    const active = document.activeElement;
    focusBeforeAudit = { el: active, address: active?.closest?.('[data-address]')?.dataset.address || null };
  }

  // 1. Instant Synchronous Pre-population (0ms latency: badges, TVL, APY, specs appear immediately)
  const cacheKey = (vault.address || '').toLowerCase();
  const cachedData = clientAuditCache.get(cacheKey);
  const initialVaultObj = cachedData?.vault ? Object.assign({}, vault, cachedData.vault, {
    mqiPercent: firstDefined(cachedData.verdict?.mqi?.mqiPercent, vault.mqiPercent),
    exitCapPercent: pickExitMetric(cachedData.verdict?.liquidity?.instantExitCapacityPercent, vault.exitCapPercent)
  }) : vault;
  populateBasicVaultInfo(initialVaultObj);

  // 2. Fetch full audit data with client-side in-memory caching and background revalidation
  let auditDataPromise;
  const freshCached = getFreshAudit(cacheKey);
  if (freshCached) {
    auditDataPromise = Promise.resolve(freshCached);
    apiFetch(`/api/vaults/${vault.address}`)
      .then(res => res.ok ? res.json() : null)
      .then(freshData => {
        if (freshData) applyVaultAuditData(vault.address, freshData);
      })
      .catch(() => {});
  } else {
    auditAbort = new AbortController();
    auditDataPromise = apiFetch(`/api/vaults/${vault.address}`, 8000, auditAbort.signal)
      .then(res => {
        if (!res.ok) throw new Error('Vault audit data not found');
        return res.json();
      })
      .then(data => {
        if (!data?.vault || !data?.verdict) throw new Error('Malformed audit payload');
        applyVaultAuditData(vault.address, data);
        return data;
      })
      .catch(err => {
        if (err.name !== 'AbortError') console.error('Error fetching vault audit:', err);
        return null;
      });
  }

  isTransitioningVault = true;

  const isMobile = window.innerWidth <= 768;

  // On Mobile (or with reduced motion): show the panel directly, without the 3D sphere proxy animation
  if (isMobile || REDUCED_MOTION.matches) {
    selectedVaultAddress = vault.address;
    if (!isMobile) sphere.setSelectedVault(vault.address);
    if (DOM.pinnedRichPills) {
      DOM.pinnedRichPills.classList.add('hidden');
    }
    setAuditLayout(true);

    const data = await auditDataPromise;
    if (token !== auditOpenToken) return; // cancelled with Escape while loading
    if (!data) {
      abortFailedAuditOpen();
      return;
    }

    activeAuditData = data;
    populateAuditModal(data);
    DOM.auditModal.classList.remove('hidden');
    focusAuditModal();
    syncModalWithCache(vault.address, data);
    isTransitioningVault = false;
    return;
  }

  // Target coordinates for Left Floating Terminal (Desktop)
  const panelRect = getAuditPanelRect();
  const targetWidth = panelRect.width;
  const targetHeight = panelRect.height;
  const targetCenterX = panelRect.cx;
  const targetCenterY = panelRect.cy;
  const targetRadius = panelRect.radius;

  // Check if a vault window is ALREADY open
  const isAlreadyOpen = selectedVaultAddress && !DOM.auditModal.classList.contains('hidden');
  const prevVaultAddress = selectedVaultAddress;

  // Immediately activate compact beacon on sphere for the new vault
  selectedVaultAddress = vault.address;
  sphere.setSelectedVault(vault.address);

  // Hide pinned rich pills container while audit modal is open
  if (DOM.pinnedRichPills) {
    DOM.pinnedRichPills.classList.add('hidden');
  }

  // The ledger narrows and the sphere moves aside while the ball flies, so it lands on free space
  setAuditLayout(true);

  // --- A. RETRACTING ANIMATION (If previous vault was open) ---
  if (isAlreadyOpen && DOM.morphProxyRetract) {
    let prevPos = prevVaultAddress ? sphere.getParticleScreenPos(prevVaultAddress) : null;
    if (!prevPos) {
      prevPos = {
        x: isMobile ? window.innerWidth * 0.5 : window.innerWidth * 0.45,
        y: isMobile ? window.innerHeight * 0.28 : window.innerHeight * 0.5
      };
    }

    // Hide static panel immediately so user sees the folding proxy
    DOM.auditModal.classList.add('hidden');

    const pRetract = DOM.morphProxyRetract;
    pRetract.style.transition = 'none';
    pRetract.style.left = `${targetCenterX}px`;
    pRetract.style.top = `${targetCenterY}px`;
    pRetract.style.width = `${targetWidth}px`;
    pRetract.style.height = `${targetHeight}px`;
    pRetract.style.borderRadius = targetRadius;
    pRetract.style.opacity = '0.88';
    pRetract.style.background = 'oklch(0.15 0.004 260 / 0.88)';
    pRetract.style.border = '1px solid rgba(255, 255, 255, 0.12)';
    pRetract.style.boxShadow = 'none';
    pRetract.classList.remove('hidden');

    // Stage 1: Fold window down into a ball at left dock (220ms)
    requestAnimationFrame(() => {
      pRetract.style.transition = 'width 220ms cubic-bezier(0.2, 0.9, 0.3, 1), height 220ms cubic-bezier(0.2, 0.9, 0.3, 1), border-radius 220ms, background 220ms';
      pRetract.style.width = '12px';
      pRetract.style.height = '12px';
      pRetract.style.borderRadius = '50%';
      pRetract.style.background = '#ffffff';
      pRetract.style.boxShadow = '0 0 16px rgba(255, 255, 255, 0.6)';
    });

    // Stage 2: Ball shoots across 3D space back to sphere particle (440ms)
    setTimeout(() => {
      const livePrevPos = prevVaultAddress ? sphere.getParticleScreenPos(prevVaultAddress) : prevPos;
      pRetract.style.transition = 'left 440ms cubic-bezier(0.16, 1, 0.3, 1), top 440ms cubic-bezier(0.16, 1, 0.3, 1), opacity 440ms';
      pRetract.style.left = `${livePrevPos.x}px`;
      pRetract.style.top = `${livePrevPos.y}px`;
      pRetract.style.opacity = '0';

      setTimeout(() => {
        pRetract.classList.add('hidden');
      }, 450);
    }, 210);
  } else {
    DOM.auditModal.classList.add('hidden');
  }

  // --- B. ADVANCING ANIMATION (Ball shoots out from sphere -> unfolds into window) ---
  let startX = startPos ? startPos.x : null;
  let startY = startPos ? startPos.y : null;
  if (!startX || !startY) {
    const pPos = sphere.getParticleScreenPos(vault.address);
    if (pPos) {
      startX = pPos.x;
      startY = pPos.y;
    } else {
      startX = isMobile ? window.innerWidth * 0.5 : window.innerWidth * 0.45;
      startY = isMobile ? window.innerHeight * 0.28 : window.innerHeight * 0.5;
    }
  }

  const pOpen = DOM.morphProxy;
  pOpen.style.transition = 'none';
  pOpen.style.left = `${startX}px`;
  pOpen.style.top = `${startY}px`;
  pOpen.style.width = '14px';
  pOpen.style.height = '14px';
  pOpen.style.borderRadius = '50%';
  pOpen.style.opacity = '1';
  pOpen.style.background = '#ffffff';
  pOpen.style.border = '1px solid rgba(255, 255, 255, 0.6)';
  pOpen.style.boxShadow = '0 0 16px rgba(255, 255, 255, 0.5), 0 0 32px rgba(255, 255, 255, 0.2)';
  pOpen.classList.remove('hidden');

  // Stage 1: Ball flies out across 3D space to the left dock position (440ms)
  requestAnimationFrame(() => {
    pOpen.style.transition = 'left 440ms cubic-bezier(0.16, 1, 0.3, 1), top 440ms cubic-bezier(0.16, 1, 0.3, 1)';
    pOpen.style.left = `${targetCenterX}px`;
    pOpen.style.top = `${targetCenterY}px`;
  });
  // (Notice: width, height, borderRadius stay circular during flight!)

  // Stage 2: Upon arriving at left dock, ball unfolds into the full rectangular window (300ms)
  setTimeout(() => {
    pOpen.style.transition = 'width 300ms cubic-bezier(0.16, 1, 0.3, 1), height 300ms cubic-bezier(0.16, 1, 0.3, 1), border-radius 300ms cubic-bezier(0.16, 1, 0.3, 1), background 300ms, border-color 300ms';
    pOpen.style.width = `${targetWidth}px`;
    pOpen.style.height = `${targetHeight}px`;
    pOpen.style.borderRadius = targetRadius;
    pOpen.style.background = 'oklch(0.15 0.004 260 / 0.88)';
    pOpen.style.border = '1px solid rgba(255, 255, 255, 0.14)';
    pOpen.style.boxShadow = 'none';
  }, 420);

  const animStartTime = Date.now();

  // Simultaneously resolve audit data and finish population
  const data = await auditDataPromise;
  if (token !== auditOpenToken) return; // cancelled with Escape while loading
  if (!data) {
    pOpen.classList.add('hidden');
    abortFailedAuditOpen();
    return;
  }

  activeAuditData = data;
  populateAuditModal(data);

  // Stage 3: Smooth docking reveal when unfold completes (synchronized with 720ms animation)
  const elapsed = Date.now() - animStartTime;
  const remainingDelay = Math.max(0, 720 - elapsed);

  setTimeout(() => {
    if (token !== auditOpenToken) return;
    DOM.auditModal.classList.remove('hidden');
    focusAuditModal();
    syncModalWithCache(vault.address, data);
    pOpen.style.opacity = '0';
    setTimeout(() => {
      pOpen.classList.add('hidden');
      if (token === auditOpenToken) isTransitioningVault = false;
    }, 220);
  }, remainingDelay);
}


/**
 * Closes the audit: the panel disappears, the ledger widens back, the sphere returns home.
 */
function closeVaultAudit() {
  if (DOM.auditModal.classList.contains('hidden') || isClosingAudit) return;

  // The panel disappears first, then the ledger widens (CSS animates the width); no ball flies back
  DOM.auditModal.classList.add('hidden');
  selectedVaultAddress = null;
  isTransitioningVault = false;
  setAuditLayout(false);
  if (window.innerWidth > 768) {
    sphere.setSelectedVault(null);
    sphere.highlightVault(null);
    renderPinnedRichPills();
  }
  restoreFocusAfterAudit();
}

/**
 * Current audit modal exit capacity state for interactive stressed inspection
 */
let currentModalExitState = {
  normalExitPct: 0,
  normalExitUsd: 0,
  stressedExitPct: 0,
  stressedExitUsd: 0,
  dropPct: 0,
  topPeer: ''
};

/** Opens or closes the worst-case exit popover, keeping aria-expanded in sync. */
function setExitInfoActive(active) {
  if (!DOM.riskExitInfoBtn) return;
  DOM.riskExitInfoBtn.classList.toggle('active', active);
  DOM.riskExitInfoBtn.setAttribute('aria-expanded', String(active));
  updateStressedExitDisplay(active);
}

function updateStressedExitDisplay(isStressed) {
  if (!DOM.riskExitBar || !DOM.riskExitPct) return;
  const { normalExitPct, normalExitUsd, stressedExitPct, stressedExitUsd, dropPct } = currentModalExitState;

  // Unknown liquidity: an empty neutral bar, never a full (safe-looking) one
  if (normalExitPct === null) {
    DOM.riskExitBar.style.width = '0%';
    DOM.riskExitBar.dataset.tone = '';
    DOM.riskExitPct.textContent = 'N/A';
    if (DOM.riskExitDesc) DOM.riskExitDesc.textContent = 'Exit liquidity unknown: no liquidity data for this vault';
    return;
  }

  if (isStressed && stressedExitPct !== null) {
    DOM.riskExitBar.style.width = `${Math.min(100, stressedExitPct)}%`;
    DOM.riskExitBar.dataset.tone = stressedExitPct < 15 ? 'bad' : (dropPct > 0 ? 'warn' : '');
    if (dropPct > 0) {
      DOM.riskExitPct.innerHTML = `<span class="exit-stressed-tag">STRESSED:</span>${stressedExitPct}%`;
      if (DOM.riskExitDesc) {
        DOM.riskExitDesc.innerHTML = `<span class="exit-stressed-usd">${formatCurrency(stressedExitUsd)}</span> available during a mass withdrawal (bank run)`;
      }
    }
  } else {
    DOM.riskExitBar.style.width = `${Math.min(100, normalExitPct)}%`;
    DOM.riskExitBar.dataset.tone = '';
    DOM.riskExitPct.textContent = `${normalExitPct}%`;
    if (DOM.riskExitDesc) {
      DOM.riskExitDesc.textContent = `${formatCurrency(normalExitUsd)} available for immediate withdrawal without locking markets`;
    }
  }
}

// Facts per collateral token come from GET /api/tokens/:chainId/:address; one request per token, cached for the page's life
const tokenFactsCache = new Map();

/** Empty slot under a collateral token; loadTokenFacts() fills it. */
function tokenFactsPlaceholder(chainId, address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address ?? ''))) return '';
  return `<div class="token-facts" data-chain="${escapeHtml(chainId)}" data-address="${escapeHtml(address)}">token data loading</div>`;
}

/**
 * Compact facts of one token: what the sources state, no rating. Each line is skipped when its values are unknown (null).
 * @param {object|null} t Response of the token API; null when nothing has been collected yet
 */
function tokenFactsHtml(t) {
  if (!t || !t.data) return 'no token data collected yet';
  const d = t.data;
  const fn = d.contract?.fn || {};
  const can = [['mint', 'mint'], ['blacklist', 'blacklist'], ['freeze', 'freeze'], ['pause', 'pause'], ['upgrade', 'upgrade']].filter(([k]) => fn[k] === true).map(([, l]) => l);
  const ctrl = d.control?.controllers?.[0];
  const owner = ctrl && `${ctrl.role}: ${ctrl.safe ? `Safe ${ctrl.safe.threshold} of ${ctrl.safe.owner_count}` : ctrl.is_contract ? 'contract' : 'single key'}`;
  const swap = d.liquidity?.kyber?.['1000000'];
  const lines = [
    [d.contract?.sourcify_match || d.contract?.blockscout_verified ? 'source verified' : null,
      d.holders?.top10_pct != null ? `top 10 holders ${d.holders.top10_pct}%` : null,
      swap?.status === 'ok' && swap.price_impact_pct != null ? `$1M swap impact ${swap.price_impact_pct}%` : swap?.status === 'no_route' ? 'no swap route' : null],
    [can.length ? `can ${can.join(', ')}` : null, owner],
    [d.rwa?.issuer ? `issuer ${d.rwa.issuer}` : null, d.pendle?.days_to_expiry != null ? `expires in ${d.pendle.days_to_expiry} days` : null]
  ].map(parts => parts.filter(Boolean)).filter(parts => parts.length);
  const stamp = `data ${Math.round((t.coverage ?? 0) * 100)}%, ${new Date((t.collectedAt || 0) * 1000).toISOString().slice(0, 10)}${t.stale ? ', stale' : ''}`;
  return [...lines.map(parts => escapeHtml(parts.join(' · '))), `<span style="opacity:0.7;">${escapeHtml(stamp)}</span>`].join('<br>');
}

/** Fills the token slots found under `root`. A failed request leaves a short note, never an error. */
function loadTokenFacts(root) {
  root.querySelectorAll('.token-facts').forEach(el => {
    const key = `${el.dataset.chain}/${el.dataset.address}`;
    if (!tokenFactsCache.has(key)) {
      tokenFactsCache.set(key, apiFetch(`/api/tokens/${key}`)
        .then(r => (r.status === 404 ? null : r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .catch(() => { tokenFactsCache.delete(key); return undefined; }));
    }
    tokenFactsCache.get(key).then(t => { el.innerHTML = t === undefined ? 'token data unavailable' : tokenFactsHtml(t); });
  });
}

/**
 * Populates all fields across Panel 1, Panel 2, and Panel 3.
 */
function populateAuditModal(data, isQuietRefresh = false) {
  const v = data.vault;
  const verdict = data.verdict;
  const allocations = data.allocations || [];

  // --- PANEL 1: MAIN ---
  const chainName = formatChainName(v.chainId);
  const chainClass = getChainClass(v.chainId);
  DOM.modalChainBadge.textContent = chainName;
  DOM.modalChainBadge.className = `badge badge-chain ${chainClass}`;
  DOM.modalVersionBadge.textContent = (v.version || 'V1').toUpperCase();
  DOM.modalListedBadge.textContent = v.isListed ? 'LISTED' : 'UNLISTED';
  DOM.modalListedBadge.className = `badge ${v.isListed ? 'badge-listed' : 'badge-chain'}`;

  // Update favorite star button state
  updateFavBtnUI(v.address);

  DOM.modalVaultName.textContent = v.name;
  DOM.modalCuratorName.textContent = formatCuratorName(v.curatorName, v.name);

  // Market Quality Index (MQI) Header Pill
  const mqiUnknown = verdict.mqi?.mqiPercent === null;
  const mqiVal = verdict.mqi?.mqiPercent ?? 100;
  DOM.modalGrade.textContent = mqiUnknown ? 'N/A' : `${mqiVal}%`;
  // mqiPercent is rounded to 0.1, so 100 can still come with flagged (small but material) markets
  const flaggedMarketCount = verdict.mqi?.compromisedMarkets?.length || 0;
  const isFullyClean = Boolean(verdict.mqi?.isAllClean);
  const unresolvedPct = verdict.mqi?.unverifiedPercent ?? 0;
  const compromisedPct = verdict.mqi?.compromisedPercent ?? 0;
  DOM.modalScore.textContent = mqiUnknown
    ? (verdict.mqi?.unpriced ? 'Unpriced Vault' : 'Unverified')
    : isFullyClean
      ? 'Clean Capital'
      : flaggedMarketCount > 0
        ? (compromisedPct > 0 ? `${compromisedPct}% Flagged` : `${flaggedMarketCount} Flagged Market${flaggedMarketCount === 1 ? '' : 's'}`)
        : `${unresolvedPct}% Unverified`;
  DOM.modalGrade.dataset.tone = mqiUnknown
    ? 'bad'
    : mqiVal === 100
      ? (isFullyClean ? 'ok' : 'warn')
      : (mqiVal >= 80 ? 'warn' : 'bad');

  // Financials
  DOM.modalTvl.textContent = formatCurrency(v.totalAssetsUsd);
  const humanAssets = v.totalAssetsHuman !== undefined
    ? v.totalAssetsHuman
    : (v.totalAssets ? Number(v.totalAssets) / Math.pow(10, v.asset?.decimals ?? 6) : 0);
  DOM.modalAssetsHuman.textContent = `${formatNumber(humanAssets)} ${v.asset?.symbol || ''}`;
  DOM.modalLiq.textContent = formatCurrency(v.liquidityUsd);
  DOM.modalExitCapPct.textContent = formatExitCap(pickExitMetric(verdict.liquidity?.instantExitCapacityPercent, 0));
  DOM.modalNetApy.textContent = formatPercent(v.netApy || 0);
  DOM.modalFee.textContent = `Fee: ${((v.fee || 0) * 100).toFixed(1)}%`;

  // Underlying Markets Count Pill
  if (DOM.overviewMarketsCount) {
    const count = allocations.length;
    DOM.overviewMarketsCount.textContent = `${count} MARKET${count === 1 ? '' : 'S'}`;
  }

  // --- PANEL 2: PORTFOLIO AUDIT (MQI & HHI & EXIT) ---
  // 1. MQI
  if (DOM.riskMqiPct) DOM.riskMqiPct.textContent = mqiUnknown ? 'N/A' : `${mqiVal}%`;
  if (DOM.riskMqiBar) DOM.riskMqiBar.style.width = mqiUnknown ? '0%' : `${mqiVal}%`;
  if (DOM.riskMqiDesc) {
    const unresolvedUsd = verdict.mqi?.unverifiedAssetsUsd || 0;
    DOM.riskMqiDesc.textContent = mqiUnknown
      ? (verdict.mqi?.unpriced
        ? 'The vault has no USD price, so the quality of its capital cannot be measured'
        : 'None of the capital could be verified yet, so there is no score')
      : verdict.mqi?.isAllClean
      ? '100% of capital is deployed in verified, non-defaulted markets'
      : unresolvedUsd > 0 && !(verdict.mqi?.compromisedMarkets?.length)
        ? `${formatCurrency(unresolvedUsd)} is unverified (data missing or not expanded) and left out of the score`
        : `${verdict.mqi?.compromisedMarkets?.length || 0} market(s) with verification or debt issues detected`;
  }

  // 2. Collateral breakdown by token
  const mix = verdict.collateral || {};
  const mixTokens = mix.tokens || [];
  const isUnallocated = mix.tier === 'UNALLOCATED' || mix.tier === 'UNKNOWN';

  // 3. Exit Liquidity & Stressed Interaction
  // null = backend has no liquidity data for this vault; an absent field keeps the old 0 default
  const normalExitPct = pickExitMetric(verdict.liquidity?.instantExitCapacityPercent, 0);
  const normalExitUsd = verdict.liquidity?.instantExitCapacityUsd || 0;
  const stressedExitPct = pickExitMetric(verdict.liquidity?.stressedExitCapacityPercent, normalExitPct);
  const stressedExitUsd = verdict.liquidity?.stressedExitCapacityUsd ?? normalExitUsd;
  const exitUnknown = normalExitPct === null || stressedExitPct === null;
  const dropPct = exitUnknown ? 0 : Math.max(0, Math.round((normalExitPct - stressedExitPct) * 10) / 10);
  const topPeer = verdict.liquidity?.crowdedMarkets?.[0]?.topPeers?.[0] || 'competing vaults';

  currentModalExitState = {
    normalExitPct,
    normalExitUsd,
    stressedExitPct,
    stressedExitUsd,
    dropPct,
    topPeer
  };

  if (DOM.riskExitInfoBtn) {
    DOM.riskExitInfoBtn.classList.remove('active');
    DOM.riskExitInfoBtn.setAttribute('aria-expanded', 'false');
  }

  // Update Popover content
  if (DOM.riskExitPopoverBody) {
    if (exitUnknown) {
      DOM.riskExitPopoverBody.textContent = 'Worst-case exit cannot be estimated: liquidity data for this vault is unavailable.';
    } else if (dropPct > 0) {
      DOM.riskExitPopoverBody.innerHTML = `During a mass withdrawal (bank run), competing vaults (${escapeHtml(topPeer)}) claim shared cash, reducing available exit from <strong>${normalExitPct}%</strong> to <strong>${stressedExitPct}%</strong> (${formatCurrency(stressedExitUsd)}).`;
    } else {
      DOM.riskExitPopoverBody.innerHTML = `During a mass withdrawal, available exit remains fully preserved at <strong>${normalExitPct}%</strong> (${formatCurrency(normalExitUsd)}) with no competing vault crowding.`;
    }
  }

  // Initial standard exit display
  updateStressedExitDisplay(false);

  // 4. Collateral Allocation Breakdown
  if (DOM.riskEffectiveAssets) {
    if (isUnallocated) {
      DOM.riskEffectiveAssets.textContent = '0 tokens';
    } else {
      DOM.riskEffectiveAssets.textContent = `${mixTokens.length} token${mixTokens.length === 1 ? '' : 's'}`;
    }
  }
  if (DOM.riskCollateralList) {
    DOM.riskCollateralList.innerHTML = '';
    const breakdown = mixTokens.map(c => ({ label: c.symbol || 'Unknown', usd: c.usd, sharePercent: c.percent }));
    const categories = Object.entries(mix.categoryShares || {}).filter(([, pct]) => pct > 0).sort((a, b) => b[1] - a[1]);
    if (categories.length) {
      const shade = i => (1 - i * 0.17).toFixed(2);
      const bar = categories.map(([cat, pct], i) => `<span class="category-seg" style="flex:${pct}; opacity:${shade(i)};"></span>`).join('');
      const rows = categories.map(([cat, pct], i) => `<li class="category-row"><span class="category-swatch" style="opacity:${shade(i)};"></span><span class="category-name">${escapeHtml(CATEGORY_LABELS[cat] || cat)}</span><span class="category-pct">${pct}%</span></li>`).join('');
      const box = document.createElement('div');
      box.className = 'category-shares';
      box.innerHTML = `<div class="category-bar" role="img" aria-label="Collateral by category">${bar}</div><ul class="category-list">${rows}</ul>`;
      DOM.riskCollateralList.appendChild(box);
    }
    if (breakdown.length === 0) {
      DOM.riskCollateralList.innerHTML = '<span class="collateral-empty">No active collateral backing recorded.</span>';
    } else {
      breakdown.slice(0, 6).forEach(item => {
        const row = document.createElement('div');
        row.className = 'collateral-row';
        row.innerHTML = `
          <span class="collateral-token">${escapeHtml(item.label)}</span>
          <span class="collateral-usd">${formatCurrency(item.usd)} <strong>${item.sharePercent}%</strong></span>
        `;
        DOM.riskCollateralList.appendChild(row);
      });
    }
  }

  // 5. Red Flags
  if (DOM.riskFlagsList) {
    DOM.riskFlagsList.innerHTML = '';
    if (!verdict.redFlags || verdict.redFlags.length === 0) {
      DOM.riskFlagsList.innerHTML = '<div class="flag-item clear">No critical risk flags detected for this vault.</div>';
    } else {
      verdict.redFlags.forEach(flag => {
        const div = document.createElement('div');
        const level = (flag.level || 'info').toLowerCase();
        div.className = `flag-item ${level}`;
        div.innerHTML = `<strong>${escapeHtml(flag.title || '')}:</strong> ${escapeHtml(flag.message || '')}`;
        DOM.riskFlagsList.appendChild(div);
      });
    }
  }


  // Reset mini-tabs to Overview on initial open only
  if (!isQuietRefresh) {
    const navTabs = document.querySelectorAll('.audit-nav-tab');
    const navPanels = document.querySelectorAll('.audit-tab-panel');
    navTabs.forEach(t => {
      const isOverview = t.dataset.tab === 'tab-overview';
      t.classList.toggle('active', isOverview);
      t.setAttribute('aria-selected', isOverview ? 'true' : 'false');
    });
    navPanels.forEach(p => {
      p.classList.toggle('active', p.id === 'tab-overview');
    });
  }

  // Populate Allocations Table
  DOM.allocationsTbody.innerHTML = '';
  if (allocations.length === 0) {
    DOM.allocationsTbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--text-muted);">No active market allocations recorded.</td></tr>';
  } else {
    allocations.forEach(a => {
      const isMarketFlagged = a.isFlagged === true || (a.isFlagged === undefined && !a.isClean && ((a.supplyAssetsUsd || 0) > ((v.totalAssetsUsd || 0) * 0.01)));
      const statusBadge = isMarketFlagged
        ? '<span class="badge badge-status badge-flagged">FLAGGED</span>'
        : a.isUnverified
          ? '<span class="badge badge-status badge-unverified">UNVERIFIED</span>'
          : '<span class="badge badge-listed badge-status badge-clean">CLEAN</span>';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${escapeHtml(a.collateralSymbol || 'None')}</strong></td>
        <td>${a.lltvPercent == null ? 'n/a' : a.lltvPercent + '%'}</td>
        <td>${((a.weight || 0) * 100).toFixed(1)}%</td>
        <td>${formatCurrency(a.supplyAssetsUsd)}</td>
        <td>${formatCurrency(a.marketFreeLiquidityUsd)}</td>
        <td>${statusBadge}</td>
        <td class="green">${((a.supplyApy || 0) * 100).toFixed(2)}%</td>
      `;
      DOM.allocationsTbody.appendChild(tr);
    });
    loadTokenFacts(DOM.allocationsTbody);
  }
}

/**
 * Sets up listeners for modal open/close actions.
 */
function setupModalEvents() {
  if (DOM.closeBtn) DOM.closeBtn.addEventListener('click', closeVaultAudit);

  if (DOM.modalFavBtn) {
    DOM.modalFavBtn.addEventListener('click', () => {
      if (selectedVaultAddress) {
        togglePinVault(selectedVaultAddress);
      }
    });
  }

  // Interactive Stressed Exit Capacity hover & click handlers
  if (DOM.riskExitInfoBtn) {
    DOM.riskExitInfoBtn.addEventListener('mouseenter', () => updateStressedExitDisplay(true));
    DOM.riskExitInfoBtn.addEventListener('mouseleave', () => {
      if (!DOM.riskExitInfoBtn.classList.contains('active')) {
        updateStressedExitDisplay(false);
      }
    });
    DOM.riskExitInfoBtn.addEventListener('focus', () => updateStressedExitDisplay(true));
    DOM.riskExitInfoBtn.addEventListener('blur', () => {
      if (!DOM.riskExitInfoBtn.classList.contains('active')) {
        updateStressedExitDisplay(false);
      }
    });
    DOM.riskExitInfoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setExitInfoActive(!DOM.riskExitInfoBtn.classList.contains('active'));
    });
  }

  if (DOM.riskExitLabel) {
    DOM.riskExitLabel.addEventListener('mouseenter', () => updateStressedExitDisplay(true));
    DOM.riskExitLabel.addEventListener('mouseleave', () => {
      if (!DOM.riskExitInfoBtn || !DOM.riskExitInfoBtn.classList.contains('active')) {
        updateStressedExitDisplay(false);
      }
    });
  }

  document.addEventListener('click', (e) => {
    if (DOM.riskExitInfoBtn && !e.target.closest('.info-circle-wrap')) {
      if (DOM.riskExitInfoBtn.classList.contains('active')) {
        setExitInfoActive(false);
      }
    }
  });

  window.addEventListener('keydown', (e) => {
    // The audit panel is a non-modal dialog (the explorer next to it stays usable), so Tab is not trapped
    if (e.key !== 'Escape') return;

    // 1. Dismiss worst-case exit popover if open
    if (DOM.riskExitInfoBtn && DOM.riskExitInfoBtn.classList.contains('active')) {
      setExitInfoActive(false);
      return;
    }

    // 2. Dismiss any open filter dropdowns and give focus back to their trigger
    const openDropdown = document.querySelector('.custom-dropdown.open');
    if (openDropdown) {
      const openTrigger = openDropdown.querySelector('.dropdown-trigger');
      closeAllDropdowns();
      openTrigger?.focus();
      return;
    }

    // 3. Clear search query if input is focused and contains text
    if (document.activeElement === DOM.searchInput && DOM.searchInput.value) {
      DOM.searchInput.value = '';
      if (DOM.searchClearBtn) DOM.searchClearBtn.classList.add('hidden');
      explorerFilters.query = '';
      renderVaultExplorer();
      DOM.searchInput.blur();
      sphere.highlightVault(null);
      return;
    }

    // 4. Cancel a pending open, or close the audit modal if it is open
    if (isTransitioningVault && !isClosingAudit && DOM.auditModal.classList.contains('hidden')) {
      cancelPendingAuditOpen();
      return;
    }
    if (selectedVaultAddress || !DOM.auditModal.classList.contains('hidden') || isTransitioningVault) {
      closeVaultAudit();
    }
  });
}

/**
 * Sets up mini-tabs navigation inside the left audit terminal (Overview / Risk & Exit / Markets).
 */
function setupAuditNavTabs() {
  const tabs = document.querySelectorAll('.audit-nav-tab');
  const panels = document.querySelectorAll('.audit-tab-panel');
  if (!tabs.length) return;

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetId = tab.dataset.tab;
      tabs.forEach(t => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      panels.forEach(p => p.classList.remove('active'));

      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      const targetPanel = document.getElementById(targetId);
      if (targetPanel) {
        targetPanel.classList.add('active');
      }
    });
  });
}

// Utility Formatter Functions
function formatCurrency(val, fallback = '—') {
  if (val === null || val === undefined || val === '') return fallback;
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  const isNegative = num < 0;
  const abs = Math.abs(num);
  const prefix = isNegative ? '-$' : '$';
  if (abs >= 999.95e9) return `${prefix}${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 999.95e6) return `${prefix}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 999.95e3) return `${prefix}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 999.95) return `${prefix}${(abs / 1e3).toFixed(1)}K`;
  if (abs > 0 && abs < 0.01) return isNegative ? '> -$0.01' : '< $0.01';
  return `${prefix}${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatNumber(val, fallback = '—') {
  if (val === null || val === undefined || val === '') return fallback;
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  const isNegative = num < 0;
  const abs = Math.abs(num);
  const prefix = isNegative ? '-' : '';
  if (abs >= 999.95e9) return `${prefix}${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 999.95e6) return `${prefix}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 999.95e3) return `${prefix}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 999.95) return `${prefix}${(abs / 1e3).toFixed(1)}K`;
  return `${prefix}${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPercent(val, decimals = 2, fallback = '—') {
  if (val === null || val === undefined || val === '') return fallback;
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  const text = (num * 100).toFixed(decimals);
  return `${/^-0(\.0+)?$/.test(text) ? text.slice(1) : text}%`; // no "-0.00%" for tiny negatives
}

/**
 * Exit-capacity value: a number, null when the backend marks it unknown (null, "unknown", NaN),
 * or undefined when the field is absent (older API), so the caller can fall back.
 */
function exitMetric(val) {
  if (val === undefined) return undefined;
  const num = Number(val);
  return val === null || val === '' || !Number.isFinite(num) ? null : num;
}

/** Sort key for MQI: unknown first, then ascending; a flagged vault that rounds to 100 sits just below clean ones. */
function mqiSortKey(v) {
  if (v.mqiPercent === null) return -1;
  const mqi = v.mqiPercent ?? 100;
  return mqi === 100 && v.isAllClean === false ? 99.95 : mqi;
}

/** First value that is not undefined (null is a real answer: "unknown"). */
function firstDefined(...values) {
  return values.find(value => value !== undefined);
}

/**
 * One reading of a vault's MQI for every surface: null = unpriced vault (unknown), isAllClean decides "clean"
 * (the rounded percent can read 100 while a small but material market is flagged).
 */
function mqiBadgeInfo(mqiPercent, isAllClean, hasCompromised = true, isUnpriced = false) {
  if (mqiPercent == null) return { text: isUnpriced ? 'Unpriced' : 'Unverified', clean: false };
  if (isAllClean !== false && mqiPercent === 100) return { text: '100% Clean', clean: true };
  return { text: mqiPercent === 100 ? (hasCompromised ? 'Flagged' : 'Unverified') : `${mqiPercent}% MQI`, clean: false };
}

/** First source that carries the field; an explicit unknown stops the chain instead of falling through. */
function pickExitMetric(...vals) {
  for (const val of vals) {
    const metric = exitMetric(val);
    if (metric !== undefined) return metric;
  }
  return undefined;
}

function formatExitCap(pct) {
  return pct === null || pct === undefined ? 'Exit Cap N/A' : `${pct}% Exit Cap`;
}

function escapeHtml(str) {
  if (str === null || str === undefined || str === false) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Handle viewport resize between desktop and mobile seamlessly
let resizeTimer = null;
let wasMobileViewport = window.innerWidth <= 768;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const isMobileViewport = window.innerWidth <= 768;
    if (isMobileViewport === wasMobileViewport) return;
    wasMobileViewport = isMobileViewport;
    if (!isMobileViewport) {
      if (!selectedVaultAddress || DOM.auditModal?.classList.contains('hidden')) {
        renderPinnedRichPills();
      }
    } else if (DOM.pinnedRichPills) {
      DOM.pinnedRichPills.classList.add('hidden');
    }
  }, 150);
});

// Boot up app on DOM ready
document.addEventListener('DOMContentLoaded', initApp);

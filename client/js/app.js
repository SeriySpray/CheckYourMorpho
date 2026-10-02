/**
 * CheckYourMorpho: Main Frontend Controller
 * Connects 3D Particle Sphere, search autocomplete, filters, and audit modal.
 */

import { ParticleSphere } from './sphere.js';

let sphere = null;
let allVaults = [];
let selectedVaultAddress = null;
let activeAuditData = null;

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

  // Panel 2: MQI, HHI & Exit
  riskMqiPct: document.getElementById('risk-mqi-pct'),
  riskMqiBar: document.getElementById('risk-mqi-bar'),
  riskMqiDesc: document.getElementById('risk-mqi-desc'),
  riskHhiVal: document.getElementById('risk-hhi-val'),
  riskHhiBar: document.getElementById('risk-hhi-bar'),
  riskHhiDesc: document.getElementById('risk-hhi-desc'),
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

  // 2. Bind UI Events
  setupVaultExplorerEvents();
  setupModalEvents();
  setupAuditNavTabs();

  // 3. Fetch Vaults from REST API
  try {
    const res = await fetch('/api/vaults?limit=1000&sortBy=total_assets_usd&sortOrder=desc');
    const data = await res.json();
    allVaults = data.vaults || [];

    if (DOM.headerStatusText) DOM.headerStatusText.textContent = `Live: ${allVaults.length} Vaults`;
    sphere.setVaults(allVaults);
    renderVaultExplorer();
    renderPinnedRichPills(true);
  } catch (err) {
    console.error('Failed to fetch vaults:', err);
    if (DOM.headerStatusText) DOM.headerStatusText.textContent = 'API Offline';
  }

  // 4. Start Live Periodic Polling (every 60s)
  startLivePolling();
}

let livePollingTimer = null;
let isPollingActive = false;

/**
 * Periodically polls the server every 60 seconds to refresh vault metrics,
 * particle sphere, explorer list, and actively inspected audit modal.
 */
function startLivePolling() {
  if (livePollingTimer) clearInterval(livePollingTimer);

  livePollingTimer = setInterval(async () => {
    if (isPollingActive) return;
    isPollingActive = true;

    try {
      // 1. Fetch updated vaults list
      const res = await fetch('/api/vaults?limit=1000&sortBy=total_assets_usd&sortOrder=desc');
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
          const savedScrollTop = DOM.explorerVaultsList ? DOM.explorerVaultsList.scrollTop : 0;
          renderVaultExplorer();
          if (DOM.explorerVaultsList) {
            DOM.explorerVaultsList.scrollTop = savedScrollTop;
          }
          renderPinnedRichPills(false);
        }
      }

      // 2. If an audit modal is currently open and not animating, quietly refresh it
      if (selectedVaultAddress && !DOM.auditModal.classList.contains('hidden') && !isTransitioningVault) {
        const auditRes = await fetch(`/api/vaults/${selectedVaultAddress}`);
        if (auditRes.ok) {
          const auditData = await auditRes.json();
          clientAuditCache.set(selectedVaultAddress.toLowerCase(), auditData);
          activeAuditData = auditData;
          populateAuditModal(auditData, true);
        }
      }
    } catch (pollErr) {
      console.warn('Live polling quiet error:', pollErr.message);
    } finally {
      isPollingActive = false;
    }
  }, 60000);
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
    explorerFilters.sort !== 'tvl_desc'
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
      liq_desc: 'Liquidity: High to Low',
      score_desc: 'Safety: High to Low'
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
        if (DOM.explorerFavFilterBtn) {
          DOM.explorerFavFilterBtn.classList.remove('active');
        }
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
    DOM.searchInput.addEventListener('input', () => {
      const val = DOM.searchInput.value.trim();
      if (DOM.searchClearBtn) {
        DOM.searchClearBtn.classList.toggle('hidden', val.length === 0);
      }
      explorerFilters.query = val.toLowerCase();
      renderVaultExplorer();
    });

    DOM.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeAllDropdowns();
        if (DOM.searchInput.value) {
          DOM.searchInput.value = '';
          if (DOM.searchClearBtn) DOM.searchClearBtn.classList.add('hidden');
          explorerFilters.query = '';
          renderVaultExplorer();
          DOM.searchInput.blur();
          sphere.highlightVault(null);
        }
      } else if (e.key === 'Enter') {
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
        }
      });
    }

    if (menu) {
      menu.querySelectorAll('.dropdown-item').forEach(item => {
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          const value = item.getAttribute('data-value');
          setFilterValue(filterKey, value);
          closeAllDropdowns();
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

  // Global ESC closes open dropdowns
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAllDropdowns();
    }
  });

  if (DOM.explorerFavFilterBtn) {
    DOM.explorerFavFilterBtn.addEventListener('click', () => {
      explorerFilters.pinnedOnly = !explorerFilters.pinnedOnly;
      DOM.explorerFavFilterBtn.classList.toggle('active', explorerFilters.pinnedOnly);
      renderVaultExplorer();
    });
  }

  if (DOM.explorerResetBtn) {
    DOM.explorerResetBtn.addEventListener('click', () => {
      resetDropdownFilters();
    });
  }
}

function resetDropdownFilters() {
  explorerFilters.network = 'all';
  explorerFilters.asset = 'all';
  explorerFilters.curator = 'all';
  explorerFilters.sort = 'tvl_desc';
  explorerFilters.pinnedOnly = false;

  if (DOM.explorerFavFilterBtn) {
    DOM.explorerFavFilterBtn.classList.remove('active');
  }

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

function getPinnedAddresses() {
  try {
    const raw = localStorage.getItem(PINNED_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(a => String(a).toLowerCase()) : [];
  } catch {
    return [];
  }
}

function savePinnedAddresses(addresses) {
  try {
    localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(addresses));
  } catch (err) {
    console.error('Failed to save pinned vaults to localStorage:', err);
  }
}

function isVaultPinned(address) {
  if (!address) return false;
  const pinned = getPinnedAddresses();
  return pinned.includes(address.toLowerCase());
}

function togglePinVault(address) {
  if (!address) return;
  const addr = address.toLowerCase();
  let pinned = getPinnedAddresses();
  const exists = pinned.includes(addr);
  if (exists) {
    pinned = pinned.filter(a => a !== addr);
  } else {
    pinned.push(addr);
  }
  savePinnedAddresses(pinned);
  updateFavBtnUI(addr);
  renderPinnedRichPills(true);
  renderVaultExplorer();
}

function updateFavBtnUI(currentAddress) {
  if (!DOM.modalFavBtn) return;
  const isPinned = isVaultPinned(currentAddress);
  DOM.modalFavBtn.classList.toggle('active', isPinned);
  DOM.modalFavBtn.setAttribute('aria-label', isPinned ? 'Unpin from Favorites' : 'Pin to Favorites');
  DOM.modalFavBtn.title = isPinned ? 'Unpin from Favorites' : 'Pin to Favorites';
}

/**
 * Renders the Pinned Vaults as rich informational cards/pills docked on the left.
 * If animate is true, flies white ball proxies from 3D sphere particles to the left dock.
 */
function renderPinnedRichPills(animate = false) {
  if (!DOM.pinnedRichPills) return;

  const pinnedAddresses = getPinnedAddresses();
  const pinnedVaults = [];
  for (const addr of pinnedAddresses) {
    const found = allVaults.find(v => (v.address || '').toLowerCase() === addr);
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

  pinnedVaults.forEach((v, index) => {
    const chainClass = getChainClass(v.chainId);
    const chainName = formatChainName(v.chainId);
    const curator = formatCuratorName(v.curatorName, v.name);
    const netApyFormatted = `${((v.netApy || 0) * 100).toFixed(2)}%`;
    const feeFormatted = `Fee: ${((v.fee || 0) * 100).toFixed(1)}%`;
    const cachedAudit = clientAuditCache.get((v.address || '').toLowerCase());
    let tokenAmount = 0;
    if (cachedAudit?.vault?.totalAssets) {
      tokenAmount = Number(cachedAudit.vault.totalAssets) / Math.pow(10, v.asset?.decimals || 6);
    } else if (v.totalAssets) {
      tokenAmount = Number(v.totalAssets) / Math.pow(10, v.asset?.decimals || 6);
    } else {
      const price = v.asset?.priceUsd || 1;
      tokenAmount = price > 0 ? (v.totalAssetsUsd || 0) / price : 0;
    }
    const humanAsset = `${formatNumber(tokenAmount)} ${v.asset?.symbol || ''}`;
    const mqiPercent = cachedAudit?.verdict?.mqi?.mqiPercent ?? v.mqiPercent ?? 100;
    const isClean = mqiPercent === 100 && (cachedAudit?.verdict?.mqi?.isAllClean ?? v.isAllClean ?? true);
    const mqiText = isClean ? '100% Clean' : `${mqiPercent}% MQI`;
    const mqiClass = isClean ? 'clean' : 'flagged';
    const exitCapPct = cachedAudit?.verdict?.liquidity?.instantExitCapacityPercent ?? v.exitCapPercent ?? (v.totalAssetsUsd > 0 ? Number(((v.liquidityUsd / v.totalAssetsUsd) * 100).toFixed(1)) : 0);
    const exitCapText = `${exitCapPct}% Exit Cap`;

    const card = document.createElement('div');
    card.className = 'pinned-rich-pill';
    card.dataset.address = v.address;
    if (animate) {
      card.style.opacity = '0';
      card.style.transform = 'translateX(-20px) scale(0.96)';
    }

    card.innerHTML = `
      <div class="rich-pill-top">
        <div class="rich-pill-meta">
          <div class="rich-pill-title-row">
            <span class="badge badge-chain ${chainClass}">${escapeHtml(chainName.slice(0, 4).toUpperCase())}</span>
            <span class="rich-pill-name" title="${escapeHtml(v.name)}">${escapeHtml(v.name)}</span>
          </div>
          <div class="rich-pill-curator">${escapeHtml(curator)} • <span style="color:#ffffff;">${escapeHtml(v.asset?.symbol || '')}</span></div>
        </div>
        <div class="rich-pill-actions">
          <span class="rich-pill-mqi-badge ${mqiClass}">${escapeHtml(mqiText)}</span>
          <button type="button" class="rich-pill-star-btn" data-unpin="${v.address}" title="Unpin from favorites" aria-label="Unpin ${escapeHtml(v.name)}">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="#ffffff" stroke="#ffffff" stroke-width="1.5">
              <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="rich-pill-fin-grid">
        <div class="rich-pill-fin-item">
          <span class="rich-pill-fin-label">Deposits</span>
          <span class="rich-pill-fin-val">${formatCurrency(v.totalAssetsUsd)}</span>
          <span class="rich-pill-fin-sub">${escapeHtml(humanAsset)}</span>
        </div>
        <div class="rich-pill-fin-item">
          <span class="rich-pill-fin-label">Liquidity</span>
          <span class="rich-pill-fin-val">${formatCurrency(v.liquidityUsd)}</span>
          <span class="rich-pill-fin-sub highlight">${escapeHtml(exitCapText)}</span>
        </div>
        <div class="rich-pill-fin-item">
          <span class="rich-pill-fin-label">Net APY</span>
          <span class="rich-pill-fin-val green">${netApyFormatted}</span>
          <span class="rich-pill-fin-sub">${feeFormatted}</span>
        </div>
      </div>
    `;

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

    DOM.pinnedRichPills.appendChild(card);

    // Ball Flight Animation if requested
    if (animate) {
      setTimeout(() => {
        let pPos = sphere.getParticleScreenPos(v.address);
        if (!pPos) {
          pPos = { x: window.innerWidth * 0.45, y: window.innerHeight * 0.5 };
        }
        const orb = document.createElement('div');
        orb.className = 'rich-pill-fly-orb';
        orb.style.left = `${pPos.x}px`;
        orb.style.top = `${pPos.y}px`;
        document.body.appendChild(orb);

        const cardRect = card.getBoundingClientRect();
        const targetX = cardRect.left + 24;
        const targetY = cardRect.top + cardRect.height / 2;

        requestAnimationFrame(() => {
          orb.style.left = `${targetX}px`;
          orb.style.top = `${targetY}px`;

          setTimeout(() => {
            orb.style.opacity = '0';
            card.style.transition = 'opacity 300ms cubic-bezier(0.16, 1, 0.3, 1), transform 300ms cubic-bezier(0.16, 1, 0.3, 1)';
            card.style.opacity = '1';
            card.style.transform = 'none';
            setTimeout(() => {
              orb.remove();
            }, 300);
          }, 420);
        });
      }, index * 80);
    }
  });
 
  // Background pre-fetch full audits for pinned vaults to warm cache and ensure exact data
  pinnedAddresses.forEach(addr => {
    if (!clientAuditCache.has(addr)) {
      fetch(`/api/vaults/${addr}`)
        .then(res => res.ok ? res.json() : null)
        .then(auditData => {
          if (auditData) {
            clientAuditCache.set(addr, auditData);
            const card = DOM.pinnedRichPills?.querySelector(`[data-address="${addr}"]`);
            if (card && auditData.verdict?.liquidity?.instantExitCapacityPercent !== undefined) {
              const exitCapEl = card.querySelector('.rich-pill-fin-sub.highlight');
              if (exitCapEl) {
                exitCapEl.textContent = `${auditData.verdict.liquidity.instantExitCapacityPercent}% Exit Cap`;
              }
            }
          }
        })
        .catch(() => {});
    }
  });
}

/**
 * Renders the filtered and sorted Vaults Explorer list.
 */
function renderVaultExplorer() {
  if (!DOM.explorerVaultsList) return;
  const savedScrollTop = DOM.explorerVaultsList.scrollTop;
  DOM.explorerVaultsList.innerHTML = '';

  const pinnedList = getPinnedAddresses();
  if (DOM.explorerFavCount) {
    DOM.explorerFavCount.textContent = pinnedList.length;
  }
  if (DOM.explorerFavFilterBtn) {
    DOM.explorerFavFilterBtn.classList.toggle('active', explorerFilters.pinnedOnly);
  }

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
      if (!isVaultPinned(v.address)) return false;
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
      return (a.mqiPercent ?? 100) - (b.mqiPercent ?? 100);
    }
    if (explorerFilters.sort === 'mqi_desc') {
      return (b.mqiPercent ?? 100) - (a.mqiPercent ?? 100);
    }
    if (explorerFilters.sort === 'hhi_desc') {
      return (b.hhi ?? 0) - (a.hhi ?? 0);
    }
    if (explorerFilters.sort === 'hhi_asc') {
      const aVal = a.hhiTier === 'UNALLOCATED' ? 999 : (a.hhi ?? 0);
      const bVal = b.hhiTier === 'UNALLOCATED' ? 999 : (b.hhi ?? 0);
      return aVal - bVal;
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
    DOM.explorerVaultsList.innerHTML = `
      <li class="explorer-vault-item" style="color:var(--text-muted); justify-content:center; padding:24px 12px; font-size:12px; text-align:center;">
        ${emptyMsg}
      </li>
    `;
    return;
  }

  // Render all matching vaults into a DocumentFragment for maximum performance
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < results.length; i++) {
    const v = results[i];
    const li = document.createElement('li');
    li.className = 'explorer-vault-item';
    li.setAttribute('data-address', v.address);

    const chainName = formatChainName(v.chainId);
    const chainClass = getChainClass(v.chainId);
    const assetSym = v.asset?.symbol || '';
    const curator = formatCuratorName(v.curatorName, v.name);
    const tvl = v.totalAssetsUsd || v.liquidityUsd || 0;
    const apy = v.netApy || 0;
    const mqi = v.mqiPercent ?? 100;
    const isClean = v.isAllClean ?? (mqi === 100);
    const isPinned = isVaultPinned(v.address);

    const flaggedBadgeHtml = (!isClean && mqi < 100)
      ? ` • <span class="vault-mini-badge flagged">${(100 - mqi).toFixed(1)}% Flagged</span>`
      : '';

    li.innerHTML = `
      <div class="vault-item-left">
        <div class="vault-item-title-row">
          <button type="button" class="vault-item-star-btn ${isPinned ? 'active' : ''}" data-pin-addr="${v.address}" title="${isPinned ? 'Unpin from favorites' : 'Pin to favorites'}" aria-label="Toggle favorite">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="${isPinned ? '#ffffff' : 'none'}" stroke="${isPinned ? '#ffffff' : 'rgba(255,255,255,0.35)'}" stroke-width="1.75">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
            </svg>
          </button>
          <span class="vault-chain-badge ${chainClass}">${chainName}</span>
          <span class="vault-item-name" title="${escapeHtml(v.name)}">${escapeHtml(v.name)}</span>
        </div>
        <span class="vault-item-sub">${escapeHtml(curator)} • <strong style="color:#ffffff">${escapeHtml(assetSym)}</strong>${flaggedBadgeHtml}</span>
      </div>
      <div class="vault-item-right">
        <span class="vault-item-tvl">${formatCurrency(tvl)}</span>
        <span class="vault-item-apy">${(apy * 100).toFixed(2)}% APY</span>
      </div>
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

    fragment.appendChild(li);
  }
  DOM.explorerVaultsList.appendChild(fragment);
  DOM.explorerVaultsList.scrollTop = savedScrollTop;
}


let isTransitioningVault = false;
const clientAuditCache = new Map();

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
      tokenAmount = Number(v.totalAssets) / Math.pow(10, v.asset?.decimals || 6);
    } else {
      const price = v.asset?.priceUsd || 1;
      tokenAmount = price > 0 ? (v.totalAssetsUsd || 0) / price : 0;
    }
    DOM.modalAssetsHuman.textContent = `${formatNumber(tokenAmount)} ${v.asset?.symbol || ''}`;
  }
  if (DOM.modalLiq) DOM.modalLiq.textContent = formatCurrency(v.liquidityUsd);
  if (DOM.modalNetApy) DOM.modalNetApy.textContent = `${((v.netApy || 0) * 100).toFixed(2)}%`;
  if (DOM.modalFee) DOM.modalFee.textContent = `Fee: ${((v.fee || 0) * 100).toFixed(1)}%`;


}

/**
 * Executes the two-stage particle flight and unfold into the Left Floating Terminal.
 * Stage 1: The highlighted orb shoots out across 3D space to the left dock as a ball.
 * Stage 2: Upon arriving at the left side, it smoothly unfolds into the full window panel.
 * Instant Pre-population & In-Memory Cache ensure zero data loading lag.
 */
async function openVaultAudit(vault, startPos) {
  if (isTransitioningVault) return;

  // If clicking the currently open vault, do nothing
  if (selectedVaultAddress && selectedVaultAddress.toLowerCase() === vault.address.toLowerCase() && !DOM.auditModal.classList.contains('hidden')) {
    return;
  }

  DOM.tooltip.classList.add('hidden');

  // 1. Instant Synchronous Pre-population (0ms latency: badges, TVL, APY, specs appear immediately)
  populateBasicVaultInfo(vault);

  // 2. Fetch full audit data with client-side in-memory caching
  const cacheKey = (vault.address || '').toLowerCase();
  let auditDataPromise;
  if (clientAuditCache.has(cacheKey)) {
    auditDataPromise = Promise.resolve(clientAuditCache.get(cacheKey));
  } else {
    auditDataPromise = fetch(`/api/vaults/${vault.address}`)
      .then(res => {
        if (!res.ok) throw new Error('Vault audit data not found');
        return res.json();
      })
      .then(data => {
        clientAuditCache.set(cacheKey, data);
        return data;
      })
      .catch(err => {
        console.error('Error fetching vault audit:', err);
        return null;
      });
  }

  isTransitioningVault = true;

  const isMobile = window.innerWidth <= 768;

  // On Mobile: Directly load and slide up the bottom sheet modal with zero lag (no 3D sphere proxy animation)
  if (isMobile) {
    selectedVaultAddress = vault.address;
    if (DOM.pinnedRichPills) {
      DOM.pinnedRichPills.classList.add('hidden');
    }

    const data = await auditDataPromise;
    if (!data) {
      isTransitioningVault = false;
      closeVaultAudit();
      return;
    }

    activeAuditData = data;
    populateAuditModal(data);
    DOM.auditModal.classList.remove('hidden');
    isTransitioningVault = false;
    return;
  }

  // Target coordinates for Left Floating Terminal (Desktop)
  const targetLeft = 20;
  const targetTop = 18;
  const targetWidth = Math.min(480, Math.floor(window.innerWidth * 0.45));
  const targetHeight = window.innerHeight - 36;
  const targetCenterX = targetLeft + targetWidth / 2;
  const targetCenterY = targetTop + targetHeight / 2;
  const targetRadius = '20px';

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
    pRetract.style.background = 'rgba(14, 14, 14, 0.88)';
    pRetract.style.border = '1px solid rgba(255, 255, 255, 0.12)';
    pRetract.style.boxShadow = '0 16px 40px rgba(0, 0, 0, 0.8)';
    pRetract.classList.remove('hidden');

    // Stage 1: Fold window down into a ball at left dock (220ms)
    requestAnimationFrame(() => {
      pRetract.style.transition = 'width 220ms cubic-bezier(0.2, 0.9, 0.3, 1), height 220ms cubic-bezier(0.2, 0.9, 0.3, 1), border-radius 220ms, background 220ms, box-shadow 220ms';
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
    pOpen.style.transition = 'left 440ms cubic-bezier(0.16, 1, 0.3, 1), top 440ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 440ms';
    pOpen.style.left = `${targetCenterX}px`;
    pOpen.style.top = `${targetCenterY}px`;
  });
  // (Notice: width, height, borderRadius stay circular during flight!)

  // Stage 2: Upon arriving at left dock, ball unfolds into the full rectangular window (300ms)
  setTimeout(() => {
    pOpen.style.transition = 'width 300ms cubic-bezier(0.16, 1, 0.3, 1), height 300ms cubic-bezier(0.16, 1, 0.3, 1), border-radius 300ms cubic-bezier(0.16, 1, 0.3, 1), background 300ms, border-color 300ms, box-shadow 300ms';
    pOpen.style.width = `${targetWidth}px`;
    pOpen.style.height = `${targetHeight}px`;
    pOpen.style.borderRadius = targetRadius;
    pOpen.style.background = 'rgba(14, 14, 14, 0.88)';
    pOpen.style.border = '1px solid rgba(255, 255, 255, 0.14)';
    pOpen.style.boxShadow = '0 24px 60px rgba(0, 0, 0, 0.85), 0 0 0 1px rgba(255, 255, 255, 0.08)';
  }, 420);

  const animStartTime = Date.now();

  // Simultaneously resolve audit data and finish population
  const data = await auditDataPromise;
  if (!data) {
    pOpen.classList.add('hidden');
    isTransitioningVault = false;
    closeVaultAudit();
    return;
  }

  activeAuditData = data;
  populateAuditModal(data);

  // Stage 3: Smooth docking reveal when unfold completes (synchronized with 720ms animation)
  const elapsed = Date.now() - animStartTime;
  const remainingDelay = Math.max(0, 720 - elapsed);

  setTimeout(() => {
    DOM.auditModal.classList.remove('hidden');
    pOpen.style.opacity = '0';
    setTimeout(() => {
      pOpen.classList.add('hidden');
      isTransitioningVault = false;
    }, 220);
  }, remainingDelay);
}

/**
 * Reverses the morphing animation: folds left panel into a ball and flies it back into the 3D sphere.
 */
function closeVaultAudit() {
  if (DOM.auditModal.classList.contains('hidden')) return;

  const isMobile = window.innerWidth <= 768;
  if (isMobile) {
    DOM.auditModal.classList.add('hidden');
    selectedVaultAddress = null;
    isTransitioningVault = false;
    return;
  }

  const targetWidth = Math.min(480, Math.floor(window.innerWidth * 0.45));
  const targetHeight = window.innerHeight - 36;
  const targetCenterX = 20 + targetWidth / 2;
  const targetCenterY = 18 + targetHeight / 2;
  const targetRadius = '20px';

  const closingAddress = selectedVaultAddress;

  // 1. Hide left audit terminal
  DOM.auditModal.classList.add('hidden');

  // 2. Spawn morph proxy in left terminal bounds
  DOM.morphProxy.style.transition = 'none';
  DOM.morphProxy.style.left = `${targetCenterX}px`;
  DOM.morphProxy.style.top = `${targetCenterY}px`;
  DOM.morphProxy.style.width = `${targetWidth}px`;
  DOM.morphProxy.style.height = `${targetHeight}px`;
  DOM.morphProxy.style.borderRadius = targetRadius;
  DOM.morphProxy.style.opacity = '0.88';
  DOM.morphProxy.style.background = 'rgba(14, 14, 14, 0.88)';
  DOM.morphProxy.style.border = '1px solid rgba(255, 255, 255, 0.14)';
  DOM.morphProxy.classList.remove('hidden');

  // 3. Determine return coordinates of the particle on the 3D sphere
  let particlePos = closingAddress ? sphere.getParticleScreenPos(closingAddress) : null;
  if (!particlePos) {
    particlePos = {
      x: isMobile ? window.innerWidth * 0.5 : window.innerWidth * 0.45,
      y: isMobile ? window.innerHeight * 0.28 : window.innerHeight * 0.5
    };
  }

  // Stage 1: Fold window down into a ball at dock position (220ms)
  requestAnimationFrame(() => {
    DOM.morphProxy.style.transition = 'width 220ms cubic-bezier(0.2, 0.9, 0.3, 1), height 220ms cubic-bezier(0.2, 0.9, 0.3, 1), border-radius 220ms, background 220ms, box-shadow 220ms';
    DOM.morphProxy.style.width = '12px';
    DOM.morphProxy.style.height = '12px';
    DOM.morphProxy.style.borderRadius = '50%';
    DOM.morphProxy.style.background = '#ffffff';
    DOM.morphProxy.style.boxShadow = '0 0 16px rgba(255, 255, 255, 0.6)';
  });

  // Stage 2: Ball shoots back into particle on the sphere (440ms)
  setTimeout(() => {
    const liveParticlePos = closingAddress ? sphere.getParticleScreenPos(closingAddress) : particlePos;
    DOM.morphProxy.style.transition = 'left 440ms cubic-bezier(0.16, 1, 0.3, 1), top 440ms cubic-bezier(0.16, 1, 0.3, 1), opacity 440ms';
    DOM.morphProxy.style.left = `${liveParticlePos.x}px`;
    DOM.morphProxy.style.top = `${liveParticlePos.y}px`;
    DOM.morphProxy.style.opacity = '0';

    setTimeout(() => {
      DOM.morphProxy.classList.add('hidden');
      selectedVaultAddress = null;
      sphere.setSelectedVault(null);
      sphere.highlightVault(null);
      isTransitioningVault = false;
      renderPinnedRichPills(true);
    }, 450);
  }, 210);
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
  const mqiVal = verdict.mqi?.mqiPercent ?? 100;
  DOM.modalGrade.textContent = `${mqiVal}%`;
  DOM.modalScore.textContent = (mqiVal === 100 && verdict.mqi?.isAllClean) ? 'Clean Capital' : (mqiVal < 100 ? `${(100 - mqiVal).toFixed(1)}% Flagged` : 'Clean Capital');
  DOM.modalGrade.style.color = mqiVal === 100 ? 'var(--accent-green)' : (mqiVal >= 80 ? 'var(--accent-orange)' : 'var(--accent-red)');

  // Financials
  DOM.modalTvl.textContent = formatCurrency(v.totalAssetsUsd);
  DOM.modalAssetsHuman.textContent = `${formatNumber(v.totalAssets ? Number(v.totalAssets) / Math.pow(10, v.asset?.decimals || 6) : 0)} ${v.asset?.symbol || ''}`;
  DOM.modalLiq.textContent = formatCurrency(v.liquidityUsd);
  DOM.modalExitCapPct.textContent = `${verdict.liquidity?.instantExitCapacityPercent || 0}% Exit Cap`;
  DOM.modalNetApy.textContent = `${((v.netApy || 0) * 100).toFixed(2)}%`;
  DOM.modalFee.textContent = `Fee: ${((v.fee || 0) * 100).toFixed(1)}%`;

  // Underlying Markets Count Pill
  if (DOM.overviewMarketsCount) {
    const count = allocations.length;
    DOM.overviewMarketsCount.textContent = `${count} MARKET${count === 1 ? '' : 'S'}`;
  }

  // --- PANEL 2: PORTFOLIO AUDIT (MQI & HHI & EXIT) ---
  // 1. MQI
  if (DOM.riskMqiPct) DOM.riskMqiPct.textContent = `${mqiVal}%`;
  if (DOM.riskMqiBar) {
    DOM.riskMqiBar.style.width = `${mqiVal}%`;
    DOM.riskMqiBar.style.background = '#ffffff';
  }
  if (DOM.riskMqiDesc) {
    DOM.riskMqiDesc.textContent = verdict.mqi?.isAllClean
      ? '100% of capital is deployed in verified, non-defaulted markets'
      : `${verdict.mqi?.compromisedMarkets?.length || 0} market(s) with verification or debt issues detected`;
  }

  // 2. HHI
  const hhiVal = verdict.hhi?.hhi ?? 0;
  const isUnallocated = verdict.hhi?.tier === 'UNALLOCATED';

  // Force pure English tier labels regardless of backend cache
  let tierLabel = 'High Diversification';
  if (isUnallocated || verdict.hhi?.tier === 'UNALLOCATED') {
    tierLabel = 'N/A';
  } else if (verdict.hhi?.tier === 'EXTREME' || hhiVal > 0.50) {
    tierLabel = 'Critical Concentration';
  } else if (verdict.hhi?.tier === 'CONCENTRATED' || hhiVal >= 0.25) {
    tierLabel = 'High Concentration';
  } else if (verdict.hhi?.tier === 'MODERATE' || hhiVal >= 0.15) {
    tierLabel = 'Moderate Concentration';
  } else {
    tierLabel = 'High Diversification';
  }

  if (DOM.riskHhiVal) {
    if (isUnallocated) {
      DOM.riskHhiVal.textContent = 'N/A';
    } else {
      DOM.riskHhiVal.textContent = `${hhiVal} (${tierLabel})`;
    }
  }
  if (DOM.riskHhiBar) {
    DOM.riskHhiBar.style.width = isUnallocated ? '0%' : `${Math.min(100, Math.round(hhiVal * 100))}%`;
    DOM.riskHhiBar.style.background = '#ffffff';
  }
  if (DOM.riskHhiDesc) {
    if (isUnallocated) {
      DOM.riskHhiDesc.textContent = 'No active collateral backing';
    } else {
      const top = verdict.hhi?.topCollateral;
      DOM.riskHhiDesc.textContent = top && top.symbol !== 'None'
        ? `Top collateral: ${top.symbol} (${top.sharePercent}% of total capital)`
        : 'Herfindahl-Hirschman single-asset concentration index';
    }
  }

  // 3. Exit Liquidity
  const exitPct = verdict.liquidity?.instantExitCapacityPercent || 0;
  if (DOM.riskExitPct) DOM.riskExitPct.textContent = `${exitPct}%`;
  if (DOM.riskExitBar) {
    DOM.riskExitBar.style.width = `${Math.min(100, exitPct)}%`;
    DOM.riskExitBar.style.background = '#ffffff';
  }

  if (DOM.riskExitDesc) {
    DOM.riskExitDesc.textContent = `${formatCurrency(verdict.liquidity?.instantExitCapacityUsd || 0)} available for immediate withdrawal without locking markets`;
  }

  // 4. Collateral Allocation Breakdown
  if (DOM.riskEffectiveAssets) {
    if (isUnallocated) {
      DOM.riskEffectiveAssets.textContent = '0 Effective Assets';
    } else {
      DOM.riskEffectiveAssets.textContent = `${verdict.hhi?.effectiveAssets ?? 0} Effective Assets`;
    }
  }
  if (DOM.riskCollateralList) {
    DOM.riskCollateralList.innerHTML = '';
    const breakdown = verdict.hhi?.breakdown || [];
    if (breakdown.length === 0) {
      DOM.riskCollateralList.innerHTML = '<span style="color:var(--text-muted); font-size:11px;">No active collateral backing recorded.</span>';
    } else {
      breakdown.slice(0, 6).forEach(item => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; font-size:11px; padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.04);';
        row.innerHTML = `
          <span style="font-weight:600; color:#fff;">${escapeHtml(item.symbol)}</span>
          <span style="color:var(--text-muted);">${formatCurrency(item.usd)} <strong style="color:#fff; margin-left:6px;">${item.sharePercent}%</strong></span>
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
        div.className = `flag-item ${flag.level.toLowerCase()}`;
        div.innerHTML = `<strong>${escapeHtml(flag.title)}:</strong> ${escapeHtml(flag.message)}`;
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
        ? '<span class="badge" style="color:var(--accent-red); border-color:rgba(239,68,68,0.3); font-size:10px;">FLAGGED</span>'
        : '<span class="badge badge-listed" style="color:var(--accent-green); border-color:rgba(16,185,129,0.3); font-size:10px;">CLEAN</span>';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${escapeHtml(a.collateralSymbol || 'None')}</strong></td>
        <td>${a.lltvPercent ? a.lltvPercent + '%' : '0%'}</td>
        <td>${((a.weight || 0) * 100).toFixed(1)}%</td>
        <td>${formatCurrency(a.supplyAssetsUsd)}</td>
        <td>${formatCurrency(a.marketFreeLiquidityUsd)}</td>
        <td>${statusBadge}</td>
        <td class="green">${((a.supplyApy || 0) * 100).toFixed(2)}%</td>
      `;
      DOM.allocationsTbody.appendChild(tr);
    });
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

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !DOM.auditModal.classList.contains('hidden')) {
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
function formatCurrency(val) {
  const num = Number(val) || 0;
  if (num >= 1e9) return `$${(num / 1e9).toFixed(2)}B`;
  if (num >= 1e6) return `$${(num / 1e6).toFixed(2)}M`;
  if (num >= 1e3) return `$${(num / 1e3).toFixed(1)}K`;
  return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatNumber(val) {
  const num = Number(val) || 0;
  if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Boot up app on DOM ready
document.addEventListener('DOMContentLoaded', initApp);

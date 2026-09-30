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
  auditModal: document.getElementById('audit-modal'),
  modalBackdrop: document.getElementById('modal-backdrop'),
  closeBtn: document.getElementById('modal-close-btn'),

  // Master Vault Explorer Terminal (Right-side 440px)
  vaultExplorerWidget: document.getElementById('vault-explorer-widget'),
  explorerCount: document.getElementById('explorer-count'),
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
  modalSpecAsset: document.getElementById('modal-spec-asset'),
  modalSpecAssetAddr: document.getElementById('modal-spec-asset-addr'),
  modalSpecMarkets: document.getElementById('modal-spec-markets'),
  modalSpecFee: document.getElementById('modal-spec-fee'),
  modalSpecAddress: document.getElementById('modal-spec-address'),
  modalSpecChain: document.getElementById('modal-spec-chain'),

  // Panel 2: Risk
  riskExitPct: document.getElementById('risk-exit-pct'),
  riskExitBar: document.getElementById('risk-exit-bar'),
  riskExitDesc: document.getElementById('risk-exit-desc'),
  riskDomPct: document.getElementById('risk-dom-pct'),
  riskDomBar: document.getElementById('risk-dom-bar'),
  riskDomDesc: document.getElementById('risk-dom-desc'),
  riskTwr30d: document.getElementById('risk-twr-30d'),
  riskTwr90d: document.getElementById('risk-twr-90d'),
  riskTwrAll: document.getElementById('risk-twr-all'),
  riskDisciplineScore: document.getElementById('risk-discipline-score'),
  riskReallocsCount: document.getElementById('risk-reallocs-count'),
  riskSpikesCount: document.getElementById('risk-spikes-count'),
  riskFlagsList: document.getElementById('risk-flags-list'),

  // Panel 3: Markets & Timeline
  modalMarketsCount: document.getElementById('modal-markets-count'),
  modalReallocsCount: document.getElementById('modal-reallocs-count'),
  allocationsTbody: document.getElementById('allocations-tbody'),
  reallocationsTbody: document.getElementById('reallocations-tbody'),
  subTabs: document.querySelectorAll('.sub-tab'),
  subTabContents: document.querySelectorAll('.sub-tab-content')
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
    }
  });
  window.sphere = sphere;

  // 2. Bind UI Events
  setupVaultExplorerEvents();
  setupModalEvents();
  setupPanelTabEvents();

  // 3. Fetch Vaults from REST API
  try {
    const res = await fetch('/api/vaults?limit=1000&sortBy=total_assets_usd&sortOrder=desc');
    const data = await res.json();
    allVaults = data.vaults || [];

    if (DOM.headerStatusText) DOM.headerStatusText.textContent = `Live: ${allVaults.length} Vaults`;
    sphere.setVaults(allVaults);
    renderVaultExplorer();
  } catch (err) {
    console.error('Failed to fetch vaults:', err);
    if (DOM.headerStatusText) DOM.headerStatusText.textContent = 'API Offline';
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
  sort: 'tvl_desc'
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

  DOM.chipsContainer.innerHTML = chipsHtml;

  // Bind individual chip remove buttons
  DOM.chipsContainer.querySelectorAll('.chip-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const toClear = btn.getAttribute('data-clear');
      if (toClear === 'sort') {
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

/**
 * Renders the filtered and sorted Vaults Explorer list.
 */
function renderVaultExplorer() {
  if (!DOM.explorerVaultsList) return;
  DOM.explorerVaultsList.innerHTML = '';

  const isFiltered = Boolean(
    explorerFilters.query ||
    explorerFilters.network !== 'all' ||
    explorerFilters.asset !== 'all' ||
    explorerFilters.curator !== 'all' ||
    explorerFilters.sort !== 'tvl_desc'
  );

  updateActiveFilterChips();

  let results = allVaults.filter(v => {
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
    if (explorerFilters.sort === 'score_desc') {
      const scoreA = a.safetyScore !== undefined ? a.safetyScore : 80;
      const scoreB = b.safetyScore !== undefined ? b.safetyScore : 80;
      return scoreB - scoreA;
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
    DOM.explorerVaultsList.innerHTML = `
      <li class="explorer-vault-item" style="color:var(--text-muted); justify-content:center; padding:24px 12px; font-size:12px;">
        No vaults match your filter criteria. Try resetting filters.
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

    li.innerHTML = `
      <div class="vault-item-left">
        <div class="vault-item-title-row">
          <span class="vault-chain-badge ${chainClass}">${chainName}</span>
          <span class="vault-item-name" title="${escapeHtml(v.name)}">${escapeHtml(v.name)}</span>
        </div>
        <span class="vault-item-sub">${escapeHtml(curator)} • <strong style="color:#88aaff">${escapeHtml(assetSym)}</strong></span>
      </div>
      <div class="vault-item-right">
        <span class="vault-item-tvl">${formatCurrency(tvl)}</span>
        <span class="vault-item-apy">${(apy * 100).toFixed(2)}% APY</span>
      </div>
    `;

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
}

/**
 * Executes the particle morphing flight and window expansion sequence (Photo 1 & 2).
 */
async function openVaultAudit(vault, startPos) {
  selectedVaultAddress = vault.address;
  DOM.tooltip.classList.add('hidden');
  if (DOM.vaultExplorerWidget) {
    DOM.vaultExplorerWidget.classList.add('hidden');
  }

  const startX = startPos ? startPos.x : window.innerWidth / 2;
  const startY = startPos ? startPos.y : window.innerHeight / 2;
  const targetX = window.innerWidth / 2;
  const targetY = window.innerHeight / 2;

  // 1. Position morph proxy at particle coordinate
  DOM.morphProxy.style.transition = 'none';
  DOM.morphProxy.style.left = `${startX}px`;
  DOM.morphProxy.style.top = `${startY}px`;
  DOM.morphProxy.style.width = '10px';
  DOM.morphProxy.style.height = '10px';
  DOM.morphProxy.style.borderRadius = '50%';
  DOM.morphProxy.style.opacity = '1';
  DOM.morphProxy.classList.remove('hidden');

  // 2. Shrink and blur the background 3D sphere
  DOM.sphereWrapper.classList.add('shrunk');

  // 3. Force reflow and start flight + morph animation towards center
  DOM.morphProxy.offsetHeight;
  DOM.morphProxy.style.transition = 'all 450ms cubic-bezier(0.16, 1, 0.3, 1)';
  DOM.morphProxy.style.left = `${targetX}px`;
  DOM.morphProxy.style.top = `${targetY}px`;
  DOM.morphProxy.style.width = '160px';
  DOM.morphProxy.style.height = '100px';
  DOM.morphProxy.style.borderRadius = '16px';
  DOM.morphProxy.style.opacity = '0.9';

  // 4. Fetch full audit report from backend API
  try {
    const res = await fetch(`/api/vaults/${vault.address}`);
    if (!res.ok) throw new Error('Vault audit data not found');
    const data = await res.json();
    activeAuditData = data;

    populateAuditModal(data);

    // 5. Reveal audit modal panels unfolding from center
    setTimeout(() => {
      DOM.auditModal.classList.remove('hidden');
      DOM.morphProxy.style.opacity = '0';
      setTimeout(() => DOM.morphProxy.classList.add('hidden'), 300);
    }, 380);

  } catch (err) {
    console.error('Error fetching vault audit:', err);
    closeVaultAudit();
  }
}

/**
 * Reverses the morphing animation: collapses panels back into particle and returns to sphere.
 */
function closeVaultAudit() {
  if (DOM.auditModal.classList.contains('hidden')) return;

  const targetPos = sphere.getParticleScreenPos(selectedVaultAddress);
  const centerX = window.innerWidth / 2;
  const centerY = window.innerHeight / 2;

  // 1. Hide modal dashboard
  DOM.auditModal.classList.add('hidden');
  if (DOM.vaultExplorerWidget) {
    DOM.vaultExplorerWidget.classList.remove('hidden');
  }

  // 2. Spawn morph proxy in center
  DOM.morphProxy.style.transition = 'none';
  DOM.morphProxy.style.left = `${centerX}px`;
  DOM.morphProxy.style.top = `${centerY}px`;
  DOM.morphProxy.style.width = '160px';
  DOM.morphProxy.style.height = '100px';
  DOM.morphProxy.style.borderRadius = '16px';
  DOM.morphProxy.style.opacity = '0.85';
  DOM.morphProxy.classList.remove('hidden');

  // 3. Force reflow, then fly back to particle coordinates on the sphere
  DOM.morphProxy.offsetHeight;
  DOM.morphProxy.style.transition = 'all 400ms cubic-bezier(0.16, 1, 0.3, 1)';
  DOM.morphProxy.style.left = `${targetPos.x}px`;
  DOM.morphProxy.style.top = `${targetPos.y}px`;
  DOM.morphProxy.style.width = '8px';
  DOM.morphProxy.style.height = '8px';
  DOM.morphProxy.style.borderRadius = '50%';
  DOM.morphProxy.style.opacity = '0.2';

  // 4. Restore background sphere to normal scale
  DOM.sphereWrapper.classList.remove('shrunk');

  setTimeout(() => {
    DOM.morphProxy.classList.add('hidden');
    selectedVaultAddress = null;
    sphere.highlightVault(null);
  }, 420);
}

/**
 * Populates all fields across Panel 1, Panel 2, and Panel 3.
 */
function populateAuditModal(data) {
  const v = data.vault;
  const verdict = data.verdict;
  const allocations = data.allocations || [];
  const reallocations = data.reallocations || [];

  // --- PANEL 1: MAIN ---
  const chainName = formatChainName(v.chainId);
  const chainClass = getChainClass(v.chainId);
  DOM.modalChainBadge.textContent = chainName;
  DOM.modalChainBadge.className = `badge badge-chain ${chainClass}`;
  DOM.modalVersionBadge.textContent = (v.version || 'V1').toUpperCase();
  DOM.modalListedBadge.textContent = v.isListed ? 'LISTED' : 'UNLISTED';
  DOM.modalListedBadge.className = `badge ${v.isListed ? 'badge-listed' : 'badge-chain'}`;

  DOM.modalVaultName.textContent = v.name;
  DOM.modalCuratorName.textContent = formatCuratorName(v.curatorName, v.name);

  // Safety Score & Grade
  DOM.modalGrade.textContent = verdict.grade;
  DOM.modalScore.textContent = `${verdict.safetyScore}/100`;

  // Color grade based on safety tier
  let gradeColor = 'var(--accent-green)';
  if (verdict.safetyScore < 45) gradeColor = 'var(--accent-red)';
  else if (verdict.safetyScore < 65) gradeColor = 'var(--accent-orange)';
  else if (verdict.safetyScore < 75) gradeColor = 'var(--accent-yellow)';
  DOM.modalGrade.style.color = gradeColor;

  // Financials
  DOM.modalTvl.textContent = formatCurrency(v.totalAssetsUsd);
  DOM.modalAssetsHuman.textContent = `${formatNumber(v.totalAssets ? Number(v.totalAssets) / Math.pow(10, v.asset?.decimals || 6) : 0)} ${v.asset?.symbol || ''}`;
  DOM.modalLiq.textContent = formatCurrency(v.liquidityUsd);
  DOM.modalExitCapPct.textContent = `${verdict.liquidity?.instantExitCapacityPercent || 0}% Exit Cap`;
  DOM.modalNetApy.textContent = `${((v.netApy || 0) * 100).toFixed(2)}%`;
  DOM.modalFee.textContent = `Fee: ${((v.fee || 0) * 100).toFixed(1)}%`;

  // Specs Card Grid
  if (DOM.modalSpecAsset) DOM.modalSpecAsset.textContent = v.asset?.symbol || 'Unknown';
  if (DOM.modalSpecAssetAddr) {
    const assetAddr = v.asset?.address || '';
    DOM.modalSpecAssetAddr.textContent = assetAddr ? `${assetAddr.slice(0, 6)}...${assetAddr.slice(-4)}` : 'Native / Unknown';
  }
  if (DOM.modalSpecMarkets) {
    const count = allocations.length;
    DOM.modalSpecMarkets.textContent = `${count} Market${count === 1 ? '' : 's'}`;
  }
  if (DOM.modalSpecFee) {
    DOM.modalSpecFee.textContent = `${((v.fee || 0) * 100).toFixed(1)}%`;
  }
  if (DOM.modalSpecAddress) {
    const addr = v.address || '';
    DOM.modalSpecAddress.textContent = addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : '0x...';
    DOM.modalSpecAddress.title = addr;
  }
  if (DOM.modalSpecChain) {
    DOM.modalSpecChain.textContent = `${chainName} (${v.chainId || 1})`;
  }

  // --- PANEL 2: RISK & EXIT CAPACITY ---
  const exitPct = verdict.liquidity?.instantExitCapacityPercent || 0;
  DOM.riskExitPct.textContent = `${exitPct}%`;
  DOM.riskExitBar.style.width = `${Math.min(100, exitPct)}%`;
  DOM.riskExitBar.style.background = exitPct < 30 ? 'var(--accent-red)' : 'var(--accent-blue)';
  DOM.riskExitDesc.textContent = `${formatCurrency(verdict.liquidity?.instantExitCapacityUsd || 0)} available for immediate withdrawal without locking markets`;

  const domPct = verdict.liquidity?.maxMarketDominancePercent || 0;
  DOM.riskDomPct.textContent = `${domPct}%`;
  DOM.riskDomBar.style.width = `${Math.min(100, domPct)}%`;
  DOM.riskDomBar.style.background = domPct > 60 ? 'var(--accent-red)' : (domPct > 40 ? 'var(--accent-orange)' : 'var(--accent-blue)');
  DOM.riskDomDesc.textContent = domPct > 60
    ? 'High dominance: a large redemption could spike borrow utilization to 100%'
    : 'Healthy capital dispersion across underlying credit markets';

  DOM.riskTwr30d.textContent = verdict.risk?.twr30d?.toFixed(1) || '0.0';
  DOM.riskTwr90d.textContent = verdict.risk?.twr90d?.toFixed(1) || '0.0';
  DOM.riskTwrAll.textContent = verdict.risk?.twrAllTime?.toFixed(1) || '0.0';

  DOM.riskDisciplineScore.textContent = `${verdict.curator?.disciplineScore || 85}/100 Score`;
  DOM.riskReallocsCount.textContent = `${verdict.curator?.totalReallocationsRecorded || 0} reallocations indexed`;
  DOM.riskSpikesCount.textContent = `${verdict.risk?.peakRiskSpikes?.length || 0} risk spikes detected`;

  // Red Flags
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

  // --- PANEL 3: MARKETS & REALLOCATIONS ---
  DOM.modalMarketsCount.textContent = allocations.length;
  DOM.modalReallocsCount.textContent = reallocations.length;

  // Populate Allocations Table
  DOM.allocationsTbody.innerHTML = '';
  if (allocations.length === 0) {
    DOM.allocationsTbody.innerHTML = '<tr><td colspan="8" style="text-align:center; color:#666;">No active market allocations recorded.</td></tr>';
  } else {
    allocations.forEach(a => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${escapeHtml(a.collateralSymbol || 'None')}</strong></td>
        <td>${escapeHtml(a.loanSymbol || '')}</td>
        <td>${a.lltvPercent ? a.lltvPercent + '%' : '0%'}</td>
        <td>${((a.weight || 0) * 100).toFixed(1)}%</td>
        <td>${formatCurrency(a.supplyAssetsUsd)}</td>
        <td>${formatCurrency(a.marketFreeLiquidityUsd)}</td>
        <td>${((a.marketUtilization || 0) * 100).toFixed(1)}%</td>
        <td class="green">${((a.supplyApy || 0) * 100).toFixed(2)}%</td>
      `;
      DOM.allocationsTbody.appendChild(tr);
    });
  }

  // Populate Reallocations Table
  DOM.reallocationsTbody.innerHTML = '';
  if (reallocations.length === 0) {
    DOM.reallocationsTbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#666;">No historical curator reallocations recorded.</td></tr>';
  } else {
    reallocations.forEach(r => {
      const tr = document.createElement('tr');
      const dateStr = new Date(r.timestamp * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const isBase = v.chainId === 8453;
      const explorerUrl = isBase ? `https://basescan.org/tx/${r.txHash}` : `https://etherscan.io/tx/${r.txHash}`;
      const shortHash = `${r.txHash.slice(0, 6)}...${r.txHash.slice(-4)}`;

      tr.innerHTML = `
        <td>${dateStr}</td>
        <td><span class="badge ${r.type.includes('Supply') ? 'badge-listed' : 'badge-chain'}">${escapeHtml(r.type)}</span></td>
        <td><strong>${escapeHtml(r.collateralSymbol || 'None')}</strong></td>
        <td>${r.lltvPercent ? r.lltvPercent + '%' : '0%'}</td>
        <td>${formatNumber(r.assetsHuman)}</td>
        <td><a class="tx-link" href="${explorerUrl}" target="_blank" rel="noopener noreferrer">${shortHash}</a></td>
      `;
      DOM.reallocationsTbody.appendChild(tr);
    });
  }
}

/**
 * Sets up listeners for modal open/close actions.
 */
function setupModalEvents() {
  DOM.closeBtn.addEventListener('click', closeVaultAudit);
  DOM.modalBackdrop.addEventListener('click', closeVaultAudit);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !DOM.auditModal.classList.contains('hidden')) {
      closeVaultAudit();
    }
  });
}

/**
 * Sets up tab switching between Underlying Markets and Curator Reallocations.
 */
function setupPanelTabEvents() {
  DOM.subTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      DOM.subTabs.forEach(t => t.classList.remove('active'));
      DOM.subTabContents.forEach(c => c.classList.remove('active'));

      tab.classList.add('active');
      const targetId = tab.dataset.target;
      const targetContent = document.getElementById(targetId);
      if (targetContent) targetContent.classList.add('active');
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

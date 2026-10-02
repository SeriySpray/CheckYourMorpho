# CheckYourMorpho

> **Live Application**: [https://checkyourmorpho.duckdns.org](https://checkyourmorpho.duckdns.org)
>
> Risk intelligence, collateral concentration auditing, and real-time visualization terminal for MetaMorpho Vaults.

[![Live](https://img.shields.io/badge/Live-checkyourmorpho.duckdns.org-2470FF?style=flat-square&logo=googlechrome&logoColor=white)](https://checkyourmorpho.duckdns.org)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B%20LTS-161B22?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![SQLite](https://img.shields.io/badge/SQLite-WAL%20Native-161B22?style=flat-square&logo=sqlite&logoColor=white)](https://sqlite.org)
[![Morpho Blue](https://img.shields.io/badge/Morpho-Blue%20%26%20Vaults-161B22?style=flat-square)](https://morpho.org)

Zero npm runtime dependencies (native Node.js 22+ & SQLite WAL).

---


## Core Metrics & Formulas

### 1. Market Quality Index (MQI)
Measures the percentage of vault capital allocated to safe, whitelisted, and non-defaulted markets.

$$MQI = \sum_{i=1}^N (w_i \times \text{IsClean}_i) + w_{\text{cash}}$$

Where $\text{IsClean}_i = 1$ if and only if:
- `isListed == true` (verified in official Morpho registry)
- `badDebt == 0` and `realizedBadDebt == 0` (zero unrecovered defaults)
- `oracle_address != 0x0` (valid oracle contract)
- `protocol_warnings == 0` (no critical security warnings)

*Defective markets are flagged only if their allocation exceeds the material threshold of 1.0% TVL.*

### 2. Collateral Concentration (HHI)
Measures systemic exposure to underlying collateral assets using the Herfindahl-Hirschman Index.

$$HHI = \sum_{k=1}^M \left(\frac{\text{Collateral USD}_k}{\text{Total Active Collateral USD}}\right)^2$$

- **DIVERSIFIED**: $HHI < 0.15$
- **MODERATE**: $0.15 \le HHI < 0.25$
- **CONCENTRATED**: $0.25 \le HHI \le 0.50$
- **CRITICAL**: $HHI > 0.50$
- **Effective Assets**: $N_{\text{eff}} = \frac{1}{HHI}$
- **UNALLOCATED**: 100% idle cash or 0-LLTV reserve markets (0 Effective Assets, no false concentration alerts).

### 3. Instant Exit Capacity
Calculates the exact percentage and dollar amount of capital immediately withdrawable in the current block without waiting for borrower repayments.

$$\text{ExitCapacity} = \frac{\text{Direct Cash} + \sum \min(\text{Supply}_i, \text{Available Liquidity}_i)}{\text{Total Assets}} \times 100\%$$

*0-LLTV idle reserves are isolated from loan markets to prevent liquidity double-counting.*

---

## Quick Start

### Prerequisites
- Node.js v24.0.0 or higher
- Modern web browser with WebGL 2 support

### Run Application
```bash
# Clone repository
git clone https://github.com/SeriySpray/CheckYourMorpho.git
cd CheckYourMorpho

# Start server
npm start
# or on Windows:
start.bat
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

### On-Chain Data Sync
To manually sync market data from Morpho GraphQL:
```bash
npm run sync
# or on Windows:
sync.bat
```
*(The server also syncs automatically in the background every 180 seconds).*

### Production Deployment (Oracle Cloud)
To deploy updates to the live Oracle Cloud VPS:
```bash
# On Windows:
deploy_oracle.bat

# On Linux/WSL:
./deploy_oracle.sh
```
Live instance: [https://checkyourmorpho.duckdns.org](https://checkyourmorpho.duckdns.org)



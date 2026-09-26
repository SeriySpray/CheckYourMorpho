# Технічна Специфікація Протоколу Morpho: Variable Rate Markets, Архітектура та Інтеграція

Цей документ є строгим інженерним посібником з протоколу Morpho. Він фокусується виключно на специфікації сервісів Morpho, роботі ринків зі змінною ставкою (Variable Rate Markets / Morpho Blue), математичних моделях, операційних викликах смартконтрактів та методах вибірки даних для конкретних ринкових пар через RPC, GraphQL API та SDK.

---

## 1. Специфікація Ринку зі Змінною Ставкою (Variable Rate Markets / Morpho Blue)

### 1.1 Сутність та Архітектура Ізольованого Ринку
Morpho Blue реалізує модель ізольованих ринків кредитування. На відміну від пулових протоколів (Aave, Compound), де всі активи знаходяться у спільному пулі ліквідності з перехресним ризиком зараження (cross-collateral contagion), кожен ринок у Morpho Blue є автономною парою двох активів:
- **Loan Asset (`loanToken`):** Актив, який кредитори надають під відсоток і який позичальники беруть у борг.
- **Collateral Asset (`collateralToken`):** Актив, який позичальники блокують як забезпечення. Застава не змішується з пулом позики, не позичається іншим учасникам, не приносить процентного доходу і зберігається у незмінній номінальній кількості.

#### Ключові властивості Variable Rate Markets:
1. **Ізоляція платоспроможності:** Дефолт застави, збій оракула або падіння ліквідності в одному ринку впливають виключно на постачальників цього конкретного ринку.
2. **Незмінність (Immutability):** Контракт Morpho Blue не містить проксі-шаблонів, оновлюваного коду або адміністративних ключів паузи/заморожування.
3. **Екстремальна газова оптимізація:** Усі операції ринку оптимізовані до 20,000–30,000 газу завдяки використанню єдиного Singleton-контракту та мінімалістичного коду без зайвих перевірок і циклів.

### 1.2 Ідентифікація ринку: MarketParams та MarketId
Параметри ринку визначаються незмінною структурою:

```solidity
struct MarketParams {
    address loanToken;        // Адреса ERC-20 токена позики
    address collateralToken;  // Адреса ERC-20 токена застави
    address oracle;           // Адреса оракула, що реалізує інтерфейс IOracle
    address irm;              // Адреса контракту моделі відсоткової ставки (Interest Rate Model)
    uint256 lltv;             // Liquidation Loan-to-Value (масштабовано до 1e18, наприклад: 0.86e18 для 86%)
}
```

Унікальний ідентифікатор ринку `MarketId` (тип `Id` або `bytes32`) генерується як хеш від канонічно закодованої структури:
```solidity
Id marketId = Id.wrap(keccak256(abi.encode(marketParams)));
```
Будь-яка модифікація (інша адреса оракула, зміна LLTV на 1%) формує окремий, цілком ізольований ринок.

### 1.3 Структури Даних Сховища (Storage Layout)
У Singleton-контракті `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` стан ринку зберігається у структурі `Market`:

```solidity
struct Market {
    uint128 totalSupplyAssets;  // Загальна сума токенів позики у пулі (включаючи нараховані відсотки)
    uint128 totalSupplyShares;  // Загальна кількість часток постачальників
    uint128 totalBorrowAssets;  // Загальна сума відкритого боргу (включаючи нараховані відсотки)
    uint128 totalBorrowShares;  // Загальна кількість часток боржників
    uint128 lastUpdate;         // Часова мітка останнього нарахування відсотків (UNIX timestamp)
    uint128 fee;                // Комісія протоколу для ринку (масштабована до 1e18, макс. 25%)
}
```

Позиція кожного користувача описується структурою `Position`:
```solidity
struct Position {
    uint256 supplyShares;    // Баланс часток кредитора
    uint128 borrowShares;    // Баланс часток боржника
    uint128 collateral;      // Кількість заставних токенів у точних одиницях (не в частках)
}
```

---

## 2. Математичний Апарат Variable Rate Markets

### 2.1 Механіка Часток (Shares) та Захист від Інфляційних Атак
Нарахування відсотків відбувається через безперервне зростання вартості частки відносно активу. Для унеможливлення ERC-4626 donation/inflation атак застосовуються віртуальні зміщення (+1 віртуальний актив, +1,000,000 віртуальних часток):

- **Активи постачання з часток (toSupplyAssets):**
  $$\text{assets} = \text{shares} \times \frac{\text{totalSupplyAssets} + 1}{\text{totalSupplyShares} + 10^6}$$

- **Частки постачання з активів (toSupplyShares):**
  $$\text{shares} = \text{assets} \times \frac{\text{totalSupplyShares} + 10^6}{\text{totalSupplyAssets} + 1}$$

- **Активи боргу з часток (toBorrowAssets):**
  $$\text{assets} = \text{shares} \times \frac{\text{totalBorrowAssets} + 1}{\text{totalBorrowShares} + 10^6}$$

- **Частки боргу з активів (toBorrowShares):**
  $$\text{shares} = \text{assets} \times \frac{\text{totalBorrowShares} + 10^6}{\text{totalBorrowAssets} + 1}$$

Застава (`collateral`) не конвертується у частки: вона виражається строго в абсолютній кількості найменших неподільних одиниць токена забезпечення.

### 2.2 Модель Змінної Відсоткової Ставки: AdaptiveCurveIRM
У ринках Variable Rate відсоткова ставка визначається моделлю `AdaptiveCurveIRM`, оптимізованою під цільову утилізацію капіталу:
- **Цільова утилізація ($U_{\text{target}}$):** 90% (0.90e18).
- **Поточна утилізація ($U$):**
  $$U = \frac{\text{totalBorrowAssets}}{\text{totalSupplyAssets}}$$

#### Механізм ціноутворення:
1. **Крива миттєвої ставки (Instantaneous Rate Curve):**
   - Якщо $U \le U_{\text{target}}$: ставка плавно зростає лінійно від базового значення до $R_{\text{target}}$.
   - Якщо $U > U_{\text{target}}$: ставка різко зростає за крутою експоненційною кривою до максимальної межі, мотивуючи погашення боргів і залучення ліквідності.
2. **Динамічна адаптація кривої у часі:**
   Крива не є статичною. Якщо утилізація ринку тривалий час тримається вище 90%, ставка $R_{\text{target}}$ поступово збільшується. Якщо утилізація довго знаходиться нижче 90%, ставка $R_{\text{target}}$ знижується.
3. **Функція зчитування:**
   Контракт `AdaptiveCurveIRM` надає view-метод:
   ```solidity
   function borrowRateView(MarketParams memory marketParams, Market memory market)
       external view returns (uint256);
   ```
   Він повертає ставку запозичення за секунду ($r$), масштабовану до $10^{18}$.

#### Розрахунок річних ставок (APY):
- **Borrow APY (безперервне нарахування):**
  $$\text{Borrow APY} = e^{r \times 31536000} - 1$$
- **Supply APY:**
  $$\text{Supply APY} = \text{Borrow APY} \times U \times (1 - \text{fee})$$

### 2.3 Специфікація Оракулів
Оракул зобов'язаний реалізовувати інтерфейс `IOracle`:
```solidity
interface IOracle {
    function price() external view returns (uint256);
}
```
Функція `price()` повертає вартість 1 базової одиниці `collateralToken`, виражену в базових одиницях `loanToken`, масштабовану на множник $10^{36}$:
$$\text{price} = 10^{36} \times \frac{\text{Price}_{\text{collateral}}}{\text{Price}_{\text{loan}}} \times \frac{10^{\text{Decimals}_{\text{loan}}}}{10^{\text{Decimals}_{\text{collateral}}}}$$

### 2.4 Здоров'я Позиції та Ліквідація
Позиція вважається платоспроможною, доки поточний борг у токенах позики не перевищує максимально допустимий ліміт:
$$\text{maxBorrowAssets} = \frac{\text{collateral} \times \text{price}}{10^{36}} \times \text{lltv}$$

Коефіцієнт здоров'я (Health Factor):
$$HF = \frac{\text{collateral} \times \text{price} \times \text{lltv}}{10^{36} \times \text{borrowAssets}}$$
Якщо $HF < 1.0$, позиція відкрита для ліквідації будь-яким учасником мережі.

#### Правила ліквідації:
1. **Відсутність Close Factor:** Дозволяється ліквідація до 100% заборгованості боржника за одну транзакцію.
2. **Фактор стимулювання ліквідатора (LIF):**
   $$\text{LIF} = \min\left(1.15, \frac{1}{1 - 0.3 \times (1 - \text{LLTV})}\right)$$
3. **Конфіскація застави:**
   За кожен погашений обсяг боргу ліквідатор отримує заставу на суму:
   $$\text{seizedCollateral} = \text{repaidBorrowAssets} \times \frac{10^{36}}{\text{price}} \times \text{LIF}$$
4. **Списання безнадійного боргу (Bad Debt):**
   Якщо вартості всієї застави боржника недостатньо для повного покриття боргу, застава конфіскується повністю, а залишок боргу визнається безнадійним. Сума дефіциту списується безпосередньо з `totalBorrowAssets` та `totalSupplyAssets` цього ізольованого ринку. Втрата пропорційно розподіляється виключно між постачальниками цього ринку.

---

## 3. Операції на Variable Rate Markets (Інтерфейс IMorpho)

Усі операції виконуються через виклики Singleton-контракту `IMorpho`.

### 3.1 Операції з Активом Позики (Lending / Borrowing)

#### 1. Постачання ліквідності (Supply)
Кредитор депонує токен позики (`loanToken`) для отримання відсоткового доходу.
```solidity
function supply(
    MarketParams memory marketParams,
    uint256 assets,
    uint256 shares,
    address onBehalf,
    bytes memory data
) external returns (uint256 returnAssets, uint256 returnShares);
```
- Передається або `assets` (точна сума токенів), або `shares` (частки). Непотрібний параметр вказується рівним 0.
- Якщо `data.length > 0`, контракт виконує зворотний виклик `onMorphoSupply(uint256 assets, bytes memory data)`.

#### 2. Виведення ліквідності (Withdraw)
Кредитор забирає токен позики та накопичені відсотки.
```solidity
function withdraw(
    MarketParams memory marketParams,
    uint256 assets,
    uint256 shares,
    address onBehalf,
    address receiver
) external returns (uint256 returnAssets, uint256 returnShares);
```
- Якщо `onBehalf != msg.sender`, викликач повинен мати дозвіл авторизації `isAuthorized(onBehalf, msg.sender)`.

#### 3. Взяття позики (Borrow)
Позичальник бере токен позики під раніше заблоковану заставу.
```solidity
function borrow(
    MarketParams memory marketParams,
    uint256 assets,
    uint256 shares,
    address onBehalf,
    address receiver
) external returns (uint256 returnAssets, uint256 returnShares);
```
- Контракт перевіряє умову $HF \ge 1.0$ після видачі активів на адресу `receiver`.

#### 4. Погашення боргу (Repay)
Позичальник або третя особа погашає заборгованість.
```solidity
function repay(
    MarketParams memory marketParams,
    uint256 assets,
    uint256 shares,
    address onBehalf,
    bytes memory data
) external returns (uint256 returnAssets, uint256 returnShares);
```
- Зменшує `borrowShares` користувача `onBehalf`. Підтримує callback `onMorphoRepay`.

### 3.2 Операції із Заставою (Collateral)

#### 1. Внесення застави (Supply Collateral)
```solidity
function supplyCollateral(
    MarketParams memory marketParams,
    uint256 assets,
    address onBehalf,
    bytes memory data
) external;
```
- Блокує `assets` токена `collateralToken` на балансі ринку. Підтримує callback `onMorphoSupplyCollateral`.

#### 2. Виведення застави (Withdraw Collateral)
```solidity
function withdrawCollateral(
    MarketParams memory marketParams,
    uint256 assets,
    address onBehalf,
    address receiver
) external;
```
- Перевіряє, щоб після вилучення застави позиція залишилася ліквідною: $HF \ge 1.0$.

### 3.3 Ліквідація (Liquidate)
```solidity
function liquidate(
    MarketParams memory marketParams,
    address borrower,
    uint256 seizedAssets,
    uint256 repaidShares,
    bytes memory data
) external returns (uint256 returnSeizedAssets, uint256 returnRepaidAssets);
```
- Ліквідатор вказує або обсяг застави, яку він хоче вилучити (`seizedAssets`), або частки боргу, які він повертає (`repaidShares`).
- Якщо `data.length > 0`, активується callback `onMorphoLiquidate(uint256 repaidAssets, bytes memory data)`. Контракт передає заставу ліквідатору до отримання коштів погашення, що дає змогу проводити атомарну ліквідацію з нульовим капіталом.

### 3.4 Флеш-позики (Flash Loan)
```solidity
function flashLoan(
    address token,
    uint256 assets,
    bytes memory data
) external;
```
- Надає будь-який обсяг токена `token`, наявний у Singleton-контракті.
- **Комісія становить строго 0%.** Викликає callback `onMorphoFlashLoan(uint256 assets, bytes memory data)`.

---

## 4. Отримання Даних Конкретних Пар у Variable Rate Markets

Для отримання актуальних даних по парі або ринку розробник може використовувати один із трьох каналів: прямо через RPC-вузол (on-chain), через Morpho GraphQL API або за допомогою JavaScript SDK.

### Спосіб 1: Прямий On-Chain Запит через RPC (Solidity / JavaScript Viem)
Цей метод є найнадійнішим і не залежить від доступності серверних індексаторів.

#### 1. Розрахунок MarketId:
```javascript
import { encodeAbiParameters, parseAbiParameters, keccak256 } from "viem";

export function getMarketId(marketParams) {
  const encoded = encodeAbiParameters(
    parseAbiParameters("address, address, address, address, uint256"),
    [
      marketParams.loanToken,
      marketParams.collateralToken,
      marketParams.oracle,
      marketParams.irm,
      marketParams.lltv,
    ]
  );
  return keccak256(encoded);
}
```

#### 2. Зчитування стану ринку та позиції користувача:
Для отримання повного стану пари необхідно виконати чотири виклики:
1. `morpho.market(marketId)` — поточний стан пулу.
2. `morpho.position(marketId, userAddress)` — стан балансів користувача.
3. `IOracle(oracle).price()` — актуальна ціна оракула.
4. `AdaptiveCurveIRM(irm).borrowRateView(marketParams, market)` — миттєва ставка.

#### Повний приклад на JavaScript (Node.js / Viem):
```javascript
import { createPublicClient, http, parseAbi } from "viem";
import { mainnet } from "viem/chains";

const MORPHO_BLUE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

const MORPHO_ABI = parseAbi([
  "function market(bytes32 id) external view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function position(bytes32 id, address user) external view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)"
]);

const ORACLE_ABI = parseAbi([
  "function price() external view returns (uint256)"
]);

const IRM_ABI = parseAbi([
  "function borrowRateView((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee) market) external view returns (uint256)"
]);

async function fetchPairData(client, marketParams, userAddress) {
  const marketId = getMarketId(marketParams);

  // 1. Отримуємо стан ринку, позицію користувача та ціну оракула
  const [marketData, userPosition, oraclePrice] = await Promise.all([
    client.readContract({
      address: MORPHO_BLUE,
      abi: MORPHO_ABI,
      functionName: "market",
      args: [marketId]
    }),
    client.readContract({
      address: MORPHO_BLUE,
      abi: MORPHO_ABI,
      functionName: "position",
      args: [marketId, userAddress]
    }),
    client.readContract({
      address: marketParams.oracle,
      abi: ORACLE_ABI,
      functionName: "price"
    })
  ]);

  const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = marketData;
  const [userSupplyShares, userBorrowShares, userCollateral] = userPosition;

  // 2. Отримуємо поточну ставку запозичення
  const borrowRatePerSecond = await client.readContract({
    address: marketParams.irm,
    abi: IRM_ABI,
    functionName: "borrowRateView",
    args: [marketParams, marketData]
  });

  // 3. Розрахунок активів користувача з урахуванням віртуальних зміщень
  const userBorrowAssets = totalBorrowShares > 0n
    ? (userBorrowShares * (totalBorrowAssets + 1n)) / (totalBorrowShares + 1000000n)
    : 0n;

  const userSupplyAssets = totalSupplyShares > 0n
    ? (userSupplyShares * (totalSupplyAssets + 1n)) / (totalSupplyShares + 1000000n)
    : 0n;

  // 4. Розрахунок Health Factor користувача
  let healthFactor = 0;
  if (userBorrowAssets > 0n) {
    const maxBorrow = (userCollateral * oraclePrice * marketParams.lltv) / (10n ** 36n * 10n ** 18n);
    healthFactor = Number(maxBorrow) / Number(userBorrowAssets);
  }

  // 5. Розрахунок утилізації та ставок
  const utilization = totalSupplyAssets > 0n
    ? Number(totalBorrowAssets) / Number(totalSupplyAssets)
    : 0;

  const SECONDS_PER_YEAR = 31536000;
  const ratePerSecondFloat = Number(borrowRatePerSecond) / 1e18;
  const borrowApy = Math.exp(ratePerSecondFloat * SECONDS_PER_YEAR) - 1;
  const supplyApy = borrowApy * utilization * (1 - Number(fee) / 1e18);

  return {
    marketId,
    oraclePrice,
    utilization,
    borrowApy,
    supplyApy,
    user: {
      collateral: userCollateral,
      borrowAssets: userBorrowAssets,
      supplyAssets: userSupplyAssets,
      healthFactor
    }
  };
}
```

---

### Спосіб 2: Запит через Morpho GraphQL API

Endpoint: `https://api.morpho.org/graphql`

API надає вже проіндексовані дані: ставки APY, TVL, ціну застави у USD, обсяг доступної ліквідності та розрахований коефіцієнт здоров'я позиції.

#### 1. Запит даних конкретної ринкової пари за адресами токенів:
```graphql
query GetPairMarkets($chainId: Int!, $loanToken: String!, $collateralToken: String!) {
  markets(
    where: {
      chainId_in: [$chainId]
      loanAssetAddress_in: [$loanToken]
      collateralAssetAddress_in: [$collateralToken]
    }
  ) {
    items {
      marketId
      lltv
      irmAddress
      oracle {
        address
      }
      loanAsset {
        address
        symbol
        decimals
        priceUsd
      }
      collateralAsset {
        address
        symbol
        decimals
        priceUsd
      }
      state {
        price
        utilization
        supplyAssets
        borrowAssets
        liquidityAssets
        supplyAssetsUsd
        borrowAssetsUsd
        liquidityAssetsUsd
        supplyApy
        borrowApy
        netSupplyApy
        netBorrowApy
        fee
      }
      badDebt {
        underlying
        usd
      }
    }
  }
}
```

#### 2. Запит ринку за унікальним MarketId (`uniqueKey_in`):
```graphql
query GetMarketById($chainId: Int!, $marketId: String!) {
  markets(
    where: {
      chainId_in: [$chainId]
      uniqueKey_in: [$marketId]
    }
  ) {
    items {
      marketId
      lltv
      state {
        price
        utilization
        supplyApy
        borrowApy
        supplyAssetsUsd
        borrowAssetsUsd
        liquidityAssetsUsd
      }
    }
  }
}
```

#### 3. Запит позицій користувача на ринку:
```graphql
query GetUserPairPosition($chainId: Int!, $userAddress: String!) {
  userByAddress(chainId: $chainId, address: $userAddress) {
    address
    marketPositions {
      market {
        marketId
        loanAsset {
          symbol
          decimals
        }
        collateralAsset {
          symbol
          decimals
        }
      }
      healthFactor
      priceVariationToLiquidationPrice
      state {
        collateral
        collateralUsd
        borrowAssets
        borrowAssetsUsd
        supplyAssets
        supplyAssetsUsd
      }
    }
  }
}
```

#### Приклад виконання запиту у Node.js (JavaScript):
```javascript
async function fetchMorphoApi(query, variables = {}) {
  const response = await fetch("https://api.morpho.org/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables })
  });

  const { data, errors } = await response.json();
  if (errors) throw new Error(JSON.stringify(errors));
  return data;
}

// Приклад виклику для пари wstETH/WETH на Ethereum (chainId 1)
const data = await fetchMorphoApi(GetPairMarketsDocument, {
  chainId: 1,
  loanToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",       // WETH
  collateralToken: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0"  // wstETH
});
```

---

### Спосіб 3: Запит через Офіційний JavaScript SDK (`@morpho-org/blue-sdk`)

Бібліотека `@morpho-org/blue-sdk` повністю сумісна зі стандартним JavaScript (Node.js ESM) і містить вбудовані математичні моделі та сутності `MarketParams`, `Market`, `Position`.

```javascript
import { MarketParams, Market, Position } from "@morpho-org/blue-sdk";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";

const client = createPublicClient({
  chain: mainnet,
  transport: http("https://eth.llamarpc.com")
});

async function main() {
  // 1. Ініціалізація незмінних параметрів пари
  const marketParams = new MarketParams({
    loanToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    collateralToken: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
    oracle: "0x2a01EB9496094dA03c4E364Def50f5aD1280AD72",
    irm: "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC",
    lltv: 945000000000000000n
  });

  // 2. Отримання стану ринку (автоматичний розрахунок відсотків на момент запиту)
  const market = await Market.fetch(marketParams.id, client);

  console.log("Utilization:", market.utilization);
  console.log("Borrow APY:", market.borrowApy);
  console.log("Supply APY:", market.supplyApy);
  console.log("Доступна ліквідність для позики:", market.liquidity);

  // 3. Отримання позиції конкретного гаманця
  const userAddress = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
  const position = await Position.fetch(userAddress, marketParams.id, client);

  console.log("Застава користувача:", position.collateral);
  console.log("Борг користувача:", position.borrowAssets);
  console.log("Health Factor:", position.healthFactor);
  console.log("Максимально доступно для запозичення:", position.borrowable);
}

main();
```

---

## 5. Підсумок для AI-Агентів при Роботі з Variable Rate Markets

При автоматизованій взаємодії з ринками Variable Rate агент повинен дотримуватися наступних інженерних правил:
1. **Ідентифікація через MarketId:** Будь-яка транзакція вимагає передачі точної структури `MarketParams`. Якщо `lltv` або адреса оракула не збігаються хоча б на один символ, транзакція звернеться до неіснуючого або хибного ринку.
2. **Активи проти Часток:** Завжди конвертуйте активи у частки перед відправкою, якщо потрібне повне закриття позиції, щоб уникнути залишку пилу (dust shares) через нарахування відсотків під час виконання блоку.
3. **Моніторинг ліквідності перед запозиченням:** Завжди перевіряйте `liquidityAssets = totalSupplyAssets - totalBorrowAssets`. Якщо запитувана сума позики перевищує цей залишок, транзакція `borrow` зазнає невдачі. У таких випадках слід використовувати `Public Allocator` для підтягування ліквідності зі сховищ MetaMorpho.
4. **Контроль $HF$:** При формуванні позицій позичальника орієнтуйтеся на цільовий безпечний $HF \ge 1.20$.
5. **Атомарність:** Для складних послідовностей (Permit2 + Supply Collateral + Borrow або Repay + Withdraw) завжди використовуйте офіційний контракт `Bundler3`, щоб унеможливити виконання неповного стану.

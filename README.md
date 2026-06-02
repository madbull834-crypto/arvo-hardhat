# ARVO Contracts and Frontend

ARVO is a Web3 binary matrix application with upgradeable smart contracts and a wallet-connected frontend. The current codebase supports Sepolia and BNB testnet development.

## What Is Included

```text
contracts/
  core/
    ARVOMatrix.sol        UUPS upgradeable matrix contract
    ARVOWeeklyPool.sol    UUPS upgradeable weekly reward pool
  tokens/
    ORBDToken.sol         UUPS upgradeable ORBD reward token
  mocks/
    MockUSDT.sol          Test USDT with 6 decimals

frontend/
  index.html              Arvo frontend entry
  app.js                  Wallet + contract integration
  config.js               Public frontend network/contract config
  server.js               Local static server + Etherscan logs proxy
  styles.css              Arvo UI theme

scripts/
  deploy_upgradeable.js   Production-style upgradeable deployment
  upgrade_upgradeable.js  Selected proxy upgrade script
  upgrade_matrix.js       Matrix-only upgrade helper
  verify_*.js             Verification helpers
  mint_test_usdt.js       Test USDT mint helper
```

## Install

```bash
npm install
```

Create `.env`:

```bash
cp .env.example .env
```

Fill at least:

```env
PRIVATE_KEY=your_private_key
SEPOLIA_RPC_URL=your_sepolia_rpc
BSC_TESTNET_RPC=your_bnb_testnet_rpc
ETHERSCAN_API_KEY=your_etherscan_key

USDT_ADDRESS=...
ORBD_TOKEN_ADDRESS=...
ARVO_WEEKLY_POOL_ADDRESS=...
ARVO_MATRIX_ADDRESS=...

GENESIS_ADDRESS=...
SKIP_ADMIN_1=...
SKIP_ADMIN_2=...
POOL_WEIGHTS=910,909,909,909,909,909,909,909,909,909,909
```

Never commit a real private key.

## Current Sepolia Frontend Config

The browser does not read `.env` directly. Update [frontend/config.js](frontend/config.js) after every deployment or upgrade:

```js
contracts: {
  usdt: "0xc20A8bD8f08394D727ce705712c0A0893Ff0C4D4",
  orbd: "0xE8f4e52F003273eff316C9Ef118797eD473E5198",
  weeklyPool: "0x080d32E201acDfCA15DC1ce0b4d1C878249c934b",
  matrix: "0x8E245499ac3B17795d53e136A958c4122F6b3756",
  genesis: "0xc0E6c08d2d0D8A61E43a5Dd4f3FDFF83F2079Da3"
}
```

## Compile and Test

```bash
npm run compile
npm test
```

The current full suite should pass:

```text
51 passing
```

## Upgradeable Deployment

Deploy core upgradeable contracts using existing token addresses:

```bash
npm run deploy:upgradeable:sepolia
```

Deploy test tokens and core contracts:

```bash
DEPLOY_TOKENS=true npm run deploy:upgradeable:sepolia
```

BNB testnet:

```bash
npm run deploy:upgradeable:bscTestnet
```

The deploy script prints `.env` values:

```env
USDT_ADDRESS=...
ORBD_TOKEN_ADDRESS=...
ARVO_WEEKLY_POOL_ADDRESS=...
ARVO_MATRIX_ADDRESS=...
POOL_WEIGHTS=...
VERIFY_ORBD_MOCK=false
```

## Upgrade Contracts

Validate upgrade compatibility without sending a transaction:

```bash
UPGRADE_MATRIX=true npm run validate:upgradeable:sepolia
```

Upgrade the matrix proxy:

```bash
UPGRADE_MATRIX=true npm run upgrade:upgradeable:sepolia
```

Upgrade pool and matrix:

```bash
UPGRADE_POOL=true UPGRADE_MATRIX=true npm run upgrade:upgradeable:sepolia
```

Upgrade ORBD:

```bash
UPGRADE_ORBD=true npm run upgrade:upgradeable:sepolia
```

The upgrade signer must be authorized:

```text
ARVOMatrix: owner()
ARVOWeeklyPool: DEFAULT_ADMIN_ROLE
ORBDToken: DEFAULT_ADMIN_ROLE
```

## Verify Contracts

Verify all Sepolia contracts:

```bash
npm run verify:sepolia
```

Verify separately:

```bash
npm run verify:usdt:sepolia
npm run verify:pool:sepolia
npm run verify:matrix:sepolia
```

For BNB testnet:

```bash
npm run verify:bnbTestnet
```

## Frontend

Start the frontend:

```bash
npm run frontend
```

Default URL:

```text
http://127.0.0.1:5173/
```

Use a custom port:

```bash
PORT=5176 npm run frontend
```

Frontend features:

- Wallet login with MetaMask
- Sepolia network switching
- USDT approval and registration
- Dashboard
- Direct referrals
- My Team
- Community Info
- Tree view
- Withdraw
- Referral link copy

The local server also exposes:

```text
/api/logs
```

This proxies Etherscan V2 log reads because free public RPCs often reject large `eth_getLogs` ranges.

## Test USDT

Mint test USDT to a wallet:

```bash
MINT_TO=0xYourWallet MINT_AMOUNT=100 npm run mint:usdt:sepolia
```

## Useful Diagnostics

Check contract balances:

```bash
npm run balances:sepolia
```

Diagnose registration:

```bash
REGISTER_REFERRER=0xReferrer npm run diagnose:register:sepolia
```

## Smart Contract Notes

`ARVOMatrix` business logic:

- Join fee: `10 USDT`
- Direct referral: `5 USDT`
- Auto-upgrade fund reserved in matrix: `2.5 USDT`
- Weekly pool share: `2 USDT`
- Admin share: `0.5 USDT`
- Level accounting share: `2.5 USDT`
- Upgrade payouts go to the nearest qualified upline for the upgraded level, with genesis as fallback.
- Binary tree placement: BFS
- Earning enabled after 2 directs
- Withdrawals are user-controlled

Recent UI-support upgrade adds read helpers and accounting totals:

- `getUserDashboard(address)`
- `getIncomeTotals(address)`
- `getDirectReferrals(address)`
- `getDirectReferralsPage(address,uint256,uint256)`
- `getTeamAddresses(address,uint256,uint256)`
- `totalDirectIncome(address)`
- `totalLevelIncome(address)`
- `totalSkippedIncome(address)`
- `totalWithdrawn(address)`

These additions are read/reporting focused and do not change fee distribution or placement rules.

## Production Checklist

- Use a multisig/admin wallet for upgrades.
- Validate upgrades before sending transactions.
- Verify proxy and implementation contracts.
- Keep frontend `config.js` in sync with deployed addresses.
- Use a paid/archive RPC or indexer for production analytics if event volume grows.
- Audit contracts before mainnet deployment.

/**
 * addresses.js — Canonical contract address registry
 *
 * USDT decimals on BSC: 18  (NOT 6 — BSC Binance-Peg USDT uses 18 decimals)
 * ORBD decimals: 18
 *
 * Deployment order:
 *   1. Deploy ORBDToken proxy      → fill orbd
 *   2. Deploy ARVOWeeklyPool proxy → fill weeklyPool
 *   3. Deploy ARVOMatrix proxy     → fill matrix
 *   4. Grant MATRIX_ROLE on WeeklyPool to the Matrix address
 *   5. Grant MINTER_ROLE on ORBDToken to the WeeklyPool address
 *   6. Call pool.setOrbdRate() to set the ORBD/USDT conversion rate
 *   7. Update frontend/config.js with final addresses + eventStartBlock
 */
module.exports = {
  bscTestnet: {
    // BSC Testnet USDT (18 decimals) — use a deployed mock or testnet USDT
    usdt:       "",
    orbd:       "",   // Fill after Step 1 (testnet ORBDToken proxy)
    weeklyPool: "",   // Fill after Step 2
    matrix:     "",   // Fill after Step 3
    genesis:    "",   // Genesis wallet
    multisig:   "",   // Gnosis Safe (set before mainnet)
  },
  bscMainnet: {
    // BSC Binance-Peg USDT — 18 decimals
    usdt:       "0x55d398326f99059fF775485246999027B3197955",

    // ← SET THIS: already-deployed ORBD contract address on BSC mainnet
    orbd:       "",

    weeklyPool: "",   // Fill after Step 2
    matrix:     "",   // Fill after Step 3
    genesis:    "",   // Genesis wallet
    multisig:   "",   // Gnosis Safe (required before mainnet launch)
  },
};

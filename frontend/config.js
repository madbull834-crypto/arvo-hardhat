/**
 * ARVO Frontend Configuration — BSC Testnet (chainId 97)
 *
 * After deploying with:
 *   npm run deploy:bscTestnet
 *
 * Fill in the four addresses printed at the end of the deploy output,
 * set eventStartBlock to the deployment block, then run:
 *   npm run frontend
 *
 * For BSC Mainnet production: change chainId to 56, update rpcUrl,
 * blockExplorerUrl to https://bscscan.com, and fill mainnet addresses.
 *
 * USDT decimals: 18  (MockUSDT on testnet / BSC Binance-Peg USDT on mainnet)
 * ORBD decimals: 18
 */
window.ARVO_CONFIG = {
  appName: "Arvo",
  chainId: 97,
  chainName: "BNB Smart Chain Testnet",
  rpcUrl: "https://bnb-testnet.g.alchemy.com/v2/IrhTLpsrobFqNNneeQPdr",
  nativeCurrency: {
    name: "tBNB",
    symbol: "tBNB",
    decimals: 18
  },
  blockExplorerUrl: "https://testnet.bscscan.com",
  logsApiPath: "/api/logs",
  eventStartBlock: 0,  // ← SET THIS after deploy (block of first tx)

  contracts: {
    // ← SET THIS after deploy: printed as "MockUSDT (18 dec): 0x..."
    usdt:       "",

    // ← SET THIS after deploy: printed as "MockORBDToken: 0x..."
    orbd:       "",

    // ← SET THIS after deploy: printed as "ARVOWeeklyPool: 0x..."
    weeklyPool: "",

    // ← SET THIS after deploy: printed as "ARVOMatrix: 0x..."
    matrix:     "",

    // ← SET THIS: your genesis wallet address (same as GENESIS_ADDRESS in .env)
    genesis:    "0xc0E6c08d2d0D8A61E43a5Dd4f3FDFF83F2079Da3"
  }
};

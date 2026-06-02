/**
 * deploy_sepolia.js — Full ARVO deployment for Sepolia testnet
 *
 * What this script does:
 *   1. Deploys MockUSDT  (18 decimals — matches production BSC USDT)
 *   2. Deploys MockORBDToken
 *   3. Deploys ARVOWeeklyPool UUPS proxy
 *   4. Deploys ARVOMatrix UUPS proxy
 *   5. Grants MATRIX_ROLE to ARVOMatrix on ARVOWeeklyPool
 *   6. Mints test USDT to all addresses listed in TEST_MINT_ADDRESSES (or defaults)
 *   7. Saves deployment manifest → deployments/sepolia.json
 *   8. Auto-updates frontend/config.js with the new contract addresses
 *   9. Verifies all contracts on Etherscan (skipped if SKIP_VERIFY=true)
 *
 * Required .env variables:
 *   PRIVATE_KEY          — deployer wallet key
 *   SEPOLIA_RPC_URL      — Alchemy / Infura Sepolia RPC
 *   ETHERSCAN_API_KEY    — for contract verification
 *   GENESIS_ADDRESS      — root of the binary tree
 *   SKIP_ADMIN_1         — first admin (receives half of 5% admin share)
 *   SKIP_ADMIN_2         — second admin (different from SKIP_ADMIN_1)
 *
 * Optional .env variables:
 *   TEST_MINT_ADDRESSES  — comma-separated list of wallets to receive test USDT
 *                          defaults to GENESIS_ADDRESS only
 *   TEST_USDT_AMOUNT     — USDT amount to mint per wallet (default: 10000)
 *   POOL_WEIGHTS         — 11 comma-separated integers summing to 10000
 *   ORBD_MAX_SUPPLY      — ORBD cap in 18-dec units (default: 1 billion ORBD)
 *   SKIP_VERIFY          — set to "true" to skip Etherscan verification
 *
 * Run:
 *   npx hardhat run scripts/deploy_sepolia.js --network sepolia
 */

const { ethers, network, upgrades, run } = require("hardhat");
const fs   = require("fs");
const path = require("path");

// ─── Constants ────────────────────────────────────────────────────────────────
const USDT_DECIMALS      = 18;
const DEFAULT_WEIGHTS    = [910, 909, 909, 909, 909, 909, 909, 909, 909, 909, 909];
const DEFAULT_MINT_AMOUNT = "10000";                       // 10,000 USDT per wallet
const DEFAULT_MAX_SUPPLY  = ethers.parseUnits("1000000000", 18); // 1 billion ORBD
const DEPLOYMENTS_DIR     = path.join(__dirname, "..", "deployments");
const MANIFEST_PATH       = path.join(DEPLOYMENTS_DIR, "sepolia.json");
const FRONTEND_CONFIG     = path.join(__dirname, "..", "frontend", "config.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────
function requireEnv(name) {
  const value = process.env[name];
  if (!value || !ethers.isAddress(value)) {
    throw new Error(
      `${name} must be set to a valid Ethereum address in .env\n` +
      `  Current value: "${value || "(not set)}"`
    );
  }
  return ethers.getAddress(value);
}

function parseWeights() {
  const raw = process.env.POOL_WEIGHTS;
  if (!raw) return DEFAULT_WEIGHTS;
  const weights = raw.split(",").map(w => Number(w.trim()));
  if (weights.length !== 11 || weights.some(w => !Number.isInteger(w) || w < 0))
    throw new Error("POOL_WEIGHTS must be exactly 11 non-negative integers");
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum !== 10000) throw new Error(`POOL_WEIGHTS sum must be 10000 (got ${sum})`);
  return weights;
}

function parseMintAddresses(genesisAddress) {
  const raw = process.env.TEST_MINT_ADDRESSES || "";
  const addresses = raw
    .split(",")
    .map(a => a.trim())
    .filter(a => ethers.isAddress(a))
    .map(a => ethers.getAddress(a));

  // Always include genesis
  if (!addresses.some(a => a.toLowerCase() === genesisAddress.toLowerCase())) {
    addresses.unshift(genesisAddress);
  }
  return [...new Set(addresses)];
}

function log(msg) { console.log(msg); }
function step(msg) { console.log(`\n${"─".repeat(60)}\n  ${msg}\n${"─".repeat(60)}`); }

async function waitConfirms(tx, label) {
  log(`  TX: ${tx.hash}`);
  const receipt = await tx.wait(1);
  log(`  ${label} confirmed in block ${receipt.blockNumber}`);
  return receipt;
}

// ─── Deploy mock tokens ───────────────────────────────────────────────────────
async function deployMockTokens(deployer, genesisAddress) {
  step("Step 1: Deploy MockUSDT (18 decimals)");
  const MockUSDT = await ethers.getContractFactory("MockUSDT");
  const usdt = await MockUSDT.connect(deployer).deploy();
  await usdt.waitForDeployment();
  const usdtAddress = await usdt.getAddress();
  log(`  MockUSDT deployed: ${usdtAddress}`);

  step("Step 2: Deploy MockORBDToken");
  const MockORBD = await ethers.getContractFactory("MockORBDToken");
  const orbd = await MockORBD.connect(deployer).deploy();
  await orbd.waitForDeployment();
  const orbdAddress = await orbd.getAddress();
  log(`  MockORBDToken deployed: ${orbdAddress}`);

  return { usdt, usdtAddress, orbd, orbdAddress };
}

// ─── Mint test USDT ───────────────────────────────────────────────────────────
async function mintTestUsdt(usdt, recipients, deployer) {
  step("Step 3: Mint test USDT");
  const amount = ethers.parseUnits(
    process.env.TEST_USDT_AMOUNT || DEFAULT_MINT_AMOUNT,
    USDT_DECIMALS
  );
  const formatted = ethers.formatUnits(amount, USDT_DECIMALS);

  for (const addr of recipients) {
    const tx = await usdt.connect(deployer).mint(addr, amount);
    await waitConfirms(tx, `Minted ${formatted} USDT → ${addr}`);
  }
}

// ─── Deploy core contracts ────────────────────────────────────────────────────
async function deployWeeklyPool(deployer, usdtAddress, orbdAddress, weights) {
  step("Step 4: Deploy ARVOWeeklyPool (UUPS proxy)");
  const Factory = await ethers.getContractFactory("ARVOWeeklyPool");
  const proxy = await upgrades.deployProxy(
    Factory,
    [usdtAddress, orbdAddress, weights],
    { kind: "uups", redeployImplementation: "always" }
  );
  await proxy.waitForDeployment();
  const proxyAddress = await proxy.getAddress();
  const implAddress  = await upgrades.erc1967.getImplementationAddress(proxyAddress);

  log(`  ARVOWeeklyPool proxy:          ${proxyAddress}`);
  log(`  ARVOWeeklyPool implementation: ${implAddress}`);
  return { proxy, proxyAddress, implAddress };
}

async function deployMatrix(deployer, usdtAddress, poolAddress, genesis, admin1, admin2) {
  step("Step 5: Deploy ARVOMatrix (UUPS proxy)");
  const Factory = await ethers.getContractFactory("ARVOMatrix");
  const proxy = await upgrades.deployProxy(
    Factory,
    [usdtAddress, poolAddress, genesis, admin1, admin2],
    { kind: "uups", redeployImplementation: "always" }
  );
  await proxy.waitForDeployment();
  const proxyAddress = await proxy.getAddress();
  const implAddress  = await upgrades.erc1967.getImplementationAddress(proxyAddress);

  log(`  ARVOMatrix proxy:          ${proxyAddress}`);
  log(`  ARVOMatrix implementation: ${implAddress}`);
  return { proxy, proxyAddress, implAddress };
}

// ─── Grant roles ──────────────────────────────────────────────────────────────
async function grantRoles(pool, matrixAddress, deployer) {
  step("Step 6: Grant MATRIX_ROLE to ARVOMatrix on ARVOWeeklyPool");
  const role = await pool.MATRIX_ROLE();
  const tx   = await pool.connect(deployer).grantRole(role, matrixAddress);
  await waitConfirms(tx, `MATRIX_ROLE (${role.slice(0, 10)}…) granted to ${matrixAddress}`);
}

// ─── Save manifest ────────────────────────────────────────────────────────────
function saveManifest(manifest) {
  if (!fs.existsSync(DEPLOYMENTS_DIR)) fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  log(`  Manifest saved: ${MANIFEST_PATH}`);
}

// ─── Update frontend/config.js ────────────────────────────────────────────────
function updateFrontendConfig(addresses) {
  step("Step 7: Update frontend/config.js");

  const config = `/**
 * ARVO Frontend Configuration — Sepolia Testnet
 *
 * Auto-generated by scripts/deploy_sepolia.js at ${new Date().toISOString()}
 * Network : Sepolia (chainId 11155111)
 *
 * MockUSDT uses 18 decimals to match production BSC USDT.
 * ORBD uses 18 decimals.
 */
window.ARVO_CONFIG = {
  appName: "Arvo",
  chainId: 11155111,
  chainName: "Sepolia",
  rpcUrl: "${process.env.SEPOLIA_RPC_URL || "https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY"}",
  nativeCurrency: {
    name: "Sepolia ETH",
    symbol: "ETH",
    decimals: 18
  },
  blockExplorerUrl: "https://sepolia.etherscan.io",
  logsApiPath: "/api/logs",
  eventStartBlock: ${addresses.deployBlock},

  contracts: {
    usdt:       "${addresses.usdt}",
    orbd:       "${addresses.orbd}",
    weeklyPool: "${addresses.weeklyPool}",
    matrix:     "${addresses.matrix}",
    genesis:    "${addresses.genesis}"
  }
};
`;

  fs.writeFileSync(FRONTEND_CONFIG, config);
  log(`  frontend/config.js updated with Sepolia addresses`);
}

// ─── Etherscan verification ───────────────────────────────────────────────────
async function verifyContract(label, address, contractPath, constructorArgs = []) {
  log(`  Verifying ${label} at ${address}…`);
  try {
    await run("verify:verify", {
      address,
      contract: contractPath,
      constructorArguments: constructorArgs,
    });
    log(`  ${label}: verified ✓`);
  } catch (err) {
    const msg = err.message || "";
    if (msg.includes("already verified") || msg.includes("Already Verified")) {
      log(`  ${label}: already verified ✓`);
    } else {
      log(`  ${label}: verification failed — ${msg}`);
      log(`  Retry manually: npx hardhat verify --network sepolia ${address}`);
    }
  }
}

async function verifyAll(addresses) {
  if (process.env.SKIP_VERIFY === "true") {
    log("  SKIP_VERIFY=true — skipping Etherscan verification");
    return;
  }

  step("Step 8: Verify contracts on Etherscan");
  log("  Waiting 30 seconds for Etherscan to index the blocks…");
  await new Promise(r => setTimeout(r, 30_000));

  await verifyContract(
    "MockUSDT",
    addresses.usdt,
    "contracts/mocks/MockUSDT.sol:MockUSDT"
  );

  await verifyContract(
    "MockORBDToken",
    addresses.orbd,
    "contracts/mocks/MockORBDToken.sol:MockORBDToken"
  );

  // UUPS proxies: verify the implementation contract, not the proxy
  await verifyContract(
    "ARVOWeeklyPool implementation",
    addresses.weeklyPoolImpl,
    "contracts/core/ARVOWeeklyPool.sol:ARVOWeeklyPool"
  );

  await verifyContract(
    "ARVOMatrix implementation",
    addresses.matrixImpl,
    "contracts/core/ARVOMatrix.sol:ARVOMatrix"
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (network.name !== "sepolia") {
    throw new Error(
      `This script is for Sepolia only. ` +
      `Got network: "${network.name}". ` +
      `Run with --network sepolia`
    );
  }

  const [deployer] = await ethers.getSigners();
  const balance    = await ethers.provider.getBalance(deployer.address);

  log(`\n${"═".repeat(60)}`);
  log(`  ARVO Sepolia Deployment`);
  log(`${"═".repeat(60)}`);
  log(`  Network:  ${network.name}`);
  log(`  Deployer: ${deployer.address}`);
  log(`  Balance:  ${ethers.formatEther(balance)} ETH`);

  if (balance < ethers.parseEther("0.05")) {
    throw new Error(
      `Deployer balance too low: ${ethers.formatEther(balance)} ETH. ` +
      `Need at least 0.05 ETH. Get Sepolia ETH from https://sepoliafaucet.com`
    );
  }

  // ── Read config ─────────────────────────────────────────────────────────────
  const genesisAddress = requireEnv("GENESIS_ADDRESS");
  const skipAdmin1     = requireEnv("SKIP_ADMIN_1");
  const skipAdmin2     = requireEnv("SKIP_ADMIN_2");

  if (skipAdmin1.toLowerCase() === skipAdmin2.toLowerCase()) {
    throw new Error("SKIP_ADMIN_1 and SKIP_ADMIN_2 must be different addresses");
  }

  const weights    = parseWeights();
  const mintTo     = parseMintAddresses(genesisAddress);

  log(`  Genesis:  ${genesisAddress}`);
  log(`  Admin 1:  ${skipAdmin1}`);
  log(`  Admin 2:  ${skipAdmin2}`);
  log(`  Weights:  [${weights.join(", ")}]`);
  log(`  Mint to:  ${mintTo.join(", ")}`);

  // ── Deploy ──────────────────────────────────────────────────────────────────
  const { usdt, usdtAddress, orbd, orbdAddress } = await deployMockTokens(deployer, genesisAddress);
  await mintTestUsdt(usdt, mintTo, deployer);

  const { proxy: pool, proxyAddress: poolAddress, implAddress: poolImpl } =
    await deployWeeklyPool(deployer, usdtAddress, orbdAddress, weights);

  const { proxy: matrix, proxyAddress: matrixAddress, implAddress: matrixImpl } =
    await deployMatrix(deployer, usdtAddress, poolAddress, genesisAddress, skipAdmin1, skipAdmin2);

  await grantRoles(pool, matrixAddress, deployer);

  // ── Capture deploy block ─────────────────────────────────────────────────────
  const deployBlock = await ethers.provider.getBlockNumber();

  // ── Build manifest ───────────────────────────────────────────────────────────
  const manifest = {
    network:     network.name,
    chainId:     11155111,
    deployedAt:  new Date().toISOString(),
    deployBlock,
    deployer:    deployer.address,
    genesis:     genesisAddress,
    skipAdmin1,
    skipAdmin2,
    contracts: {
      usdt:           usdtAddress,
      orbd:           orbdAddress,
      weeklyPool:     poolAddress,
      weeklyPoolImpl: poolImpl,
      matrix:         matrixAddress,
      matrixImpl,
    },
    poolWeights: weights,
  };

  // ── Save artifacts ───────────────────────────────────────────────────────────
  step("Saving deployment artifacts");
  saveManifest(manifest);

  updateFrontendConfig({
    usdt:           usdtAddress,
    orbd:           orbdAddress,
    weeklyPool:     poolAddress,
    weeklyPoolImpl: poolImpl,
    matrix:         matrixAddress,
    matrixImpl,
    genesis:        genesisAddress,
    deployBlock,
  });

  // ── Verify ───────────────────────────────────────────────────────────────────
  await verifyAll({
    usdt:           usdtAddress,
    orbd:           orbdAddress,
    weeklyPool:     poolAddress,
    weeklyPoolImpl: poolImpl,
    matrix:         matrixAddress,
    matrixImpl,
  });

  // ── Final summary ─────────────────────────────────────────────────────────────
  log(`\n${"═".repeat(60)}`);
  log(`  DEPLOYMENT COMPLETE`);
  log(`${"═".repeat(60)}`);
  log(`  MockUSDT (18 dec):     ${usdtAddress}`);
  log(`  MockORBDToken:         ${orbdAddress}`);
  log(`  ARVOWeeklyPool proxy:  ${poolAddress}`);
  log(`  ARVOMatrix proxy:      ${matrixAddress}`);
  log(`  Genesis:               ${genesisAddress}`);
  log(`  Deploy block:          ${deployBlock}`);
  log(`\n  frontend/config.js has been updated automatically.`);
  log(`  Run the frontend: npm run frontend`);
  log(`  View on Etherscan:     https://sepolia.etherscan.io/address/${matrixAddress}`);

  log(`\n  Copy these into your .env (update existing values):`);
  log(`  USDT_ADDRESS=${usdtAddress}`);
  log(`  ORBD_TOKEN_ADDRESS=${orbdAddress}`);
  log(`  ARVO_WEEKLY_POOL_ADDRESS=${poolAddress}`);
  log(`  ARVO_MATRIX_ADDRESS=${matrixAddress}`);
  log(`  EVENT_START_BLOCK=${deployBlock}`);
  log(`${"═".repeat(60)}\n`);
}

main().catch(err => {
  console.error("\nDEPLOYMENT FAILED:", err.message || err);
  process.exit(1);
});

/**
 * Deploy ARVO core contracts on BNB Smart Chain mainnet.
 *
 * This script is production-only:
 *   - Uses real BSC USDT only.
 *   - Does not deploy mock tokens.
 *   - Requires an existing ORBD token address.
 *   - Configures PancakeSwap V2 buy mode by default.
 *   - Optionally configures the PancakeSwap V2 ORBD/USDT pair oracle.
 *   - Optionally hands upgrade/admin control to FINAL_ADMIN_ADDRESS.
 *
 * Run:
 *   npx hardhat run scripts/deploy_bsc_mainnet.js --network bscMainnet
 */
const { ethers, network, upgrades, run } = require("hardhat");
const fs = require("fs");
const path = require("path");

const BSC_MAINNET_CHAIN_ID = 56;
const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955";
const PANCAKE_V2_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const DEFAULT_POOL_WEIGHTS = [910, 909, 909, 909, 909, 909, 909, 909, 909, 909, 909];
const DEFAULT_ORACLE_MIN_TWAP_INTERVAL = 24 * 60 * 60;
const DEFAULT_ORACLE_MAX_AGE = 9 * 24 * 60 * 60;
const DEFAULT_ORACLE_MAX_RATE_CHANGE_BPS = 2000;
const DEFAULT_SWAP_MIN_OUT_BPS = 9500;
const MIN_RECOMMENDED_BNB = ethers.parseEther("0.25");

const DEPLOYMENTS_DIR = path.join(__dirname, "..", "deployments");
const MANIFEST_PATH = path.join(DEPLOYMENTS_DIR, "bscMainnet.json");

function requireAddress(name) {
  const value = process.env[name];
  if (!ethers.isAddress(value || "")) {
    throw new Error(`${name} must be set to a valid address`);
  }
  return ethers.getAddress(value);
}

function requireEnvNotEnabled(name) {
  if (process.env[name] === "true") {
    throw new Error(`Refusing mainnet deploy: ${name}=true`);
  }
}

function optionalAddress(name) {
  const value = process.env[name];
  if (!value) return undefined;
  if (!ethers.isAddress(value)) throw new Error(`${name} must be a valid address`);
  return ethers.getAddress(value);
}

function optionalHandoffAddress() {
  const finalAdmin = process.env.FINAL_ADMIN_ADDRESS || "";
  if (finalAdmin) {
    if (!ethers.isAddress(finalAdmin)) throw new Error("FINAL_ADMIN_ADDRESS must be a valid address");
    return ethers.getAddress(finalAdmin);
  }

  const multisig = process.env.MULTISIG_ADDRESS || "";
  if (!multisig || multisig === "your_gnosis_safe_here") return undefined;
  if (!ethers.isAddress(multisig)) throw new Error("MULTISIG_ADDRESS must be a valid address");
  return ethers.getAddress(multisig);
}

function envFlag(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  if (value !== "true" && value !== "false") {
    throw new Error(`${name} must be true or false`);
  }
  return value === "true";
}

function parseUintEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function parsePoolWeights() {
  const raw = process.env.POOL_WEIGHTS;
  if (!raw) return DEFAULT_POOL_WEIGHTS;

  const weights = raw.split(",").map((item) => Number(item.trim()));
  const sum = weights.reduce((total, item) => total + item, 0);

  if (weights.length !== 11 || weights.some((item) => !Number.isInteger(item) || item < 0)) {
    throw new Error("POOL_WEIGHTS must contain exactly 11 non-negative integers");
  }
  if (sum !== 10000) throw new Error(`POOL_WEIGHTS must sum to 10000, got ${sum}`);

  return weights;
}

function parseSwapPath(usdtAddress, orbdAddress) {
  const raw = process.env.PANCAKE_SWAP_PATH;
  if (!raw) return [usdtAddress, orbdAddress];

  const path = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (path.length < 2 || path.some((item) => !ethers.isAddress(item))) {
    throw new Error("PANCAKE_SWAP_PATH must contain comma-separated token addresses");
  }

  return path.map((item) => ethers.getAddress(item));
}

async function wait(tx, label) {
  console.log(`  TX: ${tx.hash}`);
  const receipt = await tx.wait(2);
  console.log(`  ${label} confirmed in block ${receipt.blockNumber}`);
  return receipt;
}

async function requireMainnet(deployer) {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (network.name !== "bscMainnet" || chainId !== BSC_MAINNET_CHAIN_ID) {
    throw new Error(`Refusing deploy: expected bscMainnet chainId 56, got ${network.name} chainId ${chainId}`);
  }

  requireEnvNotEnabled("DEPLOY_MOCK_TOKENS");
  requireEnvNotEnabled("DEPLOY_TOKENS");
  requireEnvNotEnabled("VERIFY_ORBD_MOCK");

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Network:", network.name);
  console.log("Chain ID:", chainId);
  console.log("Deployer:", deployer.address);
  console.log("BNB balance:", ethers.formatEther(balance));

  if (balance < MIN_RECOMMENDED_BNB) {
    console.log(
      `Warning: deployer BNB balance is below the recommended ${ethers.formatEther(MIN_RECOMMENDED_BNB)} BNB.`
    );
  }
}

async function requireContractCode(label, address) {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") {
    throw new Error(`${label} has no contract code at ${address}`);
  }
}

async function validateToken(label, address, expectedSymbol) {
  await requireContractCode(label, address);
  const token = await ethers.getContractAt(
    [
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)",
    ],
    address
  );

  const symbol = await token.symbol();
  const decimals = await token.decimals();
  console.log(`${label}: ${address} (${symbol}, ${decimals} decimals)`);

  if (expectedSymbol && symbol.toUpperCase() !== expectedSymbol.toUpperCase()) {
    console.log(`Warning: ${label} symbol is ${symbol}, expected ${expectedSymbol}.`);
  }
  if (decimals !== 18n && decimals !== 18) {
    throw new Error(`${label} must use 18 decimals for this contract version, got ${decimals}`);
  }
}

async function validatePancakeRouter(router) {
  await requireContractCode("Pancake router", router);
  const routerContract = await ethers.getContractAt(
    ["function factory() view returns (address)", "function WETH() view returns (address)"],
    router
  );
  const factory = await routerContract.factory();
  const weth = await routerContract.WETH();
  await requireContractCode("Pancake factory", factory);
  await requireContractCode("Pancake WBNB", weth);
  console.log("Pancake router:", router);
  console.log("Pancake factory:", factory);
  console.log("Pancake WBNB:", weth);
}

async function validatePancakePair(pairAddress, usdtAddress, orbdAddress) {
  if (!pairAddress) return;

  await requireContractCode("Pancake ORBD/USDT pair", pairAddress);
  const pair = await ethers.getContractAt(
    [
      "function token0() view returns (address)",
      "function token1() view returns (address)",
      "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
    ],
    pairAddress
  );

  const token0 = ethers.getAddress(await pair.token0());
  const token1 = ethers.getAddress(await pair.token1());
  const validPair =
    (token0 === usdtAddress && token1 === orbdAddress) ||
    (token0 === orbdAddress && token1 === usdtAddress);
  if (!validPair) {
    throw new Error(`ORBD_USDT_PAIR_ADDRESS is not a USDT/ORBD pair. token0=${token0}, token1=${token1}`);
  }

  const reserves = await pair.getReserves();
  if (reserves.reserve0 === 0n || reserves.reserve1 === 0n) {
    throw new Error("ORBD/USDT pair has zero reserves");
  }

  console.log("Pancake ORBD/USDT pair:", pairAddress);
  console.log("Pair token0:", token0);
  console.log("Pair token1:", token1);
}

async function validatePreflight(usdtAddress, orbdAddress) {
  console.log("\nPreflight checks...");
  await validateToken("BSC USDT", usdtAddress, "USDT");
  await validateToken("ORBD token", orbdAddress, "ORBD");

  const router = optionalAddress("PANCAKE_ROUTER_ADDRESS") || PANCAKE_V2_ROUTER;
  await validatePancakeRouter(router);

  const swapPath = parseSwapPath(usdtAddress, orbdAddress);
  if (swapPath[0] !== usdtAddress || swapPath[swapPath.length - 1] !== orbdAddress) {
    throw new Error("PANCAKE_SWAP_PATH must start with USDT_ADDRESS and end with ORBD_TOKEN_ADDRESS");
  }
  for (const tokenAddress of swapPath) {
    await requireContractCode("Swap path token", tokenAddress);
  }
  console.log("Pancake swap path:", swapPath.join(" -> "));

  await validatePancakePair(optionalAddress("ORBD_USDT_PAIR_ADDRESS"), usdtAddress, orbdAddress);
}

async function grantOrbdMinter(orbdAddress, poolAddress) {
  try {
    const orbd = await ethers.getContractAt("ORBDToken", orbdAddress);
    const minterRole = await orbd.MINTER_ROLE();
    const tx = await orbd.grantRole(minterRole, poolAddress);
    await wait(tx, "ORBD MINTER_ROLE granted to ARVOWeeklyPool");
    return true;
  } catch (error) {
    console.log("ORBD MINTER_ROLE was not granted automatically.");
    console.log("Reason:", error.shortMessage || error.message);
    console.log("Grant it manually before weekly ORBD distribution if this wallet is not ORBD admin.");
    return false;
  }
}

async function configureOracle(pool) {
  const pairAddress = optionalAddress("ORBD_USDT_PAIR_ADDRESS");
  if (!pairAddress) {
    console.log("Pancake oracle not configured: ORBD_USDT_PAIR_ADDRESS is not set.");
    return {
      pair: "",
      minTwapInterval: 0,
      maxAge: 0,
      maxRateChangeBps: 0,
    };
  }

  const minTwapInterval = parseUintEnv("ORACLE_MIN_TWAP_INTERVAL", DEFAULT_ORACLE_MIN_TWAP_INTERVAL);
  const maxAge = parseUintEnv("ORACLE_MAX_AGE", DEFAULT_ORACLE_MAX_AGE);
  const maxRateChangeBps = parseUintEnv("ORACLE_MAX_RATE_CHANGE_BPS", DEFAULT_ORACLE_MAX_RATE_CHANGE_BPS);

  const tx = await pool.configurePancakeOracle(
    pairAddress,
    minTwapInterval,
    maxAge,
    maxRateChangeBps
  );
  await wait(tx, `Pancake ORBD/USDT oracle configured: ${pairAddress}`);

  return { pair: pairAddress, minTwapInterval, maxAge, maxRateChangeBps };
}

async function configurePancakeBuy(pool, usdtAddress, orbdAddress) {
  const router = optionalAddress("PANCAKE_ROUTER_ADDRESS") || PANCAKE_V2_ROUTER;
  const path = parseSwapPath(usdtAddress, orbdAddress);
  const minOutBps = parseUintEnv("PANCAKE_SWAP_MIN_OUT_BPS", DEFAULT_SWAP_MIN_OUT_BPS);
  const enabled = envFlag("ENABLE_PANCAKE_BUY", true);

  const tx = await pool.configurePancakeSwap(router, path, minOutBps, enabled);
  await wait(tx, `Pancake buy mode configured: router ${router}`);

  return { router, path, minOutBps, enabled };
}

async function grantOperationalRoles(pool) {
  const granted = {};

  const rateUpdater = optionalAddress("RATE_UPDATER_ADDRESS");
  if (rateUpdater) {
    const role = await pool.RATE_UPDATER_ROLE();
    await wait(await pool.grantRole(role, rateUpdater), `RATE_UPDATER_ROLE granted to ${rateUpdater}`);
    granted.rateUpdater = rateUpdater;
  }

  const distributor = optionalAddress("DISTRIBUTOR_ADDRESS");
  if (distributor) {
    const role = await pool.DISTRIBUTOR_ROLE();
    await wait(await pool.grantRole(role, distributor), `DISTRIBUTOR_ROLE granted to ${distributor}`);
    granted.distributor = distributor;
  }

  return granted;
}

async function verifyOne(label, address, contract) {
  if (process.env.SKIP_VERIFY === "true") {
    console.log(`${label}: verification skipped`);
    return;
  }

  try {
    console.log(`${label}: verifying ${address}...`);
    await run("verify:verify", { address, contract });
    console.log(`${label}: verified`);
  } catch (error) {
    const message = error.message || "";
    if (message.toLowerCase().includes("already verified")) {
      console.log(`${label}: already verified`);
      return;
    }
    console.log(`${label}: verification failed`);
    console.log(error.shortMessage || error.message);
  }
}

async function handoffAdmin(pool, matrix, deployerAddress) {
  const finalAdmin = optionalHandoffAddress();
  if (!finalAdmin) {
    console.log("Admin handoff skipped: FINAL_ADMIN_ADDRESS/MULTISIG_ADDRESS is not set.");
    return { finalAdmin: "", deployerPoolAdminRevoked: false, matrixOwnershipTransferred: false };
  }

  if (finalAdmin === deployerAddress) {
    console.log("Admin handoff skipped: final admin is the deployer.");
    return { finalAdmin, deployerPoolAdminRevoked: false, matrixOwnershipTransferred: false };
  }

  console.log("\nHanding off admin control...");
  const defaultAdminRole = await pool.DEFAULT_ADMIN_ROLE();
  const hasPoolAdmin = await pool.hasRole(defaultAdminRole, finalAdmin);
  if (!hasPoolAdmin) {
    await wait(await pool.grantRole(defaultAdminRole, finalAdmin), `Pool DEFAULT_ADMIN_ROLE granted to ${finalAdmin}`);
  }

  await wait(await matrix.transferOwnership(finalAdmin), `Matrix ownership transferred to ${finalAdmin}`);

  let deployerPoolAdminRevoked = false;
  if (envFlag("REVOKE_DEPLOYER_POOL_ADMIN", false)) {
    await wait(
      await pool.revokeRole(defaultAdminRole, deployerAddress),
      "Deployer pool DEFAULT_ADMIN_ROLE revoked"
    );
    deployerPoolAdminRevoked = true;
  }

  return { finalAdmin, deployerPoolAdminRevoked, matrixOwnershipTransferred: true };
}

function saveManifest(manifest) {
  fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log("Manifest saved:", MANIFEST_PATH);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  await requireMainnet(deployer);

  const usdtAddress = requireAddress("USDT_ADDRESS");
  if (usdtAddress.toLowerCase() !== BSC_USDT.toLowerCase()) {
    throw new Error(`USDT_ADDRESS must be BSC mainnet USDT: ${BSC_USDT}`);
  }

  const orbdAddress = requireAddress("ORBD_TOKEN_ADDRESS");
  const genesis = requireAddress("GENESIS_ADDRESS");
  const skipAdmin1 = requireAddress("SKIP_ADMIN_1");
  const skipAdmin2 = requireAddress("SKIP_ADMIN_2");
  if (skipAdmin1.toLowerCase() === skipAdmin2.toLowerCase()) {
    throw new Error("SKIP_ADMIN_1 and SKIP_ADMIN_2 must be different");
  }

  const weights = parsePoolWeights();
  await validatePreflight(usdtAddress, orbdAddress);

  console.log("\nDeploying ARVOWeeklyPool proxy...");
  const PoolFactory = await ethers.getContractFactory("ARVOWeeklyPool");
  const pool = await upgrades.deployProxy(PoolFactory, [usdtAddress, orbdAddress, weights], {
    kind: "uups",
    redeployImplementation: "always",
  });
  await pool.waitForDeployment();
  const poolAddress = await pool.getAddress();
  const poolImplementation = await upgrades.erc1967.getImplementationAddress(poolAddress);
  const poolReceipt = await pool.deploymentTransaction().wait(2);
  console.log("ARVO_WEEKLY_POOL_ADDRESS=", poolAddress);
  console.log("ARVO_WEEKLY_POOL_IMPLEMENTATION=", poolImplementation);

  const minterGranted = await grantOrbdMinter(orbdAddress, poolAddress);
  const pancakeBuy = await configurePancakeBuy(pool, usdtAddress, orbdAddress);
  const oracle = await configureOracle(pool);
  const roles = await grantOperationalRoles(pool);

  console.log("\nDeploying ARVOMatrix proxy...");
  const MatrixFactory = await ethers.getContractFactory("ARVOMatrix");
  const matrix = await upgrades.deployProxy(
    MatrixFactory,
    [usdtAddress, poolAddress, genesis, skipAdmin1, skipAdmin2],
    { kind: "uups", redeployImplementation: "always" }
  );
  await matrix.waitForDeployment();
  const matrixAddress = await matrix.getAddress();
  const matrixImplementation = await upgrades.erc1967.getImplementationAddress(matrixAddress);
  const matrixReceipt = await matrix.deploymentTransaction().wait(2);
  console.log("ARVO_MATRIX_ADDRESS=", matrixAddress);
  console.log("ARVO_MATRIX_IMPLEMENTATION=", matrixImplementation);

  const matrixRole = await pool.MATRIX_ROLE();
  await wait(await pool.grantRole(matrixRole, matrixAddress), "MATRIX_ROLE granted to ARVOMatrix");
  const adminHandoff = await handoffAdmin(pool, matrix, deployer.address);

  const deployBlock = Math.min(poolReceipt.blockNumber, matrixReceipt.blockNumber);
  const manifest = {
    network: "bscMainnet",
    chainId: BSC_MAINNET_CHAIN_ID,
    deployedAt: new Date().toISOString(),
    deployBlock,
    deployer: deployer.address,
    genesis,
    skipAdmin1,
    skipAdmin2,
    contracts: {
      usdt: usdtAddress,
      orbd: orbdAddress,
      oraclePair: oracle.pair,
      weeklyPool: poolAddress,
      weeklyPoolImpl: poolImplementation,
      matrix: matrixAddress,
      matrixImpl: matrixImplementation,
    },
    poolWeights: weights,
    oracle,
    pancakeBuy,
    roles,
    adminHandoff,
    minterGranted,
  };

  saveManifest(manifest);

  await verifyOne("ARVOWeeklyPool implementation", poolImplementation, "contracts/core/ARVOWeeklyPool.sol:ARVOWeeklyPool");
  await verifyOne("ARVOMatrix implementation", matrixImplementation, "contracts/core/ARVOMatrix.sol:ARVOMatrix");

  console.log("\nCopy these into .env:");
  console.log(`USDT_ADDRESS=${usdtAddress}`);
  console.log(`ORBD_TOKEN_ADDRESS=${orbdAddress}`);
  if (oracle.pair) console.log(`ORBD_USDT_PAIR_ADDRESS=${oracle.pair}`);
  console.log(`PANCAKE_ROUTER_ADDRESS=${pancakeBuy.router}`);
  console.log(`PANCAKE_SWAP_PATH=${pancakeBuy.path.join(",")}`);
  console.log(`PANCAKE_SWAP_MIN_OUT_BPS=${pancakeBuy.minOutBps}`);
  console.log(`ENABLE_PANCAKE_BUY=${pancakeBuy.enabled}`);
  if (adminHandoff.finalAdmin) console.log(`FINAL_ADMIN_ADDRESS=${adminHandoff.finalAdmin}`);
  console.log(`ARVO_WEEKLY_POOL_ADDRESS=${poolAddress}`);
  console.log(`ARVO_MATRIX_ADDRESS=${matrixAddress}`);
  console.log(`EVENT_START_BLOCK=${deployBlock}`);
  console.log(`ORACLE_MIN_TWAP_INTERVAL=${oracle.minTwapInterval}`);
  console.log(`ORACLE_MAX_AGE=${oracle.maxAge}`);
  console.log(`ORACLE_MAX_RATE_CHANGE_BPS=${oracle.maxRateChangeBps}`);
  console.log("\nNext:");
  console.log("  npm run sync:frontend:bscMainnet");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

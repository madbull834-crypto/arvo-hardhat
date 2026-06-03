/**
 * Full testnet deployment for ARVO using standard Hardhat.
 *
 * Usage:
 *   npx hardhat run scripts/deploy_testnet_full.js --network sepolia
 *
 * Required:
 *   PRIVATE_KEY, SEPOLIA_RPC_URL, GENESIS_ADDRESS, SKIP_ADMIN_1, SKIP_ADMIN_2
 *
 * Optional:
 *   USDT_ADDRESS, ORBD_TOKEN_ADDRESS
 *   DEPLOY_MOCK_TOKENS=true
 *   POOL_WEIGHTS=910,909,909,909,909,909,909,909,909,909,909
 *   ORBD_USDT_PAIR_ADDRESS=<PancakeSwap V2 ORBD/USDT pair>
 *   ORACLE_MIN_TWAP_INTERVAL=86400
 *   ORACLE_MAX_AGE=777600
 *   ORACLE_MAX_RATE_CHANGE_BPS=2000
 *   RATE_UPDATER_ADDRESS=<keeper wallet>
 *   DISTRIBUTOR_ADDRESS=<weekly distribution wallet>
 */
const { ethers, network, upgrades } = require("hardhat");

const USDT_DECIMALS = 18; // BSC USDT uses 18 decimals
const DEFAULT_POOL_WEIGHTS = [910, 909, 909, 909, 909, 909, 909, 909, 909, 909, 909];
const DEFAULT_ORACLE_MIN_TWAP_INTERVAL = 24 * 60 * 60;
const DEFAULT_ORACLE_MAX_AGE = 9 * 24 * 60 * 60;
const DEFAULT_ORACLE_MAX_RATE_CHANGE_BPS = 2000;

function requiredAddress(name) {
  const value = process.env[name];
  if (!value || !ethers.isAddress(value)) {
    throw new Error(`${name} must be set to a valid address`);
  }
  return value;
}

function optionalAddress(name) {
  const value = process.env[name];
  if (!value) return undefined;
  if (!ethers.isAddress(value)) {
    throw new Error(`${name} must be set to a valid address`);
  }
  return value;
}

function optionalUint(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function poolWeights() {
  const raw = process.env.POOL_WEIGHTS;
  if (!raw) return DEFAULT_POOL_WEIGHTS;

  const weights = raw.split(",").map((item) => Number(item.trim()));
  if (weights.length !== 11 || weights.some((item) => !Number.isInteger(item) || item < 0)) {
    throw new Error("POOL_WEIGHTS must contain exactly 11 non-negative integers");
  }

  const sum = weights.reduce((total, item) => total + item, 0);
  if (sum !== 10000) {
    throw new Error(`POOL_WEIGHTS must sum to 10000, got ${sum}`);
  }

  return weights;
}

async function maybeDeployMockTokens(deployer) {
  // DEPLOY_MOCK_TOKENS=true always deploys fresh mocks (ignores existing env addresses).
  // This ensures BSC testnet deployments get their own contracts, not Sepolia addresses.
  const forceMocks = process.env.DEPLOY_MOCK_TOKENS === "true";
  const hasBothAddresses = process.env.USDT_ADDRESS && process.env.ORBD_TOKEN_ADDRESS;

  if (!forceMocks && hasBothAddresses) {
    return {
      usdtAddress: process.env.USDT_ADDRESS,
      orbdAddress: process.env.ORBD_TOKEN_ADDRESS,
      orbdIsMock: false,
    };
  }

  console.log("\nDeploying mock tokens for testnet use...");

  // Always deploy a fresh MockUSDT when DEPLOY_MOCK_TOKENS=true
  const MockUSDT = await ethers.getContractFactory("MockUSDT");
  const usdt = await MockUSDT.deploy();
  await usdt.waitForDeployment();
  const usdtAddress = await usdt.getAddress();

  const mintTo = process.env.TEST_USDT_MINT_TO || deployer.address;
  const mintAmount = process.env.TEST_USDT_MINT_AMOUNT || "100000";
  await (await usdt.mint(mintTo, ethers.parseUnits(mintAmount, USDT_DECIMALS))).wait();
  console.log("MockUSDT (18 dec):", usdtAddress);
  console.log(`Minted ${mintAmount} test USDT (18-dec) to:`, mintTo);

  // Always deploy a fresh MockORBDToken when DEPLOY_MOCK_TOKENS=true
  const MockORBDToken = await ethers.getContractFactory("MockORBDToken");
  const orbd = await MockORBDToken.deploy();
  await orbd.waitForDeployment();
  const orbdAddress = await orbd.getAddress();
  console.log("MockORBDToken:", orbdAddress);

  return { usdtAddress, orbdAddress, orbdIsMock: true };
}

async function grantMinterIfSupported(orbdAddress, weeklyPoolAddress, orbdIsMock) {
  if (orbdIsMock) {
    console.log("MockORBDToken has public minting; MINTER_ROLE grant skipped.");
    return;
  }

  const orbd = await ethers.getContractAt("ORBDToken", orbdAddress);
  try {
    const minterRole = await orbd.MINTER_ROLE();
    await (await orbd.grantRole(minterRole, weeklyPoolAddress)).wait();
    console.log("MINTER_ROLE granted to ARVOWeeklyPool:", weeklyPoolAddress);
  } catch (error) {
    console.log("MINTER_ROLE was not granted automatically.");
    console.log("Reason:", error.shortMessage || error.message);
    console.log("Grant it manually before weekly ORBD distribution.");
  }
}

async function configurePancakeOracleIfSet(weeklyPool) {
  const pairAddress = optionalAddress("ORBD_USDT_PAIR_ADDRESS");
  if (!pairAddress) {
    console.log("Pancake ORBD/USDT oracle not configured (ORBD_USDT_PAIR_ADDRESS not set).");
    return;
  }

  const minInterval = optionalUint("ORACLE_MIN_TWAP_INTERVAL", DEFAULT_ORACLE_MIN_TWAP_INTERVAL);
  const maxAge = optionalUint("ORACLE_MAX_AGE", DEFAULT_ORACLE_MAX_AGE);
  const maxRateChangeBps = optionalUint("ORACLE_MAX_RATE_CHANGE_BPS", DEFAULT_ORACLE_MAX_RATE_CHANGE_BPS);

  await (await weeklyPool.configurePancakeOracle(
    pairAddress,
    minInterval,
    maxAge,
    maxRateChangeBps
  )).wait();

  console.log("Pancake ORBD/USDT oracle configured:");
  console.log("ORBD_USDT_PAIR_ADDRESS=", pairAddress);
  console.log("ORACLE_MIN_TWAP_INTERVAL=", minInterval);
  console.log("ORACLE_MAX_AGE=", maxAge);
  console.log("ORACLE_MAX_RATE_CHANGE_BPS=", maxRateChangeBps);
}

async function grantOptionalOperationalRoles(weeklyPool) {
  const rateUpdater = optionalAddress("RATE_UPDATER_ADDRESS");
  if (rateUpdater) {
    const role = await weeklyPool.RATE_UPDATER_ROLE();
    await (await weeklyPool.grantRole(role, rateUpdater)).wait();
    console.log("RATE_UPDATER_ROLE granted to:", rateUpdater);
  }

  const distributor = optionalAddress("DISTRIBUTOR_ADDRESS");
  if (distributor) {
    const role = await weeklyPool.DISTRIBUTOR_ROLE();
    await (await weeklyPool.grantRole(role, distributor)).wait();
    console.log("DISTRIBUTOR_ROLE granted to:", distributor);
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const genesis = requiredAddress("GENESIS_ADDRESS");
  const skipAdmin1 = requiredAddress("SKIP_ADMIN_1");
  const skipAdmin2 = requiredAddress("SKIP_ADMIN_2");

  if (skipAdmin1.toLowerCase() === skipAdmin2.toLowerCase()) {
    throw new Error("SKIP_ADMIN_1 and SKIP_ADMIN_2 must be different addresses");
  }

  console.log(`Deploying ARVO contracts on ${network.name}`);
  console.log("Deployer:", deployer.address);

  const { usdtAddress, orbdAddress, orbdIsMock } = await maybeDeployMockTokens(deployer);
  const weights = poolWeights();

  console.log("\nDeploying ARVOWeeklyPool...");
  const ARVOWeeklyPool = await ethers.getContractFactory("ARVOWeeklyPool");
  const weeklyPool = await upgrades.deployProxy(
    ARVOWeeklyPool,
    [usdtAddress, orbdAddress, weights],
    { kind: "uups" }
  );
  await weeklyPool.waitForDeployment();
  const weeklyPoolAddress = await weeklyPool.getAddress();
  console.log("ARVOWeeklyPool:", weeklyPoolAddress);

  await grantMinterIfSupported(orbdAddress, weeklyPoolAddress, orbdIsMock);
  await configurePancakeOracleIfSet(weeklyPool);
  await grantOptionalOperationalRoles(weeklyPool);

  console.log("\nDeploying ARVOMatrix...");
  const ARVOMatrix = await ethers.getContractFactory("ARVOMatrix");
  const matrix = await upgrades.deployProxy(
    ARVOMatrix,
    [usdtAddress, weeklyPoolAddress, genesis, skipAdmin1, skipAdmin2],
    { kind: "uups" }
  );
  await matrix.waitForDeployment();
  const matrixAddress = await matrix.getAddress();
  console.log("ARVOMatrix:", matrixAddress);

  const matrixRole = await weeklyPool.MATRIX_ROLE();
  await (await weeklyPool.grantRole(matrixRole, matrixAddress)).wait();
  console.log("MATRIX_ROLE granted to ARVOMatrix.");

  console.log("\nAdd/update these values in .env:");
  console.log(`USDT_ADDRESS=${usdtAddress}`);
  console.log(`ORBD_TOKEN_ADDRESS=${orbdAddress}`);
  console.log(`ARVO_WEEKLY_POOL_ADDRESS=${weeklyPoolAddress}`);
  console.log(`ARVO_MATRIX_ADDRESS=${matrixAddress}`);
  console.log(`POOL_WEIGHTS=${weights.join(",")}`);
  if (process.env.ORBD_USDT_PAIR_ADDRESS) {
    console.log(`ORBD_USDT_PAIR_ADDRESS=${process.env.ORBD_USDT_PAIR_ADDRESS}`);
    console.log(`ORACLE_MIN_TWAP_INTERVAL=${optionalUint("ORACLE_MIN_TWAP_INTERVAL", DEFAULT_ORACLE_MIN_TWAP_INTERVAL)}`);
    console.log(`ORACLE_MAX_AGE=${optionalUint("ORACLE_MAX_AGE", DEFAULT_ORACLE_MAX_AGE)}`);
    console.log(`ORACLE_MAX_RATE_CHANGE_BPS=${optionalUint("ORACLE_MAX_RATE_CHANGE_BPS", DEFAULT_ORACLE_MAX_RATE_CHANGE_BPS)}`);
  }
  if (process.env.RATE_UPDATER_ADDRESS) console.log(`RATE_UPDATER_ADDRESS=${process.env.RATE_UPDATER_ADDRESS}`);
  if (process.env.DISTRIBUTOR_ADDRESS) console.log(`DISTRIBUTOR_ADDRESS=${process.env.DISTRIBUTOR_ADDRESS}`);
  console.log(`VERIFY_ORBD_MOCK=${orbdIsMock ? "true" : "false"}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

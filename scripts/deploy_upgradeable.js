/**
 * Deploy ARVO upgradeable UUPS contracts.
 *
 * Deploy core only with existing token addresses:
 *   npx hardhat run scripts/deploy_upgradeable.js --network sepolia
 *
 * Deploy MockUSDT + ORBDToken proxy + core:
 *   DEPLOY_TOKENS=true npx hardhat run scripts/deploy_upgradeable.js --network sepolia
 *
 * Required for core:
 *   GENESIS_ADDRESS, SKIP_ADMIN_1, SKIP_ADMIN_2
 *
 * Required unless DEPLOY_TOKENS=true:
 *   USDT_ADDRESS, ORBD_TOKEN_ADDRESS
 *
 * Optional production oracle:
 *   ORBD_USDT_PAIR_ADDRESS=<PancakeSwap V2 ORBD/USDT pair>
 *   ORACLE_MIN_TWAP_INTERVAL=86400
 *   ORACLE_MAX_AGE=777600
 *   ORACLE_MAX_RATE_CHANGE_BPS=2000
 *   RATE_UPDATER_ADDRESS=<keeper wallet>
 *   DISTRIBUTOR_ADDRESS=<weekly distribution wallet>
 */
const { ethers, network, upgrades } = require("hardhat");

const DEFAULT_POOL_WEIGHTS = [910, 909, 909, 909, 909, 909, 909, 909, 909, 909, 909];
const DEFAULT_ORBD_MAX_SUPPLY = ethers.parseUnits("1000000000", 18);
const DEFAULT_ORACLE_MIN_TWAP_INTERVAL = 24 * 60 * 60;
const DEFAULT_ORACLE_MAX_AGE = 9 * 24 * 60 * 60;
const DEFAULT_ORACLE_MAX_RATE_CHANGE_BPS = 2000;

function requireAddress(name) {
  const value = process.env[name];
  if (!ethers.isAddress(value || "")) {
    throw new Error(`${name} must be set to a valid address`);
  }
  return value;
}

function optionalAddress(name) {
  const value = process.env[name];
  if (!value) return undefined;
  if (!ethers.isAddress(value)) throw new Error(`${name} must be a valid address`);
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

function parsePoolWeights() {
  const raw = process.env.POOL_WEIGHTS;
  if (!raw) return DEFAULT_POOL_WEIGHTS;

  const weights = raw.split(",").map((item) => Number(item.trim()));
  const sum = weights.reduce((total, item) => total + item, 0);

  if (weights.length !== 11 || weights.some((item) => !Number.isInteger(item) || item < 0)) {
    throw new Error("POOL_WEIGHTS must contain exactly 11 non-negative integers");
  }

  if (sum !== 10000) {
    throw new Error(`POOL_WEIGHTS must sum to 10000, got ${sum}`);
  }

  return weights;
}

function parseOrbdMaxSupply() {
  return process.env.ORBD_MAX_SUPPLY ? BigInt(process.env.ORBD_MAX_SUPPLY) : DEFAULT_ORBD_MAX_SUPPLY;
}

async function deployTokens(deployer) {
  if (process.env.DEPLOY_TOKENS !== "true") {
    return {
      usdtAddress: requireAddress("USDT_ADDRESS"),
      orbdAddress: requireAddress("ORBD_TOKEN_ADDRESS"),
      orbdIsProxy: true,
    };
  }

  console.log("\nDeploying MockUSDT...");
  const MockUSDT = await ethers.getContractFactory("MockUSDT");
  const usdt = await MockUSDT.deploy();
  await usdt.waitForDeployment();
  const usdtAddress = await usdt.getAddress();
  console.log("USDT_ADDRESS=", usdtAddress);

  const mintTo = optionalAddress("TEST_USDT_MINT_TO") || deployer.address;
  const mintAmount = process.env.TEST_USDT_MINT_AMOUNT || "100000";
  await (await usdt.mint(mintTo, ethers.parseUnits(mintAmount, 18))).wait(); // 18 dec — matches BSC USDT
  console.log(`Minted ${mintAmount} test USDT to ${mintTo}`);

  console.log("\nDeploying ORBDToken proxy...");
  const ORBDToken = await ethers.getContractFactory("ORBDToken");
  const orbd = await upgrades.deployProxy(ORBDToken, [parseOrbdMaxSupply()], {
    kind: "uups",
  });
  await orbd.waitForDeployment();
  const orbdAddress = await orbd.getAddress();
  const orbdImplementation = await upgrades.erc1967.getImplementationAddress(orbdAddress);
  console.log("ORBD_TOKEN_ADDRESS=", orbdAddress);
  console.log("ORBD_TOKEN_IMPLEMENTATION=", orbdImplementation);

  const newAdmin = optionalAddress("ORBD_ADMIN_ADDRESS");
  if (newAdmin) {
    const role = await orbd.DEFAULT_ADMIN_ROLE();
    await (await orbd.grantRole(role, newAdmin)).wait();
    await (await orbd.renounceRole(role, deployer.address)).wait();
    console.log("ORBD DEFAULT_ADMIN_ROLE transferred to", newAdmin);
  }

  return { usdtAddress, orbdAddress, orbdIsProxy: true };
}

async function grantOrbdMinter(orbdAddress, poolAddress) {
  try {
    const orbd = await ethers.getContractAt("ORBDToken", orbdAddress);
    const minterRole = await orbd.MINTER_ROLE();
    await (await orbd.grantRole(minterRole, poolAddress)).wait();
    console.log("ORBD MINTER_ROLE granted to ARVOWeeklyPool");
  } catch (error) {
    console.log("ORBD MINTER_ROLE was not granted automatically.");
    console.log("Reason:", error.shortMessage || error.message);
  }
}

async function configurePancakeOracleIfSet(pool) {
  const pairAddress = optionalAddress("ORBD_USDT_PAIR_ADDRESS");
  if (!pairAddress) {
    console.log("Pancake ORBD/USDT oracle not configured (ORBD_USDT_PAIR_ADDRESS not set).");
    return;
  }

  const minInterval = optionalUint("ORACLE_MIN_TWAP_INTERVAL", DEFAULT_ORACLE_MIN_TWAP_INTERVAL);
  const maxAge = optionalUint("ORACLE_MAX_AGE", DEFAULT_ORACLE_MAX_AGE);
  const maxRateChangeBps = optionalUint("ORACLE_MAX_RATE_CHANGE_BPS", DEFAULT_ORACLE_MAX_RATE_CHANGE_BPS);

  await (await pool.configurePancakeOracle(
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

async function grantOptionalOperationalRoles(pool) {
  const rateUpdater = optionalAddress("RATE_UPDATER_ADDRESS");
  if (rateUpdater) {
    const role = await pool.RATE_UPDATER_ROLE();
    await (await pool.grantRole(role, rateUpdater)).wait();
    console.log("RATE_UPDATER_ROLE granted to:", rateUpdater);
  }

  const distributor = optionalAddress("DISTRIBUTOR_ADDRESS");
  if (distributor) {
    const role = await pool.DISTRIBUTOR_ROLE();
    await (await pool.grantRole(role, distributor)).wait();
    console.log("DISTRIBUTOR_ROLE granted to:", distributor);
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const genesis = requireAddress("GENESIS_ADDRESS");
  const skipAdmin1 = requireAddress("SKIP_ADMIN_1");
  const skipAdmin2 = requireAddress("SKIP_ADMIN_2");

  if (skipAdmin1.toLowerCase() === skipAdmin2.toLowerCase()) {
    throw new Error("SKIP_ADMIN_1 and SKIP_ADMIN_2 must be different");
  }

  console.log("Network:", network.name);
  console.log("Deployer:", deployer.address);

  const { usdtAddress, orbdAddress } = await deployTokens(deployer);
  const weights = parsePoolWeights();

  console.log("\nDeploying ARVOWeeklyPool proxy...");
  const ARVOWeeklyPool = await ethers.getContractFactory("ARVOWeeklyPool");
  const pool = await upgrades.deployProxy(ARVOWeeklyPool, [usdtAddress, orbdAddress, weights], {
    kind: "uups",
  });
  await pool.waitForDeployment();
  const poolAddress = await pool.getAddress();
  const poolImplementation = await upgrades.erc1967.getImplementationAddress(poolAddress);
  console.log("ARVO_WEEKLY_POOL_ADDRESS=", poolAddress);
  console.log("ARVO_WEEKLY_POOL_IMPLEMENTATION=", poolImplementation);

  await grantOrbdMinter(orbdAddress, poolAddress);
  await configurePancakeOracleIfSet(pool);
  await grantOptionalOperationalRoles(pool);

  console.log("\nDeploying ARVOMatrix proxy...");
  const ARVOMatrix = await ethers.getContractFactory("ARVOMatrix");
  const matrix = await upgrades.deployProxy(
    ARVOMatrix,
    [usdtAddress, poolAddress, genesis, skipAdmin1, skipAdmin2],
    { kind: "uups" }
  );
  await matrix.waitForDeployment();
  const matrixAddress = await matrix.getAddress();
  const matrixImplementation = await upgrades.erc1967.getImplementationAddress(matrixAddress);
  console.log("ARVO_MATRIX_ADDRESS=", matrixAddress);
  console.log("ARVO_MATRIX_IMPLEMENTATION=", matrixImplementation);

  const matrixRole = await pool.MATRIX_ROLE();
  await (await pool.grantRole(matrixRole, matrixAddress)).wait();
  console.log("MATRIX_ROLE granted to ARVOMatrix");

  console.log("\n.env values:");
  console.log(`USDT_ADDRESS=${usdtAddress}`);
  console.log(`ORBD_TOKEN_ADDRESS=${orbdAddress}`);
  console.log(`ARVO_WEEKLY_POOL_ADDRESS=${poolAddress}`);
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
  console.log("VERIFY_ORBD_MOCK=false");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

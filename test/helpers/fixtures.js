const { ethers, upgrades } = require("hardhat");

const POOL_COUNT   = 11;
const USDT_DECIMALS = 18;
const JOIN_FEE     = ethers.parseUnits("10",  USDT_DECIMALS);
const DIRECT_FEE   = ethers.parseUnits("5",   USDT_DECIMALS);
const AUTO_UPGRADE_FUND = ethers.parseUnits("2.5", USDT_DECIMALS);
const POOL_SHARE   = ethers.parseUnits("2",   USDT_DECIMALS);
const ADMIN_SHARE  = ethers.parseUnits("0.5", USDT_DECIMALS);
const LEVEL_SHARE  = AUTO_UPGRADE_FUND;
const ORBD_CAP     = ethers.parseUnits("1000000000", 18); // 1 billion ORBD

// Equal weights across 11 pools: each gets ~909 bps ≈ 909*11=9999; add 1 to pool 0
const DEFAULT_WEIGHTS = [910, 909, 909, 909, 909, 909, 909, 909, 909, 909, 909];

/**
 * Deploy all three contracts plus MockUSDT.
 * Returns { usdt, orbd, weeklyPool, matrix, deployer, genesis, skipAdmin1, skipAdmin2, users }
 */
async function deployAll() {
  const [deployer, genesis, skipAdmin1, skipAdmin2, ...users] = await ethers.getSigners();

  // 1. MockUSDT
  const MockUSDT = await ethers.getContractFactory("MockUSDT");
  const usdt = await MockUSDT.deploy();

  // 2. ORBDToken
  const ORBDToken = await ethers.getContractFactory("ORBDToken");
  const orbd = await upgrades.deployProxy(ORBDToken, [ORBD_CAP], { kind: "uups" });
  await orbd.waitForDeployment();

  // 3. ARVOWeeklyPool
  const ARVOWeeklyPool = await ethers.getContractFactory("ARVOWeeklyPool");
  const weeklyPool = await upgrades.deployProxy(
    ARVOWeeklyPool,
    [await usdt.getAddress(), await orbd.getAddress(), DEFAULT_WEIGHTS],
    { kind: "uups" }
  );
  await weeklyPool.waitForDeployment();

  // 4. ARVOMatrix
  const ARVOMatrix = await ethers.getContractFactory("ARVOMatrix");
  const matrix = await upgrades.deployProxy(
    ARVOMatrix,
    [
      await usdt.getAddress(),
      await weeklyPool.getAddress(),
      genesis.address,
      skipAdmin1.address,
      skipAdmin2.address,
    ],
    { kind: "uups" }
  );
  await matrix.waitForDeployment();

  // 5. Role grants
  const MINTER_ROLE      = await orbd.MINTER_ROLE();
  const MATRIX_ROLE      = await weeklyPool.MATRIX_ROLE();
  const DISTRIBUTOR_ROLE = await weeklyPool.DISTRIBUTOR_ROLE();

  await orbd.connect(deployer).grantRole(MINTER_ROLE, await weeklyPool.getAddress());
  await weeklyPool.connect(deployer).grantRole(MATRIX_ROLE, await matrix.getAddress());
  await weeklyPool.connect(deployer).grantRole(DISTRIBUTOR_ROLE, deployer.address);

  // 6. Fund test users with USDT
  for (const user of users) {
    await usdt.mint(user.address, ethers.parseUnits("10000", USDT_DECIMALS));
    await usdt.connect(user).approve(await matrix.getAddress(), ethers.MaxUint256);
  }

  return { usdt, orbd, weeklyPool, matrix, deployer, genesis, skipAdmin1, skipAdmin2, users };
}

module.exports = {
  deployAll,
  JOIN_FEE,
  DIRECT_FEE,
  AUTO_UPGRADE_FUND,
  POOL_SHARE,
  ADMIN_SHARE,
  LEVEL_SHARE,
  ORBD_CAP,
  DEFAULT_WEIGHTS,
  POOL_COUNT,
  USDT_DECIMALS,
};

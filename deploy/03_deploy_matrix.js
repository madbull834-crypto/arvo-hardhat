const { ethers } = require("hardhat");

module.exports = async ({ deployments, getNamedAccounts, network }) => {
  const { deploy, get } = deployments;
  const { deployer } = await getNamedAccounts();

  const usdtAddress    = process.env.USDT_ADDRESS;
  const genesisAddress = process.env.GENESIS_ADDRESS || deployer;
  const skipAdmin1     = process.env.SKIP_ADMIN_1;
  const skipAdmin2     = process.env.SKIP_ADMIN_2;

  if (!usdtAddress)    throw new Error("USDT_ADDRESS not set in .env");
  if (!genesisAddress) throw new Error("GENESIS_ADDRESS not set in .env");
  if (!skipAdmin1)     throw new Error("SKIP_ADMIN_1 not set in .env");
  if (!skipAdmin2)     throw new Error("SKIP_ADMIN_2 not set in .env");

  const weeklyPoolDeployment = await get("ARVOWeeklyPool");

  console.log("Deploying ARVOMatrix...");
  console.log("  USDT:    ", usdtAddress);
  console.log("  Pool:    ", weeklyPoolDeployment.address);
  console.log("  Genesis: ", genesisAddress);
  console.log("  Skip A1: ", skipAdmin1);
  console.log("  Skip A2: ", skipAdmin2);

  const result = await deploy("ARVOMatrix", {
    from:    deployer,
    args:    [usdtAddress, weeklyPoolDeployment.address, genesisAddress, skipAdmin1, skipAdmin2],
    log:     true,
    waitConfirmations: network.name === "hardhat" ? 1 : 5,
  });

  // Grant MATRIX_ROLE to ARVOMatrix on WeeklyPool
  const ARVOWeeklyPool = await ethers.getContractAt("ARVOWeeklyPool", weeklyPoolDeployment.address);
  const MATRIX_ROLE = await ARVOWeeklyPool.MATRIX_ROLE();
  const tx = await ARVOWeeklyPool.grantRole(MATRIX_ROLE, result.address);
  await tx.wait();
  console.log("MATRIX_ROLE granted to ARVOMatrix:", result.address);
};

module.exports.tags      = ["ARVOMatrix", "all"];
module.exports.dependencies = ["ARVOWeeklyPool"];

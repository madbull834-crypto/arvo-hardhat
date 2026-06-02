/**
 * Hardhat custom tasks for ARVO development
 * Usage: npx hardhat <task-name> --network <network>
 */
const { task } = require("hardhat/config");

// ── Get member info ──────────────────────────────────────────────
task("member-info", "Print all info for a registered member")
  .addParam("address", "Member wallet address")
  .addParam("matrix",  "ARVOMatrix contract address")
  .setAction(async ({ address, matrix }, hre) => {
    const contract = await hre.ethers.getContractAt("ARVOMatrix", matrix);
    const info = await contract.getUserInfo(address);
    const tree = await contract.getTreeInfo(address);
    console.log("=== Member Info ===");
    console.log("Registered:  ", info.isRegistered);
    console.log("Referrer:    ", info.referrer);
    console.log("Level:       ", info.currentLevel.toString());
    console.log("Directs:     ", info.directCount.toString());
    console.log("Claimable:   ", hre.ethers.formatUnits(info.claimableUsdt, 6), "USDT");
    console.log("Parent:      ", tree.parent);
    console.log("Left child:  ", tree.leftChild);
    console.log("Right child: ", tree.rightChild);
  });

// ── Pool stats ──────────────────────────────────────────────────
task("pool-stats", "Print weekly pool stats")
  .addParam("pool",   "ARVOWeeklyPool contract address")
  .addParam("poolid", "Pool ID (0-10)")
  .setAction(async ({ pool, poolid }, hre) => {
    const contract = await hre.ethers.getContractAt("ARVOWeeklyPool", pool);
    const stats = await contract.getPoolStats(parseInt(poolid));
    console.log(`=== Pool ${poolid} Stats ===`);
    console.log("Accumulated: ", hre.ethers.formatUnits(stats.accumulated, 6), "USDT");
    console.log("Weight:      ", stats.weight.toString(), "bps");
    console.log("Target:      ", hre.ethers.formatUnits(stats.target, 6), "USDT");
    console.log("Members:     ", stats.memberCount.toString());
  });

// ── Total members ───────────────────────────────────────────────
task("total-members", "Print total registered members")
  .addParam("matrix", "ARVOMatrix contract address")
  .setAction(async ({ matrix }, hre) => {
    const contract = await hre.ethers.getContractAt("ARVOMatrix", matrix);
    console.log("Total members:", (await contract.totalMembers()).toString());
  });

/**
 * check_balances.js — Inspect contract and wallet balances
 * Usage: npx hardhat run scripts/check_balances.js --network bscTestnet
 */
const { ethers } = require("hardhat");

async function main() {
  const {
    USDT_ADDRESS,
    ARVO_MATRIX_ADDRESS,
    ARVO_WEEKLY_POOL_ADDRESS,
    ORBD_TOKEN_ADDRESS,
  } = process.env;

  const usdt   = await ethers.getContractAt("MockUSDT",       USDT_ADDRESS);
  const matrix = await ethers.getContractAt("ARVOMatrix",     ARVO_MATRIX_ADDRESS);
  const pool   = await ethers.getContractAt("ARVOWeeklyPool", ARVO_WEEKLY_POOL_ADDRESS);
  const orbd   = await ethers.getContractAt("ORBDToken",      ORBD_TOKEN_ADDRESS);

  const [signer] = await ethers.getSigners();

  console.log("=== ARVO Contract Balances ===");
  console.log("ARVOMatrix USDT balance:    ", ethers.formatUnits(await usdt.balanceOf(ARVO_MATRIX_ADDRESS), 18));
  console.log("ARVOWeeklyPool USDT balance:", ethers.formatUnits(await usdt.balanceOf(ARVO_WEEKLY_POOL_ADDRESS), 18));
  console.log("ORBD total supply:          ", ethers.formatUnits(await orbd.totalSupply(), 18));
  console.log("Total members:              ", (await matrix.totalMembers()).toString());

  console.log("\n=== Signer Wallet ===");
  console.log("Address:", signer.address);
  console.log("USDT:   ", ethers.formatUnits(await usdt.balanceOf(signer.address), 18));
  console.log("ORBD:   ", ethers.formatUnits(await orbd.balanceOf(signer.address), 18));
}

main().catch((err) => { console.error(err); process.exit(1); });

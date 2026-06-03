/**
 * Mint MockUSDT for testnet registration testing.
 *
 * Usage:
 *   MINT_TO=0x... MINT_AMOUNT=100 npx hardhat run scripts/mint_test_usdt.js --network sepolia
 */
const { ethers } = require("hardhat");

async function main() {
  const usdtAddress = process.env.USDT_ADDRESS;
  const to = process.env.MINT_TO || process.env.TEST_USDT_MINT_TO;
  const amount = process.env.MINT_AMOUNT || process.env.TEST_USDT_MINT_AMOUNT || "100";

  if (!ethers.isAddress(usdtAddress || "")) {
    throw new Error("USDT_ADDRESS must be set to the deployed MockUSDT address");
  }

  if (!ethers.isAddress(to || "")) {
    throw new Error("Set MINT_TO=0x... to the wallet you want to fund");
  }

  const usdt = await ethers.getContractAt("MockUSDT", usdtAddress);
  const parsed = ethers.parseUnits(amount, 18);

  console.log(`Minting ${amount} USDT to ${to} from MockUSDT ${usdtAddress}`);
  const tx = await usdt.mint(to, parsed);
  console.log("Transaction:", tx.hash);
  await tx.wait();

  const balance = await usdt.balanceOf(to);
  console.log("New balance:", ethers.formatUnits(balance, 18), "USDT");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

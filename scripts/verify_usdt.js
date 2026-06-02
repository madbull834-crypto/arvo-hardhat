/**
 * Verify MockUSDT from USDT_ADDRESS.
 *
 * Usage:
 *   npx hardhat run scripts/verify_usdt.js --network sepolia
 */
const { ethers, network, run } = require("hardhat");

async function main() {
  const address = process.env.USDT_ADDRESS;
  if (!address || !ethers.isAddress(address)) {
    throw new Error("USDT_ADDRESS must be set to a valid address in .env");
  }

  const code = await ethers.provider.getCode(address);
  if (code === "0x") {
    throw new Error(
      `USDT_ADDRESS (${address}) has no bytecode on ${network.name}. ` +
      "Check that .env contains the MockUSDT address deployed on this network."
    );
  }

  console.log(`Verifying MockUSDT on ${network.name}: ${address}`);

  try {
    await run("verify:verify", {
      address,
      constructorArguments: [],
      contract: "contracts/mocks/MockUSDT.sol:MockUSDT",
    });
    console.log("MockUSDT verified");
  } catch (error) {
    const message = error.message || "";
    if (
      message.includes("Already Verified") ||
      message.includes("already verified") ||
      message.includes("Contract source code already verified")
    ) {
      console.log("MockUSDT is already verified");
      return;
    }

    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

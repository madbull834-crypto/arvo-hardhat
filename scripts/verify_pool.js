/**
 * Verify ARVOWeeklyPool from ARVO_WEEKLY_POOL_ADDRESS.
 *
 * Usage:
 *   npx hardhat run scripts/verify_pool.js --network bscTestnet
 */
const { ethers, network, run, upgrades } = require("hardhat");

function requiredAddress(name, value) {
  if (!value || !ethers.isAddress(value)) {
    throw new Error(`${name} must be set to a valid address`);
  }
}

async function requireDeployedCode(name, address) {
  requiredAddress(name, address);

  const code = await ethers.provider.getCode(address);
  if (code === "0x") {
    throw new Error(
      `${name} (${address}) has no bytecode on ${network.name}. ` +
      "Check that .env contains the address deployed on this network."
    );
  }
}

async function verify(label, args) {
  console.log(`Verifying ${label}: ${args.address}`);

  try {
    await run("verify:verify", args);
    console.log(`${label} verified`);
  } catch (error) {
    const message = error.message || "";
    if (
      message.includes("Already Verified") ||
      message.includes("already verified") ||
      message.includes("Contract source code already verified")
    ) {
      console.log(`${label} is already verified`);
      return;
    }

    throw error;
  }
}

async function isProxy(address) {
  try {
    await upgrades.erc1967.getImplementationAddress(address);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const {
    ARVO_WEEKLY_POOL_ADDRESS,
    USDT_ADDRESS,
    ORBD_TOKEN_ADDRESS,
  } = process.env;

  await requireDeployedCode("ARVO_WEEKLY_POOL_ADDRESS", ARVO_WEEKLY_POOL_ADDRESS);
  await requireDeployedCode("USDT_ADDRESS", USDT_ADDRESS);
  await requireDeployedCode("ORBD_TOKEN_ADDRESS", ORBD_TOKEN_ADDRESS);

  if (await isProxy(ARVO_WEEKLY_POOL_ADDRESS)) {
    await verify("ARVOWeeklyPool proxy", { address: ARVO_WEEKLY_POOL_ADDRESS });
    return;
  }

  const weights = (process.env.POOL_WEIGHTS || "910,909,909,909,909,909,909,909,909,909,909")
    .split(",")
    .map((item) => Number(item.trim()));

  await verify("ARVOWeeklyPool", {
    address: ARVO_WEEKLY_POOL_ADDRESS,
    constructorArguments: [USDT_ADDRESS, ORBD_TOKEN_ADDRESS, weights],
    contract: "contracts/core/ARVOWeeklyPool.sol:ARVOWeeklyPool",
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

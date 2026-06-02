/**
 * Verify ARVOMatrix from ARVO_MATRIX_ADDRESS.
 *
 * Usage:
 *   npx hardhat run scripts/verify_matrix.js --network bscTestnet
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
    ARVO_MATRIX_ADDRESS,
    USDT_ADDRESS,
    ARVO_WEEKLY_POOL_ADDRESS,
    GENESIS_ADDRESS,
    SKIP_ADMIN_1,
    SKIP_ADMIN_2,
  } = process.env;

  await requireDeployedCode("ARVO_MATRIX_ADDRESS", ARVO_MATRIX_ADDRESS);
  await requireDeployedCode("USDT_ADDRESS", USDT_ADDRESS);
  await requireDeployedCode("ARVO_WEEKLY_POOL_ADDRESS", ARVO_WEEKLY_POOL_ADDRESS);
  requiredAddress("GENESIS_ADDRESS", GENESIS_ADDRESS);
  requiredAddress("SKIP_ADMIN_1", SKIP_ADMIN_1);
  requiredAddress("SKIP_ADMIN_2", SKIP_ADMIN_2);

  if (await isProxy(ARVO_MATRIX_ADDRESS)) {
    await verify("ARVOMatrix proxy", { address: ARVO_MATRIX_ADDRESS });
    return;
  }

  await verify("ARVOMatrix", {
    address: ARVO_MATRIX_ADDRESS,
    constructorArguments: [
      USDT_ADDRESS,
      ARVO_WEEKLY_POOL_ADDRESS,
      GENESIS_ADDRESS,
      SKIP_ADMIN_1,
      SKIP_ADMIN_2,
    ],
    contract: "contracts/core/ARVOMatrix.sol:ARVOMatrix",
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

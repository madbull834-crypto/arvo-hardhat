/**
 * verify.js — BscScan verification for all ARVO contracts
 * Usage: npx hardhat run scripts/verify.js --network bscTestnet
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

async function verifyContract(label, args) {
  console.log(`─── Verifying ${label} ───`);

  try {
    await run("verify:verify", args);
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

async function verifyProxyOrContract(label, address, fallbackArgs) {
  if (await isProxy(address)) {
    await verifyContract(`${label} proxy`, { address });
    return;
  }

  await verifyContract(label, fallbackArgs);
}

async function main() {
  const {
    ORBD_TOKEN_ADDRESS,
    ARVO_WEEKLY_POOL_ADDRESS,
    ARVO_MATRIX_ADDRESS,
    USDT_ADDRESS,
    GENESIS_ADDRESS,
    SKIP_ADMIN_1,
    SKIP_ADMIN_2,
    ORBD_MAX_SUPPLY,
  } = process.env;

  const verifyOrbdAsMock = process.env.VERIFY_ORBD_MOCK === "true";

  await requireDeployedCode("USDT_ADDRESS", USDT_ADDRESS);
  await requireDeployedCode("ORBD_TOKEN_ADDRESS", ORBD_TOKEN_ADDRESS);
  await requireDeployedCode("ARVO_WEEKLY_POOL_ADDRESS", ARVO_WEEKLY_POOL_ADDRESS);
  await requireDeployedCode("ARVO_MATRIX_ADDRESS", ARVO_MATRIX_ADDRESS);

  await verifyProxyOrContract(
    verifyOrbdAsMock ? "MockORBDToken" : "ORBDToken",
    ORBD_TOKEN_ADDRESS,
    {
      address: ORBD_TOKEN_ADDRESS,
      constructorArguments: verifyOrbdAsMock ? [] : [ORBD_MAX_SUPPLY],
      contract: verifyOrbdAsMock
        ? "contracts/mocks/MockORBDToken.sol:MockORBDToken"
        : "contracts/tokens/ORBDToken.sol:ORBDToken",
    }
  );

  const weights = (process.env.POOL_WEIGHTS || "910,909,909,909,909,909,909,909,909,909,909")
    .split(",")
    .map((item) => Number(item.trim()));
  await verifyProxyOrContract(
    "ARVOWeeklyPool",
    ARVO_WEEKLY_POOL_ADDRESS,
    {
      address: ARVO_WEEKLY_POOL_ADDRESS,
      constructorArguments: [USDT_ADDRESS, ORBD_TOKEN_ADDRESS, weights],
    }
  );

  await verifyProxyOrContract(
    "ARVOMatrix",
    ARVO_MATRIX_ADDRESS,
    {
      address: ARVO_MATRIX_ADDRESS,
      constructorArguments: [
        USDT_ADDRESS,
        ARVO_WEEKLY_POOL_ADDRESS,
        GENESIS_ADDRESS,
        SKIP_ADMIN_1,
        SKIP_ADMIN_2,
      ],
    }
  );

  console.log("✅ All contracts verified");
}

main().catch((err) => { console.error(err); process.exit(1); });

/**
 * Upgrade deployed ARVO UUPS proxies to the latest local implementations.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade_core.js --network sepolia
 */
const { ethers, upgrades } = require("hardhat");

async function optionalAddress(name) {
  const value = process.env[name];
  if (!value) return undefined;
  if (!ethers.isAddress(value)) throw new Error(`${name} must be a valid address`);
  return value;
}

async function upgradeIfSet(label, envName, contractName) {
  const proxyAddress = await optionalAddress(envName);
  if (!proxyAddress) {
    console.log(`${label}: skipped (${envName} not set)`);
    return;
  }

  const Factory = await ethers.getContractFactory(contractName);
  console.log(`${label}: upgrading proxy ${proxyAddress}...`);
  const upgraded = await upgrades.upgradeProxy(proxyAddress, Factory, { kind: "uups" });
  await upgraded.waitForDeployment();
  console.log(`${label}: upgraded`);
  console.log(`${label}_PROXY=${await upgraded.getAddress()}`);
  console.log(`${label}_IMPLEMENTATION=${await upgrades.erc1967.getImplementationAddress(proxyAddress)}`);
}

async function main() {
  if (process.env.VERIFY_ORBD_MOCK !== "true") {
    await upgradeIfSet("ORBD_TOKEN", "ORBD_TOKEN_ADDRESS", "ORBDToken");
  } else {
    console.log("ORBD_TOKEN: skipped (VERIFY_ORBD_MOCK=true)");
  }

  await upgradeIfSet("ARVO_WEEKLY_POOL", "ARVO_WEEKLY_POOL_ADDRESS", "ARVOWeeklyPool");
  await upgradeIfSet("ARVO_MATRIX", "ARVO_MATRIX_ADDRESS", "ARVOMatrix");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

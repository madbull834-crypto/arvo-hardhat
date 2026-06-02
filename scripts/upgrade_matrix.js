/**
 * Upgrade only the ARVOMatrix UUPS proxy.
 *
 * Validate without sending a transaction:
 *   VALIDATE_ONLY=true npx hardhat run scripts/upgrade_matrix.js --network sepolia
 *
 * Submit upgrade transaction:
 *   npx hardhat run scripts/upgrade_matrix.js --network sepolia
 */
const { ethers, upgrades } = require("hardhat");

async function main() {
  const proxyAddress = process.env.ARVO_MATRIX_ADDRESS;
  if (!ethers.isAddress(proxyAddress || "")) {
    throw new Error("ARVO_MATRIX_ADDRESS must be set to a valid proxy address");
  }

  const ARVOMatrix = await ethers.getContractFactory("ARVOMatrix");

  if (process.env.VALIDATE_ONLY === "true") {
    await upgrades.validateUpgrade(proxyAddress, ARVOMatrix, { kind: "uups" });
    console.log("ARVOMatrix upgrade is storage-compatible");
    console.log("ARVO_MATRIX_PROXY=", proxyAddress);
    return;
  }

  const [signer] = await ethers.getSigners();
  const current = await ethers.getContractAt("ARVOMatrix", proxyAddress);
  const owner = await current.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`Upgrade signer ${signer.address} is not matrix owner ${owner}`);
  }

  console.log("Upgrading ARVOMatrix proxy:", proxyAddress);
  const upgraded = await upgrades.upgradeProxy(proxyAddress, ARVOMatrix, { kind: "uups" });
  await upgraded.waitForDeployment();

  console.log("ARVOMatrix upgraded");
  console.log("ARVO_MATRIX_PROXY=", await upgraded.getAddress());
  console.log("ARVO_MATRIX_IMPLEMENTATION=", await upgrades.erc1967.getImplementationAddress(proxyAddress));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

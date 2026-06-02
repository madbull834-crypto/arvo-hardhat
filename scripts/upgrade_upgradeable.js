/**
 * Upgrade ARVO UUPS proxies.
 *
 * Validate only:
 *   VALIDATE_ONLY=true UPGRADE_MATRIX=true npx hardhat run scripts/upgrade_upgradeable.js --network sepolia
 *
 * Upgrade selected proxies:
 *   UPGRADE_MATRIX=true npx hardhat run scripts/upgrade_upgradeable.js --network sepolia
 *   UPGRADE_POOL=true UPGRADE_MATRIX=true npx hardhat run scripts/upgrade_upgradeable.js --network sepolia
 *   UPGRADE_ORBD=true npx hardhat run scripts/upgrade_upgradeable.js --network sepolia
 *
 * Address env vars:
 *   ORBD_TOKEN_ADDRESS, ARVO_WEEKLY_POOL_ADDRESS, ARVO_MATRIX_ADDRESS
 */
const { ethers, network, upgrades } = require("hardhat");

const TARGETS = [
  {
    flag: "UPGRADE_ORBD",
    label: "ORBDToken",
    envName: "ORBD_TOKEN_ADDRESS",
    contractName: "ORBDToken",
    ownership: "role",
  },
  {
    flag: "UPGRADE_POOL",
    label: "ARVOWeeklyPool",
    envName: "ARVO_WEEKLY_POOL_ADDRESS",
    contractName: "ARVOWeeklyPool",
    ownership: "role",
  },
  {
    flag: "UPGRADE_MATRIX",
    label: "ARVOMatrix",
    envName: "ARVO_MATRIX_ADDRESS",
    contractName: "ARVOMatrix",
    ownership: "owner",
  },
];

function selected(target) {
  return process.env[target.flag] === "true";
}

function requireAddress(name) {
  const value = process.env[name];
  if (!ethers.isAddress(value || "")) {
    throw new Error(`${name} must be set to a valid proxy address`);
  }
  return value;
}

async function assertCanUpgrade(target, proxyAddress, signer) {
  const contract = await ethers.getContractAt(target.contractName, proxyAddress);

  if (target.ownership === "owner") {
    const owner = await contract.owner();
    if (owner.toLowerCase() !== signer.address.toLowerCase()) {
      throw new Error(`${target.label} owner is ${owner}, but signer is ${signer.address}`);
    }
    return;
  }

  const role = await contract.DEFAULT_ADMIN_ROLE();
  const hasRole = await contract.hasRole(role, signer.address);
  if (!hasRole) {
    throw new Error(`${target.label} signer ${signer.address} does not have DEFAULT_ADMIN_ROLE`);
  }
}

async function handleTarget(target, signer) {
  if (!selected(target)) return;

  const proxyAddress = requireAddress(target.envName);
  const Factory = await ethers.getContractFactory(target.contractName);

  if (process.env.VALIDATE_ONLY === "true") {
    await upgrades.validateUpgrade(proxyAddress, Factory, { kind: "uups" });
    console.log(`${target.label}: storage-compatible`);
    return;
  }

  await assertCanUpgrade(target, proxyAddress, signer);

  console.log(`${target.label}: upgrading ${proxyAddress}`);
  const upgraded = await upgrades.upgradeProxy(proxyAddress, Factory, { kind: "uups" });
  await upgraded.waitForDeployment();

  console.log(`${target.label}: upgraded`);
  console.log(`${target.label}_PROXY=${await upgraded.getAddress()}`);
  console.log(`${target.label}_IMPLEMENTATION=${await upgrades.erc1967.getImplementationAddress(proxyAddress)}`);
}

async function main() {
  const [signer] = await ethers.getSigners();
  const targets = TARGETS.filter(selected);

  if (!targets.length) {
    throw new Error("Select at least one target: UPGRADE_MATRIX=true, UPGRADE_POOL=true, or UPGRADE_ORBD=true");
  }

  console.log("Network:", network.name);
  console.log("Signer:", signer.address);
  console.log("Mode:", process.env.VALIDATE_ONLY === "true" ? "validate only" : "upgrade");

  for (const target of targets) {
    await handleTarget(target, signer);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

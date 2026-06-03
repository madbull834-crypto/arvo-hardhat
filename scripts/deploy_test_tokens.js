/**
 * Deploy ARVO testnet token dependencies:
 *   - MockUSDT, 6 decimals, freely mintable for testing
 *   - ORBDToken as an upgradeable UUPS proxy
 *
 * Usage:
 *   npx hardhat run scripts/deploy_test_tokens.js --network sepolia
 */
const { ethers, network, upgrades } = require("hardhat");

const USDT_DECIMALS = 18;
const DEFAULT_ORBD_MAX_SUPPLY = ethers.parseUnits("1000000000", 18);

function orbdMaxSupply() {
  const raw = process.env.ORBD_MAX_SUPPLY;
  return raw ? BigInt(raw) : DEFAULT_ORBD_MAX_SUPPLY;
}

async function transferOrbdAdmin(orbd, newAdmin) {
  if (!newAdmin) return;
  if (!ethers.isAddress(newAdmin)) {
    throw new Error("ORBD_ADMIN_ADDRESS must be a valid address");
  }

  const [deployer] = await ethers.getSigners();
  const adminRole = await orbd.DEFAULT_ADMIN_ROLE();

  await (await orbd.grantRole(adminRole, newAdmin)).wait();
  if (newAdmin.toLowerCase() !== deployer.address.toLowerCase()) {
    await (await orbd.revokeRole(adminRole, deployer.address)).wait();
  }

  console.log("ORBD DEFAULT_ADMIN_ROLE:", newAdmin);
}

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log(`Deploying token contracts on ${network.name}`);
  console.log("Deployer:", deployer.address);

  const MockUSDT = await ethers.getContractFactory("MockUSDT");
  const usdt = await MockUSDT.deploy();
  await usdt.waitForDeployment();

  const ORBDToken = await ethers.getContractFactory("ORBDToken");
  const orbd = await upgrades.deployProxy(ORBDToken, [orbdMaxSupply()], { kind: "uups" });
  await orbd.waitForDeployment();

  const usdtAddress = await usdt.getAddress();
  const orbdAddress = await orbd.getAddress();
  const orbdImplementation = await upgrades.erc1967.getImplementationAddress(orbdAddress);

  console.log("\nMockUSDT deployed:", usdtAddress);
  console.log("ORBDToken proxy deployed:", orbdAddress);
  console.log("ORBDToken implementation:", orbdImplementation);

  const mintTo = process.env.TEST_USDT_MINT_TO || deployer.address;
  const mintAmount = process.env.TEST_USDT_MINT_AMOUNT || "100000";

  const amount = ethers.parseUnits(mintAmount, USDT_DECIMALS);
  const tx = await usdt.mint(mintTo, amount);
  await tx.wait();

  console.log(`\nMinted ${mintAmount} test USDT to:`, mintTo);
  await transferOrbdAdmin(orbd, process.env.ORBD_ADMIN_ADDRESS);

  console.log("\nAdd these to .env for testnet deployments:");
  console.log(`USDT_ADDRESS=${usdtAddress}`);
  console.log(`ORBD_TOKEN_ADDRESS=${orbdAddress}`);
  console.log("VERIFY_ORBD_MOCK=false");
  console.log(`ORBD_MAX_SUPPLY=${orbdMaxSupply().toString()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

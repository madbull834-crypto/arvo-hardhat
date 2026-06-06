/**
 * Verify ARVO BNB mainnet deployment from deployments/bscMainnet.json.
 *
 * This verifies the implementation contracts and the ERC1967 proxy contracts.
 * After this, use BscScan's "Is this a proxy?" / "Read as Proxy" flow if the
 * proxy ABI is not linked automatically.
 *
 * Run:
 *   npx hardhat run scripts/verify_bsc_mainnet.js --network bscMainnet
 */
const { ethers, network, run } = require("hardhat");
const fs = require("fs");
const path = require("path");

const BSC_MAINNET_CHAIN_ID = 56;
const MANIFEST_PATH = path.join(__dirname, "..", "deployments", "bscMainnet.json");

function readManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`Deployment manifest not found: ${MANIFEST_PATH}`);
  }

  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function requireAddress(name, value) {
  if (!ethers.isAddress(value || "")) {
    throw new Error(`${name} must be a valid address, got ${value || "<empty>"}`);
  }

  return ethers.getAddress(value);
}

async function requireMainnet() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (network.name !== "bscMainnet" || chainId !== BSC_MAINNET_CHAIN_ID) {
    throw new Error(`Refusing verify: expected bscMainnet chainId 56, got ${network.name} chainId ${chainId}`);
  }
}

async function requireCode(label, address) {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") {
    throw new Error(`${label} has no bytecode at ${address}`);
  }
}

async function verifyOne(label, args) {
  console.log(`\nVerifying ${label}`);
  console.log("Address:", args.address);

  try {
    await run("verify:verify", args);
    console.log(`${label}: verified`);
  } catch (error) {
    const message = error.message || "";
    if (
      message.includes("Already Verified") ||
      message.includes("already verified") ||
      message.includes("Contract source code already verified")
    ) {
      console.log(`${label}: already verified`);
      return;
    }

    throw error;
  }
}

async function main() {
  await requireMainnet();

  const manifest = readManifest();
  if (manifest.network !== "bscMainnet" || manifest.chainId !== BSC_MAINNET_CHAIN_ID) {
    throw new Error("deployments/bscMainnet.json does not look like a BNB mainnet deployment");
  }

  const contracts = manifest.contracts || {};
  const poolProxy = requireAddress("contracts.weeklyPool", contracts.weeklyPool);
  const poolImpl = requireAddress("contracts.weeklyPoolImpl", contracts.weeklyPoolImpl);
  const matrixProxy = requireAddress("contracts.matrix", contracts.matrix);
  const matrixImpl = requireAddress("contracts.matrixImpl", contracts.matrixImpl);
  const usdt = requireAddress("contracts.usdt", contracts.usdt);
  const orbd = requireAddress("contracts.orbd", contracts.orbd);
  const genesis = requireAddress("genesis", manifest.genesis);
  const skipAdmin1 = requireAddress("skipAdmin1", manifest.skipAdmin1);
  const skipAdmin2 = requireAddress("skipAdmin2", manifest.skipAdmin2);
  const weights = manifest.poolWeights;

  if (!Array.isArray(weights) || weights.length !== 11) {
    throw new Error("Manifest poolWeights must contain 11 values");
  }

  await requireCode("ARVOWeeklyPool proxy", poolProxy);
  await requireCode("ARVOWeeklyPool implementation", poolImpl);
  await requireCode("ARVOMatrix proxy", matrixProxy);
  await requireCode("ARVOMatrix implementation", matrixImpl);

  const poolFactory = await ethers.getContractFactory("ARVOWeeklyPool");
  const matrixFactory = await ethers.getContractFactory("ARVOMatrix");
  const poolInitData = poolFactory.interface.encodeFunctionData("initialize", [usdt, orbd, weights]);
  const matrixInitData = matrixFactory.interface.encodeFunctionData("initialize", [
    usdt,
    poolProxy,
    genesis,
    skipAdmin1,
    skipAdmin2,
  ]);

  await verifyOne("ARVOWeeklyPool implementation", {
    address: poolImpl,
    contract: "contracts/core/ARVOWeeklyPool.sol:ARVOWeeklyPool",
  });
  await verifyOne("ARVOMatrix implementation", {
    address: matrixImpl,
    contract: "contracts/core/ARVOMatrix.sol:ARVOMatrix",
  });
  await verifyOne("ARVOWeeklyPool ERC1967 proxy", {
    address: poolProxy,
    constructorArguments: [poolImpl, poolInitData],
    contract: "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
  });
  await verifyOne("ARVOMatrix ERC1967 proxy", {
    address: matrixProxy,
    constructorArguments: [matrixImpl, matrixInitData],
    contract: "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
  });

  console.log("\nProxy addresses:");
  console.log("ARVO_WEEKLY_POOL_ADDRESS=", poolProxy);
  console.log("ARVO_MATRIX_ADDRESS=", matrixProxy);
  console.log("\nBNB mainnet verification complete.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

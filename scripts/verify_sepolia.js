/**
 * verify_sepolia.js — Verify all ARVO contracts on Etherscan (Sepolia)
 *
 * Run after deploy_sepolia.js if verification was skipped or failed:
 *   npx hardhat run scripts/verify_sepolia.js --network sepolia
 *
 * Required .env:
 *   ETHERSCAN_API_KEY
 *   USDT_ADDRESS
 *   ORBD_TOKEN_ADDRESS
 *   ARVO_WEEKLY_POOL_ADDRESS
 *   ARVO_MATRIX_ADDRESS
 */
const { ethers, network, run, upgrades } = require("hardhat");
const path = require("path");
const fs   = require("fs");

function log(msg)  { console.log(msg); }
function step(msg) { console.log(`\n${"─".repeat(56)}\n  ${msg}`); }

async function verifyOne(label, address, contractPath, constructorArgs = []) {
  log(`  Verifying ${label} at ${address}`);
  try {
    await run("verify:verify", {
      address,
      contract: contractPath,
      constructorArguments: constructorArgs,
    });
    log(`  ${label}: ✓ verified`);
  } catch (err) {
    const msg = err.message || "";
    if (msg.toLowerCase().includes("already verified")) {
      log(`  ${label}: already verified ✓`);
    } else {
      log(`  ${label}: FAILED — ${msg}`);
      log(`  Retry: npx hardhat verify --network sepolia ${address}`);
    }
  }
}

async function getImpl(proxyAddress) {
  try {
    return await upgrades.erc1967.getImplementationAddress(proxyAddress);
  } catch {
    return proxyAddress;
  }
}

async function main() {
  if (network.name !== "sepolia") {
    throw new Error(`Expected --network sepolia, got "${network.name}"`);
  }

  const {
    USDT_ADDRESS,
    ORBD_TOKEN_ADDRESS,
    ARVO_WEEKLY_POOL_ADDRESS,
    ARVO_MATRIX_ADDRESS,
    VERIFY_ORBD_MOCK,
  } = process.env;

  // Try to load addresses from deployment manifest if env vars are missing
  const manifestPath = path.join(__dirname, "..", "deployments", "sepolia.json");
  let manifest = {};
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    log("  Loaded addresses from deployments/sepolia.json");
  }

  const usdt      = USDT_ADDRESS              || manifest?.contracts?.usdt;
  const orbd      = ORBD_TOKEN_ADDRESS        || manifest?.contracts?.orbd;
  const pool      = ARVO_WEEKLY_POOL_ADDRESS  || manifest?.contracts?.weeklyPool;
  const matrix    = ARVO_MATRIX_ADDRESS       || manifest?.contracts?.matrix;
  const poolImpl  = manifest?.contracts?.weeklyPoolImpl;
  const matrixImpl= manifest?.contracts?.matrixImpl;

  for (const [name, addr] of [["USDT", usdt], ["ORBD", orbd], ["Pool", pool], ["Matrix", matrix]]) {
    if (!addr || !ethers.isAddress(addr)) throw new Error(`${name} address missing or invalid`);
    const code = await ethers.provider.getCode(addr);
    if (code === "0x") throw new Error(`${name} (${addr}) has no bytecode on Sepolia`);
  }

  log(`\n${"═".repeat(56)}`);
  log(`  ARVO Sepolia — Contract Verification`);
  log(`${"═".repeat(56)}`);
  log(`  Network: ${network.name}`);
  log(`  USDT:    ${usdt}`);
  log(`  ORBD:    ${orbd}`);
  log(`  Pool:    ${pool}`);
  log(`  Matrix:  ${matrix}`);

  log("\n  Waiting 20 seconds for Etherscan to index…");
  await new Promise(r => setTimeout(r, 20_000));

  // Verify MockUSDT
  step("1 / 4 — MockUSDT");
  await verifyOne("MockUSDT", usdt, "contracts/mocks/MockUSDT.sol:MockUSDT");

  // Verify ORBD (mock or real)
  step("2 / 4 — ORBDToken");
  const orbdIsMock = VERIFY_ORBD_MOCK === "true";
  if (orbdIsMock) {
    await verifyOne("MockORBDToken", orbd, "contracts/mocks/MockORBDToken.sol:MockORBDToken");
  } else {
    // Real ORBDToken is a UUPS proxy — verify the implementation
    const orbdImpl = await getImpl(orbd);
    await verifyOne("ORBDToken implementation", orbdImpl, "contracts/tokens/ORBDToken.sol:ORBDToken");
  }

  // Verify ARVOWeeklyPool implementation
  step("3 / 4 — ARVOWeeklyPool");
  const resolvedPoolImpl = poolImpl || await getImpl(pool);
  await verifyOne(
    "ARVOWeeklyPool implementation",
    resolvedPoolImpl,
    "contracts/core/ARVOWeeklyPool.sol:ARVOWeeklyPool"
  );
  // Also submit proxy address so Etherscan shows the proxy UI
  await verifyOne("ARVOWeeklyPool proxy", pool, "contracts/core/ARVOWeeklyPool.sol:ARVOWeeklyPool");

  // Verify ARVOMatrix implementation
  step("4 / 4 — ARVOMatrix");
  const resolvedMatrixImpl = matrixImpl || await getImpl(matrix);
  await verifyOne(
    "ARVOMatrix implementation",
    resolvedMatrixImpl,
    "contracts/core/ARVOMatrix.sol:ARVOMatrix"
  );
  await verifyOne("ARVOMatrix proxy", matrix, "contracts/core/ARVOMatrix.sol:ARVOMatrix");

  log(`\n${"═".repeat(56)}`);
  log(`  Verification complete.`);
  log(`  View on Etherscan:`);
  log(`    USDT:   https://sepolia.etherscan.io/address/${usdt}`);
  log(`    ORBD:   https://sepolia.etherscan.io/address/${orbd}`);
  log(`    Pool:   https://sepolia.etherscan.io/address/${pool}`);
  log(`    Matrix: https://sepolia.etherscan.io/address/${matrix}`);
  log(`${"═".repeat(56)}\n`);
}

main().catch(err => { console.error(err.message || err); process.exit(1); });

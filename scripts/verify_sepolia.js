/**
 * verify_sepolia.js — Verify all ARVO contracts on Etherscan (Sepolia)
 *
 * Run after deploy_sepolia.js if verification was skipped or failed:
 *   npx hardhat run scripts/verify_sepolia.js --network sepolia
 *
 * Required .env:
 *   ETHERSCAN_API_KEY
 *
 * Address source:
 *   Preferred: deployments/sepolia.json from deploy_sepolia.js
 *   Fallback:  USDT_ADDRESS, ORBD_TOKEN_ADDRESS, ORBD_USDT_PAIR_ADDRESS,
 *              ARVO_WEEKLY_POOL_ADDRESS, ARVO_MATRIX_ADDRESS
 */
const { ethers, network, run, upgrades } = require("hardhat");
const path = require("path");
const fs   = require("fs");

function log(msg)  { console.log(msg); }
function step(msg) { console.log(`\n${"─".repeat(56)}\n  ${msg}`); }

async function verifyOne(label, address, contractPath, constructorArgs = []) {
  log(`  Verifying ${label} at ${address}`);
  try {
    const args = {
      address,
      constructorArguments: constructorArgs,
    };
    if (contractPath) args.contract = contractPath;
    await run("verify:verify", args);
    log(`  ${label}: ✓ verified`);
  } catch (err) {
    const msg = err.message || "";
    if (msg.toLowerCase().includes("already verified")) {
      log(`  ${label}: already verified ✓`);
    } else {
      log(`  ${label}: FAILED — ${msg}`);
      log(`  Retry manually if needed: npx hardhat verify --network sepolia ${address}`);
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
    ORBD_USDT_PAIR_ADDRESS,
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
  const oraclePair= ORBD_USDT_PAIR_ADDRESS    || manifest?.contracts?.oraclePair || manifest?.oracle?.pair;
  const pool      = ARVO_WEEKLY_POOL_ADDRESS  || manifest?.contracts?.weeklyPool;
  const matrix    = ARVO_MATRIX_ADDRESS       || manifest?.contracts?.matrix;
  const poolImpl  = manifest?.contracts?.weeklyPoolImpl;
  const matrixImpl= manifest?.contracts?.matrixImpl;

  for (const [name, addr] of [
    ["USDT", usdt],
    ["ORBD", orbd],
    ["ORBD/USDT oracle pair", oraclePair],
    ["Pool", pool],
    ["Matrix", matrix],
  ]) {
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
  log(`  Pair:    ${oraclePair}`);
  log(`  Pool:    ${pool}`);
  log(`  Matrix:  ${matrix}`);

  log("\n  Waiting 20 seconds for Etherscan to index…");
  await new Promise(r => setTimeout(r, 20_000));

  // Verify MockUSDT
  step("1 / 5 — MockUSDT");
  await verifyOne("MockUSDT", usdt, "contracts/mocks/MockUSDT.sol:MockUSDT");

  // Verify ORBD (mock or real)
  step("2 / 5 — ORBDToken");
  // deploy_sepolia.js deploys MockORBDToken. Set VERIFY_ORBD_MOCK=false only
  // if you intentionally pointed Sepolia at an ORBDToken UUPS proxy.
  const orbdIsMock = VERIFY_ORBD_MOCK !== "false";
  if (orbdIsMock) {
    await verifyOne("MockORBDToken", orbd, "contracts/mocks/MockORBDToken.sol:MockORBDToken");
  } else {
    // Real ORBDToken is a UUPS proxy — verify the implementation
    const orbdImpl = await getImpl(orbd);
    await verifyOne("ORBDToken implementation", orbdImpl, "contracts/tokens/ORBDToken.sol:ORBDToken");
  }

  step("3 / 5 — MockPancakeV2Pair");
  await verifyOne(
    "MockPancakeV2Pair",
    oraclePair,
    "contracts/mocks/MockPancakeV2Pair.sol:MockPancakeV2Pair",
    [usdt, orbd]
  );

  // Verify ARVOWeeklyPool implementation
  step("4 / 5 — ARVOWeeklyPool");
  const resolvedPoolImpl = poolImpl || await getImpl(pool);
  await verifyOne(
    "ARVOWeeklyPool implementation",
    resolvedPoolImpl,
    "contracts/core/ARVOWeeklyPool.sol:ARVOWeeklyPool"
  );
  log(`  ARVOWeeklyPool proxy address: ${pool}`);
  log("  Proxy source verification is skipped; implementation source is verified above.");

  // Verify ARVOMatrix implementation
  step("5 / 5 — ARVOMatrix");
  const resolvedMatrixImpl = matrixImpl || await getImpl(matrix);
  await verifyOne(
    "ARVOMatrix implementation",
    resolvedMatrixImpl,
    "contracts/core/ARVOMatrix.sol:ARVOMatrix"
  );
  log(`  ARVOMatrix proxy address: ${matrix}`);
  log("  Proxy source verification is skipped; implementation source is verified above.");

  log(`\n${"═".repeat(56)}`);
  log(`  Verification complete.`);
  log(`  View on Etherscan:`);
  log(`    USDT:   https://sepolia.etherscan.io/address/${usdt}`);
  log(`    ORBD:   https://sepolia.etherscan.io/address/${orbd}`);
  log(`    Pair:   https://sepolia.etherscan.io/address/${oraclePair}`);
  log(`    Pool:   https://sepolia.etherscan.io/address/${pool}`);
  log(`    Matrix: https://sepolia.etherscan.io/address/${matrix}`);
  log(`${"═".repeat(56)}\n`);
}

main().catch(err => { console.error(err.message || err); process.exit(1); });

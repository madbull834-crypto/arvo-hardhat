/**
 * migrate_from_legacy.js — Reference script for migrating legacy ARVO data
 *                          into a freshly deployed ARVOMatrix contract.
 *
 * MANDATORY CALL ORDER:
 *   1. pause()                   — stop new registrations during migration
 *   2. migrateUsers()            — import full user structs  (or migrateSimpleUsers)
 *   3. migratePlacementQueue()   — rebuild BFS subtree queues  ← ONLY after migrateUsers
 *   4. migrateUserAccounting()   — import income/withdrawal history
 *   5. migrateDirectReferrals()  — rebuild _directReferrals UI index
 *   6. closeMigration()          — lock all migration functions forever
 *   7. unpause()                 — open registrations
 *
 * IMPORTANT RULES:
 *   • migrateUsers / migrateSimpleUsers are mutually exclusive migration paths:
 *       - Use migrateUsers   when you have the full per-level sub-counts,
 *         lockedFunds, and claimableUsdt from the old chain.
 *       - Use migrateSimpleUsers  when you only have sponsor, level, and directCount.
 *   • NEVER call migratePlacementQueue after migrateSimpleUsers — the subtree
 *     queues are already built by _placeInSponsorTree inside migrateSimpleUsers,
 *     and calling migratePlacementQueue on top would add duplicate entries.
 *   • ALWAYS pause the contract before starting migration so no new registrations
 *     interleave with the import.
 *   • migrateUserAccounting uses replace=true by default (sets values, not adds).
 *     Pass replace=false if you want to add to existing on-chain earnings.
 *
 * Required .env:
 *   PRIVATE_KEY, SEPOLIA_RPC_URL (or BSC_TESTNET_RPC)
 *   ARVO_MATRIX_ADDRESS   — the freshly deployed proxy
 *
 * Run:
 *   npx hardhat run scripts/migrate_from_legacy.js --network sepolia
 */

const { ethers, network } = require("hardhat");

// ─── Replace this with your real legacy dataset ───────────────────────────────
//
// Each object maps to MigrationUser struct in ARVOMatrix.sol:
//   account, referrer, parent, leftChild, rightChild,
//   currentLevel, directCount, claimableUsdt,
//   levelSubCount[13], lockedFunds[13]
//
// The array MUST be in BFS order (top → bottom, left → right).
// Genesis must be the first element if included.
//
const LEGACY_USERS = [
  // EXAMPLE: replace with real data exported from old contract
  {
    account:       "0xc0E6c08d2d0D8A61E43a5Dd4f3FDFF83F2079Da3", // genesis
    referrer:      "0x0000000000000000000000000000000000000000",
    parent:        "0x0000000000000000000000000000000000000000",
    leftChild:     "0x0000000000000000000000000000000000000000", // fill if known
    rightChild:    "0x0000000000000000000000000000000000000000",
    currentLevel:  12,
    directCount:   0n,
    claimableUsdt: 0n,
    levelSubCount: Array(13).fill(0n), // index 0 unused, 1-12 are levels
    lockedFunds:   Array(13).fill(0n),
  },
  // Add more users here ...
];

// BFS-ordered queue for migratePlacementQueue (same order as LEGACY_USERS usually)
const BFS_QUEUE_ORDER = LEGACY_USERS.map(u => u.account);

// queueHead = index of the first node that still has at least one open child slot
// 0 means genesis still has open slots (set correctly for your tree)
const QUEUE_HEAD = 0;

// ─── Accounting history (optional) ───────────────────────────────────────────
// Maps address → { directIncome, levelIncome, skippedIncome, withdrawn }
// All values in 18-decimal USDT (same as the new contract).
const LEGACY_ACCOUNTING = [
  // { account, directIncome, levelIncome, skippedIncome, withdrawn }
];

// ─── Direct referral lists (optional) ────────────────────────────────────────
// Array of { referrer, referrals[] }
const LEGACY_DIRECT_REFERRALS = [
  // { referrer: "0x...", referrals: ["0x...", "0x..."] }
];

// ─── Batch sizes (tune for gas limits) ───────────────────────────────────────
const USER_BATCH         = 50;  // migrateUsers rows per tx
const ACCOUNTING_BATCH   = 100; // migrateUserAccounting rows per tx

// ─── Helpers ──────────────────────────────────────────────────────────────────
function log(msg)  { console.log(msg); }
function step(msg) { console.log(`\n${"─".repeat(60)}\n  ${msg}`); }

async function confirm(tx, label) {
  log(`  TX: ${tx.hash}`);

  const timeoutMinutes = Number(process.env.TX_WAIT_TIMEOUT_MINUTES || 30);
  const pollSeconds = Number(process.env.TX_WAIT_POLL_SECONDS || 5);
  const deadline = Date.now() + timeoutMinutes * 60_000;
  let lastBlock = 0;
  let receipt = null;

  while (Date.now() < deadline) {
    receipt = await ethers.provider.getTransactionReceipt(tx.hash);
    if (receipt) break;

    const block = await ethers.provider.getBlockNumber();
    if (block !== lastBlock) {
      lastBlock = block;
      log(`  Waiting for mining... latest block ${block}`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
  }

  if (!receipt) {
    throw new Error(
      `${label} was not mined within ${timeoutMinutes} minutes.\n` +
      `Transaction hash: ${tx.hash}\n` +
      "Check the hash on the block explorer before rerunning migration."
    );
  }

  if (receipt.status !== 1) {
    throw new Error(`${label} reverted in block ${receipt.blockNumber}. Transaction hash: ${tx.hash}`);
  }

  log(`  ${label} — block ${receipt.blockNumber} ✓`);
  return receipt;
}

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function txOptions() {
  const options = {};
  if (process.env.TX_GAS_PRICE_GWEI) {
    options.gasPrice = ethers.parseUnits(process.env.TX_GAS_PRICE_GWEI, "gwei");
  }
  if (process.env.TX_GAS_LIMIT) {
    options.gasLimit = BigInt(process.env.TX_GAS_LIMIT);
  }
  return options;
}

// ─── Migration steps ──────────────────────────────────────────────────────────

async function step1_pause(matrix, signer) {
  step("1. Pause registrations");
  const paused = await matrix.paused();
  if (paused) { log("  Already paused — skipping"); return; }
  await confirm(await matrix.connect(signer).pause(txOptions()), "Contract paused");
}

async function step2_migrateUsers(matrix, signer) {
  step("2. Migrate users (full struct)");
  if (LEGACY_USERS.length === 0) { log("  No users to migrate — skipping"); return; }

  const batches = chunk(LEGACY_USERS, USER_BATCH);
  log(`  ${LEGACY_USERS.length} users in ${batches.length} batches of ${USER_BATCH}`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i].map(u => ({
      account:       u.account,
      referrer:      u.referrer,
      parent:        u.parent,
      leftChild:     u.leftChild,
      rightChild:    u.rightChild,
      currentLevel:  u.currentLevel,
      directCount:   u.directCount,
      claimableUsdt: u.claimableUsdt,
      levelSubCount: u.levelSubCount,
      lockedFunds:   u.lockedFunds,
    }));
    await confirm(
      await matrix.connect(signer).migrateUsers(batch, txOptions()),
      `Batch ${i + 1}/${batches.length} (${batch.length} users)`
    );
  }
}

// Alternative path when only basic data is available (no lockedFunds/levelSubCount).
// If you use this path, do NOT call step3_migratePlacementQueue.
async function step2b_migrateSimpleUsers(matrix, signer) {
  step("2b. Migrate simple users (light — no lockedFunds)");
  if (LEGACY_USERS.length === 0) { log("  No users to migrate — skipping"); return; }

  // Must be in BFS order (parents before children)
  const accounts  = LEGACY_USERS.map(u => u.account);
  const referrers = LEGACY_USERS.map(u => u.referrer);
  const levels    = LEGACY_USERS.map(u => u.currentLevel);
  const directs   = LEGACY_USERS.map(u => u.directCount);

  const accountBatches  = chunk(accounts,  USER_BATCH);
  const referrerBatches = chunk(referrers, USER_BATCH);
  const levelBatches    = chunk(levels,    USER_BATCH);
  const directBatches   = chunk(directs,   USER_BATCH);

  for (let i = 0; i < accountBatches.length; i++) {
    await confirm(
      await matrix.connect(signer).migrateSimpleUsers(
        accountBatches[i],
        referrerBatches[i],
        levelBatches[i],
        directBatches[i],
        txOptions()
      ),
      `Simple batch ${i + 1}/${accountBatches.length}`
    );
  }
  log("\n  NOTE: Do NOT call step3_migratePlacementQueue after migrateSimpleUsers.");
  log("  The subtree queues are already built by _placeInSponsorTree.");
}

// Call ONLY after migrateUsers (not after migrateSimpleUsers).
async function step3_migratePlacementQueue(matrix, signer) {
  step("3. Migrate placement queue (BFS order)");
  if (BFS_QUEUE_ORDER.length === 0) { log("  No queue to migrate — skipping"); return; }

  log(`  Queue length: ${BFS_QUEUE_ORDER.length}, head: ${QUEUE_HEAD}`);
  await confirm(
    await matrix.connect(signer).migratePlacementQueue(BFS_QUEUE_ORDER, QUEUE_HEAD, txOptions()),
    `Placement queue migrated (head=${QUEUE_HEAD})`
  );
}

async function step4_migrateAccounting(matrix, signer) {
  step("4. Migrate user accounting (income history)");
  if (LEGACY_ACCOUNTING.length === 0) { log("  No accounting data — skipping"); return; }

  const batches = chunk(LEGACY_ACCOUNTING, ACCOUNTING_BATCH);
  log(`  ${LEGACY_ACCOUNTING.length} records in ${batches.length} batches`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    await confirm(
      await matrix.connect(signer).migrateUserAccounting(
        batch.map(r => r.account),
        batch.map(r => r.directIncome),
        batch.map(r => r.levelIncome),
        batch.map(r => r.skippedIncome),
        batch.map(r => r.withdrawn),
        true,  // replace=true: set values (not add). Use false if users already have on-chain activity.
        txOptions()
      ),
      `Accounting batch ${i + 1}/${batches.length}`
    );
  }
}

async function step5_migrateDirectReferrals(matrix, signer) {
  step("5. Migrate direct referral lists");
  if (LEGACY_DIRECT_REFERRALS.length === 0) { log("  No referral data — skipping"); return; }

  for (const { referrer, referrals } of LEGACY_DIRECT_REFERRALS) {
    if (!referrals.length) continue;
    await confirm(
      await matrix.connect(signer).migrateDirectReferrals(referrer, referrals, true, txOptions()),
      `Referrals set for ${referrer} (${referrals.length} entries)`
    );
  }
}

async function step6_closeMigration(matrix, signer) {
  step("6. Close migration permanently");
  await confirm(
    await matrix.connect(signer).closeMigration(txOptions()),
    "Migration closed forever — no further imports possible"
  );
}

async function step7_unpause(matrix, signer) {
  step("7. Unpause registrations");
  await confirm(await matrix.connect(signer).unpause(txOptions()), "Contract unpaused — registrations open");
}

async function verifyState(matrix) {
  step("Verification");
  const total    = await matrix.totalMembers();
  const closed   = await matrix.migrationClosed();
  const paused   = await matrix.paused();
  const qHead    = await matrix.getQueueHead();
  const qLength  = await matrix.getQueueLength();

  log(`  totalMembers:     ${total}`);
  log(`  migrationClosed:  ${closed}`);
  log(`  paused:           ${paused}`);
  log(`  queueHead:        ${qHead}`);
  log(`  queueLength:      ${qLength}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const matrixAddress = process.env.ARVO_MATRIX_ADDRESS;
  if (!matrixAddress || !ethers.isAddress(matrixAddress)) {
    throw new Error("ARVO_MATRIX_ADDRESS must be set in .env");
  }

  const [signer] = await ethers.getSigners();
  const matrix   = await ethers.getContractAt("ARVOMatrix", matrixAddress);

  // Verify signer is owner
  const owner = await matrix.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `Signer ${signer.address} is not the contract owner (${owner}). ` +
      `Make sure PRIVATE_KEY in .env matches the deployer.`
    );
  }

  log(`\n${"═".repeat(60)}`);
  log(`  ARVO Legacy Migration`);
  log(`${"═".repeat(60)}`);
  log(`  Network:  ${network.name}`);
  log(`  Matrix:   ${matrixAddress}`);
  log(`  Signer:   ${signer.address}`);
  log(`  Users:    ${LEGACY_USERS.length}`);
  log(`  Acct:     ${LEGACY_ACCOUNTING.length}`);
  log(`  Referrals:${LEGACY_DIRECT_REFERRALS.length} referrers`);

  // ── Choose migration path ────────────────────────────────────────────────────
  // PATH A: Full migration (has lockedFunds + levelSubCount data)
  //   → steps 1, 2, 3, 4, 5, 6, 7
  //
  // PATH B: Simple migration (only sponsor + level + directs)
  //   → steps 1, 2b, 4, 5, 6, 7   (skip step 3 — no migratePlacementQueue)

  const USE_SIMPLE_MIGRATION = process.env.USE_SIMPLE_MIGRATION === "true";

  await step1_pause(matrix, signer);

  if (USE_SIMPLE_MIGRATION) {
    await step2b_migrateSimpleUsers(matrix, signer);
    // NO step3 after simple migration
  } else {
    await step2_migrateUsers(matrix, signer);
    await step3_migratePlacementQueue(matrix, signer);
  }

  await step4_migrateAccounting(matrix, signer);
  await step5_migrateDirectReferrals(matrix, signer);
  await step6_closeMigration(matrix, signer);
  await step7_unpause(matrix, signer);
  await verifyState(matrix);

  log(`\n${"═".repeat(60)}`);
  log(`  MIGRATION COMPLETE`);
  log(`${"═".repeat(60)}\n`);
}

main().catch(err => {
  console.error("\nMIGRATION FAILED:", err.message || err);
  process.exit(1);
});

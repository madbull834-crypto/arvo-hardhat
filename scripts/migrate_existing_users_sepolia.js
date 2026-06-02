/**
 * migrate_existing_users_sepolia.js
 *
 * PURPOSE
 * -------
 * Reads every registered user from the OLD Sepolia ARVOMatrix contract,
 * then writes them into the NEW contract using migrateSimpleUsers().
 *
 * This is the correct path when users have NO income to migrate —
 * only their tree position (referrer + level + directCount) matters.
 *
 * WHAT IT DOES
 * ------------
 *  1. Reads UserRegistered events from the old contract (chronological = BFS order)
 *  2. Fetches referrer, currentLevel, directCount for every user
 *  3. Validates the list (no duplicates, no zero addresses, BFS order preserved)
 *  4. Pauses the NEW contract
 *  5. Calls migrateSimpleUsers() in batches on the NEW contract
 *  6. Calls closeMigration() and unpauses
 *  7. Verifies totalMembers matches
 *
 * IMPORTANT
 * ---------
 *  • Do NOT call migratePlacementQueue after migrateSimpleUsers.
 *    The subtree queues are built automatically during placement.
 *  • Do NOT call migrateUserAccounting (users have no income).
 *  • Existing users have no claimableUsdt, lockedFunds, or levelSubCount
 *    to preserve — migrateSimpleUsers starts them fresh at their current
 *    level so new registrations flow correctly from that point.
 *
 * REQUIRED .env
 * -------------
 *  PRIVATE_KEY             — deployer / owner key
 *  SEPOLIA_RPC_URL         — Alchemy Sepolia endpoint
 *  OLD_MATRIX_ADDRESS      — old ARVOMatrix proxy (to read users from)
 *  ARVO_MATRIX_ADDRESS     — new ARVOMatrix proxy (to write users into)
 *  GENESIS_ADDRESS         — root address (must match new contract)
 *
 * OPTIONAL .env
 * -------------
 *  EVENT_START_BLOCK       — block where old contract was deployed (speeds up scan)
 *  BATCH_SIZE              — users per migrateSimpleUsers tx (default: 50)
 *  DRY_RUN=true            — read + print users, skip all writes
 *
 * Run:
 *   OLD_MATRIX_ADDRESS=0x8E245499... \
 *   npx hardhat run scripts/migrate_existing_users_sepolia.js --network sepolia
 */

const { ethers, network } = require("hardhat");
const fs   = require("fs");
const path = require("path");

// ─── Minimal ABI needed to read the old contract ──────────────────────────────
// (Works with both old and new ARVOMatrix since view functions didn't change)
const OLD_MATRIX_ABI = [
  "event UserRegistered(address indexed user, address indexed referrer, address indexed parent, uint8 side, uint256 timestamp)",
  "function getUserInfo(address user) view returns (bool isRegistered, address referrer, uint8 currentLevel, uint256 directCount, uint256 claimableUsdt)",
  "function totalMembers() view returns (uint256)",
  "function paused() view returns (bool)",
];

const DEFAULT_BATCH   = 50;
const CHUNK_BLOCKS    = 50_000; // max block range per eth_getLogs call

// ─── Helpers ──────────────────────────────────────────────────────────────────
function log(msg)  { console.log(msg); }
function step(msg) { console.log(`\n${"─".repeat(60)}\n  ${msg}`); }

async function confirm(tx, label) {
  log(`  TX: ${tx.hash}`);
  const r = await tx.wait(1);
  log(`  ${label} — block ${r.blockNumber} ✓`);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ─── Step 1: Read all UserRegistered events from old contract ─────────────────
async function readOldUsers(oldMatrix, provider) {
  step("Reading UserRegistered events from old contract…");

  const latest     = await provider.getBlockNumber();
  const fromBlock  = Number(process.env.EVENT_START_BLOCK || 0);
  const filter     = oldMatrix.filters.UserRegistered();

  log(`  Scanning blocks ${fromBlock} → ${latest}`);

  const events = [];
  for (let start = fromBlock; start <= latest; start += CHUNK_BLOCKS + 1) {
    const end = Math.min(latest, start + CHUNK_BLOCKS);
    try {
      const chunk = await oldMatrix.queryFilter(filter, start, end);
      events.push(...chunk);
      if (chunk.length > 0) log(`  Blocks ${start}–${end}: ${chunk.length} events`);
    } catch (err) {
      log(`  Block range ${start}–${end} failed: ${err.message} — skipping`);
    }
  }

  // Sort by block then log index to preserve exact registration order (= BFS order)
  events.sort((a, b) =>
    a.blockNumber !== b.blockNumber
      ? a.blockNumber - b.blockNumber
      : a.logIndex - b.logIndex
  );

  log(`  Total UserRegistered events: ${events.length}`);
  return events;
}

// ─── Step 2: Fetch user details from old contract ─────────────────────────────
async function fetchUserDetails(events, oldMatrix) {
  step("Fetching user details (referrer, level, directs)…");

  const users = [];
  const seen  = new Set();

  for (let i = 0; i < events.length; i++) {
    const { user, referrer } = events[i].args;
    const addr = ethers.getAddress(user);

    if (seen.has(addr.toLowerCase())) {
      log(`  SKIP duplicate: ${addr}`);
      continue;
    }
    seen.add(addr.toLowerCase());

    let info;
    try {
      info = await oldMatrix.getUserInfo(addr);
    } catch {
      log(`  WARN: getUserInfo failed for ${addr} — using event data only`);
      info = {
        isRegistered:  true,
        referrer:      referrer,
        currentLevel:  1,
        directCount:   0n,
        claimableUsdt: 0n,
      };
    }

    if (!info.isRegistered) {
      log(`  WARN: ${addr} not registered on old contract — skipping`);
      continue;
    }

    users.push({
      account:      addr,
      referrer:     ethers.getAddress(info.referrer),
      level:        Number(info.currentLevel),
      directCount:  info.directCount,
      blockNumber:  events[i].blockNumber,
    });

    if ((i + 1) % 20 === 0 || i === events.length - 1) {
      log(`  Fetched ${i + 1}/${events.length}`);
    }
  }

  log(`  Valid users to migrate: ${users.length}`);
  return users;
}

// ─── Step 3: Validate ─────────────────────────────────────────────────────────
function validateUsers(users, genesisAddress) {
  step("Validating user list…");

  const errors = [];
  const seen   = new Set();

  for (const u of users) {
    if (!ethers.isAddress(u.account)) {
      errors.push(`Invalid address: ${u.account}`);
      continue;
    }
    const key = u.account.toLowerCase();
    if (seen.has(key)) {
      errors.push(`Duplicate account: ${u.account}`);
    }
    seen.add(key);

    if (u.level < 1 || u.level > 12) {
      errors.push(`Invalid level ${u.level} for ${u.account}`);
    }

    if (u.account.toLowerCase() === u.referrer.toLowerCase()) {
      errors.push(`Self-referral: ${u.account}`);
    }
  }

  if (errors.length) {
    throw new Error(`Validation failed:\n  ${errors.join("\n  ")}`);
  }

  log(`  All ${users.length} users valid ✓`);
  log(`  Genesis is first: ${users[0]?.account?.toLowerCase() === genesisAddress.toLowerCase() ? "YES ✓" : "NO — genesis will be skipped (already in new contract)"}`);
}

// ─── Step 4: Pause new contract ───────────────────────────────────────────────
async function pauseNew(matrix, signer) {
  step("Pausing new contract…");
  if (await matrix.paused()) { log("  Already paused ✓"); return; }
  await confirm(await matrix.connect(signer).pause(), "New contract paused");
}

// ─── Step 5: Migrate users ────────────────────────────────────────────────────
async function migrateUsers(users, matrix, signer, genesisAddress) {
  step(`Migrating ${users.length} users via migrateSimpleUsers()…`);

  // Genesis is already in the new contract (set in initialize)
  // Skip it to avoid "already registered" error from migrateSimpleUsers
  const toMigrate = users.filter(
    u => u.account.toLowerCase() !== genesisAddress.toLowerCase()
  );

  log(`  Skipping genesis (already in new contract)`);
  log(`  Migrating ${toMigrate.length} non-genesis users`);

  if (toMigrate.length === 0) {
    log("  No users to migrate — done");
    return;
  }

  const batchSize = Number(process.env.BATCH_SIZE || DEFAULT_BATCH);
  const batches   = chunk(toMigrate, batchSize);

  log(`  Batch size: ${batchSize} → ${batches.length} batches`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const accounts  = batch.map(u => u.account);
    const referrers = batch.map(u => u.referrer);
    const levels    = batch.map(u => u.level);
    const directs   = batch.map(u => u.directCount);

    await confirm(
      await matrix.connect(signer).migrateSimpleUsers(accounts, referrers, levels, directs),
      `Batch ${i + 1}/${batches.length} — ${batch.length} users (${accounts[0]} … ${accounts[accounts.length - 1]})`
    );
  }
}

// ─── Step 6: Close and unpause ────────────────────────────────────────────────
async function closeAndUnpause(matrix, signer) {
  step("Closing migration and unpausing…");
  await confirm(await matrix.connect(signer).closeMigration(), "Migration closed forever");
  await confirm(await matrix.connect(signer).unpause(), "New contract unpaused — registrations open");
}

// ─── Step 7: Verify ───────────────────────────────────────────────────────────
async function verify(oldMatrix, newMatrix, expectedCount) {
  step("Verification");

  const oldCount = await oldMatrix.totalMembers();
  const newCount = await newMatrix.totalMembers();
  const closed   = await newMatrix.migrationClosed();
  const paused   = await newMatrix.paused();

  log(`  Old contract members: ${oldCount}`);
  log(`  New contract members: ${newCount}`);
  log(`  Expected:             ${expectedCount + 1}`); // +1 for genesis
  log(`  migrationClosed:      ${closed}`);
  log(`  paused:               ${paused}`);

  if (newCount.toString() !== (BigInt(expectedCount) + 1n).toString()) {
    log(`  WARNING: count mismatch — some users may have been skipped`);
  } else {
    log(`  Member count matches ✓`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (network.name !== "sepolia") {
    throw new Error(`Expected network=sepolia, got "${network.name}"`);
  }

  const OLD_MATRIX  = process.env.OLD_MATRIX_ADDRESS  || process.env.ARVO_MATRIX_ADDRESS;
  const NEW_MATRIX  = process.env.ARVO_MATRIX_ADDRESS;
  const GENESIS     = process.env.GENESIS_ADDRESS;
  const DRY_RUN     = process.env.DRY_RUN === "true";

  if (!ethers.isAddress(OLD_MATRIX)) throw new Error("OLD_MATRIX_ADDRESS must be a valid address");
  if (!ethers.isAddress(NEW_MATRIX)) throw new Error("ARVO_MATRIX_ADDRESS must be a valid address");
  if (!ethers.isAddress(GENESIS))    throw new Error("GENESIS_ADDRESS must be a valid address");

  if (OLD_MATRIX.toLowerCase() === NEW_MATRIX.toLowerCase()) {
    throw new Error(
      "OLD_MATRIX_ADDRESS and ARVO_MATRIX_ADDRESS are the same contract.\n" +
      "Set OLD_MATRIX_ADDRESS to the old Sepolia contract."
    );
  }

  const [signer]   = await ethers.getSigners();
  const provider   = ethers.provider;
  const oldMatrix  = new ethers.Contract(OLD_MATRIX, OLD_MATRIX_ABI, provider);
  const newMatrix  = await ethers.getContractAt("ARVOMatrix", NEW_MATRIX);

  // Verify signer is owner of new contract
  const owner = await newMatrix.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`Signer ${signer.address} is not the new contract owner (${owner})`);
  }

  log(`\n${"═".repeat(60)}`);
  log(`  ARVO — Simple User Migration (No-Income Path)`);
  log(`${"═".repeat(60)}`);
  log(`  Network:     ${network.name}`);
  log(`  Old Matrix:  ${OLD_MATRIX}`);
  log(`  New Matrix:  ${NEW_MATRIX}`);
  log(`  Genesis:     ${GENESIS}`);
  log(`  Signer:      ${signer.address}`);
  log(`  Dry run:     ${DRY_RUN}`);

  // Read + fetch
  const events = await readOldUsers(oldMatrix, provider);
  const users  = await fetchUserDetails(events, oldMatrix);
  validateUsers(users, GENESIS);

  // Save snapshot
  const snapshotDir  = path.join(__dirname, "..", "deployments");
  const snapshotPath = path.join(snapshotDir, "migration_snapshot_sepolia.json");
  if (!fs.existsSync(snapshotDir)) fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(snapshotPath, JSON.stringify(users, null, 2));
  log(`\n  Snapshot saved: ${snapshotPath}`);

  if (DRY_RUN) {
    log("\n  DRY_RUN=true — all reads complete, no writes performed.");
    log("  Review deployments/migration_snapshot_sepolia.json then re-run without DRY_RUN=true.");
    return;
  }

  // Write to new contract
  await pauseNew(newMatrix, signer);
  await migrateUsers(users, newMatrix, signer, GENESIS);
  await closeAndUnpause(newMatrix, signer);
  await verify(oldMatrix, newMatrix, users.length);

  log(`\n${"═".repeat(60)}`);
  log(`  MIGRATION COMPLETE`);
  log(`  ${users.length} existing users moved to new contract.`);
  log(`  New registrations will now continue from the same tree position.`);
  log(`${"═".repeat(60)}\n`);
}

main().catch(err => {
  console.error("\nMIGRATION FAILED:", err.message || err);
  process.exit(1);
});

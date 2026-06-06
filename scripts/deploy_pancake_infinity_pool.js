/**
 * Upgrade/configure the existing ARVOWeeklyPool proxy for PancakeSwap Infinity.
 *
 * This is for the already deployed BNB mainnet pool proxy. It:
 *   1. Validates the UUPS storage layout.
 *   2. Upgrades the pool proxy if it does not expose Infinity functions yet.
 *   3. Configures USDT -> BNB -> ORBD Pancake Infinity CL routing.
 *   4. Reads the live config back and verifies it against .env.
 *
 * Safe checks:
 *   VALIDATE_ONLY=true  Only validate upgrade compatibility and env config.
 *   DRY_RUN=true        Validate + estimate configure gas, no transactions.
 *   SKIP_UPGRADE=true   Do not upgrade; only configure the existing proxy.
 *   SKIP_CONFIGURE=true Upgrade only; do not configure Pancake Infinity.
 *   FORCE_UPGRADE=true  Upgrade even if the proxy already exposes Infinity functions.
 *
 * Run:
 *   npm run deploy:pancakeInfinity:bscMainnet
 */
const { ethers, network, upgrades } = require("hardhat");

const BSC_MAINNET_CHAIN_ID = 56;
const ZERO_ADDRESS = ethers.ZeroAddress;

function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  if (!["true", "false"].includes(value.toLowerCase())) {
    throw new Error(`${name} must be true or false`);
  }
  return value.toLowerCase() === "true";
}

function requireAddress(name) {
  const value = process.env[name];
  if (!ethers.isAddress(value || "")) {
    throw new Error(`${name} must be set to a valid address`);
  }
  return ethers.getAddress(value);
}

function parseUint128Env(name, fallback = "0") {
  const value = BigInt(process.env[name] || fallback);
  if (value < 0n || value > (1n << 128n) - 1n) {
    throw new Error(`${name} must fit in uint128`);
  }
  return value;
}

function sameAddress(a, b) {
  return ethers.getAddress(a) === ethers.getAddress(b);
}

function parseInfinityPath(orbdAddress) {
  const raw = process.env.PANCAKE_INFINITY_CL_PATH;
  if (!raw) throw new Error("PANCAKE_INFINITY_CL_PATH must be set");

  const hops = raw.split(";").map((hop, index) => {
    const parts = hop.split(",").map((part) => part.trim());
    if (parts.length !== 5) {
      throw new Error(`PANCAKE_INFINITY_CL_PATH hop ${index + 1} must have 5 comma-separated fields`);
    }

    const [intermediateCurrency, feeRaw, hooks, poolManager, parameters] = parts;
    if (!ethers.isAddress(intermediateCurrency)) throw new Error(`Invalid intermediateCurrency in hop ${index + 1}`);
    if (!ethers.isAddress(hooks)) throw new Error(`Invalid hooks in hop ${index + 1}`);
    if (!ethers.isAddress(poolManager)) throw new Error(`Invalid poolManager in hop ${index + 1}`);
    if (!/^0x[0-9a-fA-F]{64}$/.test(parameters)) throw new Error(`Invalid parameters bytes32 in hop ${index + 1}`);

    const fee = Number(feeRaw);
    if (!Number.isInteger(fee) || fee < 0 || fee > 1_000_000) {
      throw new Error(`Invalid fee in hop ${index + 1}`);
    }

    return {
      intermediateCurrency: ethers.getAddress(intermediateCurrency),
      fee,
      hooks: ethers.getAddress(hooks),
      poolManager: ethers.getAddress(poolManager),
      hookData: "0x",
      parameters,
    };
  });

  if (!hops.length) throw new Error("PANCAKE_INFINITY_CL_PATH must include at least one hop");
  const lastHop = hops[hops.length - 1];
  if (!sameAddress(lastHop.intermediateCurrency, orbdAddress)) {
    throw new Error("PANCAKE_INFINITY_CL_PATH must end at the pool ORBD token address");
  }

  return hops;
}

async function requireMainnet() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (network.name !== "bscMainnet" || chainId !== BSC_MAINNET_CHAIN_ID) {
    throw new Error(`Refusing deploy: expected bscMainnet chainId 56, got ${network.name} chainId ${chainId}`);
  }
}

async function requireCode(label, address) {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") throw new Error(`${label} has no contract code at ${address}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertPoolAdmin(pool, signer) {
  const defaultAdminRole = await pool.DEFAULT_ADMIN_ROLE();
  const hasAdmin = await pool.hasRole(defaultAdminRole, signer.address);
  if (!hasAdmin) {
    throw new Error(`Signer ${signer.address} does not have ARVOWeeklyPool DEFAULT_ADMIN_ROLE`);
  }
}

async function readInfinityStatus(pool) {
  try {
    return {
      available: true,
      enabled: await pool.pancakeInfinitySwapEnabled(),
      router: await pool.pancakeInfinityRouter(),
      permit2: await pool.pancakePermit2(),
      amountOutMinimum: await pool.pancakeInfinityAmountOutMinimum(),
      path: await pool.getPancakeInfinityPath(),
    };
  } catch {
    return { available: false };
  }
}

async function waitForInfinityInterface(poolAddress) {
  for (let attempt = 1; attempt <= 10; attempt++) {
    const pool = await ethers.getContractAt("ARVOWeeklyPool", poolAddress);
    const status = await readInfinityStatus(pool);
    if (status.available) return pool;

    console.log(`Waiting for upgraded implementation to be visible (${attempt}/10)...`);
    await sleep(3000);
  }

  throw new Error("ARVOWeeklyPool upgrade is not visible from RPC yet; retry in a minute");
}

async function validateInfinityInfra(router, permit2, path) {
  await requireCode("Pancake Infinity Universal Router", router);
  await requireCode("Pancake Permit2", permit2);

  for (const [index, hop] of path.entries()) {
    await requireCode(`Pancake Infinity pool manager hop ${index + 1}`, hop.poolManager);
    if (hop.hooks !== ZERO_ADDRESS) {
      await requireCode(`Pancake Infinity hook hop ${index + 1}`, hop.hooks);
    }
    if (hop.intermediateCurrency !== ZERO_ADDRESS) {
      await requireCode(`Pancake Infinity currency hop ${index + 1}`, hop.intermediateCurrency);
    }
  }
}

function printPath(path) {
  path.forEach((hop, index) => {
    console.log(
      `  hop ${index + 1}: intermediate=${hop.intermediateCurrency} fee=${hop.fee} hooks=${hop.hooks} manager=${hop.poolManager} parameters=${hop.parameters}`
    );
  });
}

function verifyStatus(status, expected) {
  if (!status.available) return false;

  const checks = [
    ["enabled", status.enabled === expected.enabled],
    ["router", sameAddress(status.router, expected.router)],
    ["permit2", sameAddress(status.permit2, expected.permit2)],
    ["amountOutMinimum", status.amountOutMinimum === expected.amountOutMinimum],
    ["path length", status.path.length === expected.path.length],
  ];

  for (let i = 0; i < Math.min(status.path.length, expected.path.length); i++) {
    checks.push([`hop ${i + 1} intermediate`, sameAddress(status.path[i].intermediateCurrency, expected.path[i].intermediateCurrency)]);
    checks.push([`hop ${i + 1} fee`, Number(status.path[i].fee) === expected.path[i].fee]);
    checks.push([`hop ${i + 1} hooks`, sameAddress(status.path[i].hooks, expected.path[i].hooks)]);
    checks.push([`hop ${i + 1} poolManager`, sameAddress(status.path[i].poolManager, expected.path[i].poolManager)]);
    checks.push([`hop ${i + 1} parameters`, status.path[i].parameters.toLowerCase() === expected.path[i].parameters.toLowerCase()]);
  }

  console.log("\nFinal checks:");
  let ok = true;
  for (const [label, pass] of checks) {
    console.log(`  ${pass ? "OK" : "FAIL"} ${label}`);
    ok = ok && pass;
  }
  return ok;
}

async function main() {
  const [signer] = await ethers.getSigners();
  await requireMainnet();

  const validateOnly = envBool("VALIDATE_ONLY", false);
  const dryRun = envBool("DRY_RUN", false);
  const skipUpgrade = envBool("SKIP_UPGRADE", false);
  const skipConfigure = envBool("SKIP_CONFIGURE", false);
  const forceUpgrade = envBool("FORCE_UPGRADE", false);

  const poolAddress = requireAddress("ARVO_WEEKLY_POOL_ADDRESS");
  const router = requireAddress("PANCAKE_INFINITY_ROUTER_ADDRESS");
  const permit2 = requireAddress("PANCAKE_PERMIT2_ADDRESS");
  const amountOutMinimum = parseUint128Env("PANCAKE_INFINITY_AMOUNT_OUT_MIN", "0");
  const enabled = envBool("ENABLE_PANCAKE_INFINITY_BUY", true);

  const pool = await ethers.getContractAt("ARVOWeeklyPool", poolAddress);
  const usdtAddress = ethers.getAddress(await pool.usdt());
  const orbdAddress = ethers.getAddress(await pool.orbd());
  const path = parseInfinityPath(orbdAddress);
  const PoolFactory = await ethers.getContractFactory("ARVOWeeklyPool");

  console.log("Network:", network.name);
  console.log("Signer:", signer.address);
  console.log("Pool proxy:", poolAddress);
  console.log("USDT:", usdtAddress);
  console.log("ORBD:", orbdAddress);
  console.log("Router:", router);
  console.log("Permit2:", permit2);
  console.log("Enabled:", enabled);
  console.log("Amount out minimum:", amountOutMinimum.toString());
  console.log("Infinity path:");
  printPath(path);

  await requireCode("ARVOWeeklyPool proxy", poolAddress);
  await validateInfinityInfra(router, permit2, path);
  await assertPoolAdmin(pool, signer);

  console.log("\nValidating UUPS upgrade storage layout...");
  await upgrades.validateUpgrade(poolAddress, PoolFactory, { kind: "uups" });
  console.log("Storage layout: compatible");

  if (validateOnly) {
    console.log("\nVALIDATE_ONLY=true, no transactions sent.");
    return;
  }

  let activePool = pool;
  let status = await readInfinityStatus(activePool);
  const mustUpgrade = !skipUpgrade && (forceUpgrade || !status.available);

  if (mustUpgrade) {
    if (dryRun) {
      console.log("\nDRY_RUN=true: upgrade is required but no transaction was sent.");
      console.log("Run without DRY_RUN to upgrade the pool proxy.");
      return;
    }

    console.log("\nUpgrading ARVOWeeklyPool proxy...");
    activePool = await upgrades.upgradeProxy(poolAddress, PoolFactory, { kind: "uups" });
    await activePool.waitForDeployment();
    console.log("Pool upgraded.");
    console.log("Implementation:", await upgrades.erc1967.getImplementationAddress(poolAddress));
    activePool = await waitForInfinityInterface(poolAddress);
  } else {
    console.log("\nUpgrade skipped:", skipUpgrade ? "SKIP_UPGRADE=true" : "Infinity functions already available");
    activePool = await waitForInfinityInterface(poolAddress);
  }

  if (!skipConfigure) {
    if (dryRun) {
      const gas = await activePool.configurePancakeInfinitySwap.estimateGas(
        router,
        permit2,
        path,
        amountOutMinimum,
        enabled
      );
      console.log(`\nDRY_RUN configurePancakeInfinitySwap gas=${gas}`);
      return;
    }

    console.log("\nConfiguring Pancake Infinity route...");
    const tx = await activePool.configurePancakeInfinitySwap(router, permit2, path, amountOutMinimum, enabled);
    console.log("configurePancakeInfinitySwap tx:", tx.hash);
    await tx.wait(2);
    console.log("Pancake Infinity configured.");
  } else {
    console.log("\nConfigure skipped: SKIP_CONFIGURE=true");
  }

  status = await readInfinityStatus(activePool);
  console.log("\nLive Pancake Infinity config:");
  console.log("  available:", status.available);
  if (status.available) {
    console.log("  enabled:", status.enabled);
    console.log("  router:", status.router);
    console.log("  permit2:", status.permit2);
    console.log("  amountOutMinimum:", status.amountOutMinimum.toString());
    printPath(status.path);
  }

  const ok = verifyStatus(status, { router, permit2, amountOutMinimum, enabled, path });
  console.log("\nStatus:", ok ? "READY" : "NOT READY");
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

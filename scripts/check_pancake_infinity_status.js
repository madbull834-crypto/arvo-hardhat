/**
 * Read ARVOWeeklyPool Pancake Infinity configuration from the selected network.
 *
 * Run:
 *   npm run check:pancakeInfinity:bscMainnet
 */
const { ethers, network, upgrades } = require("hardhat");

function requireAddress(name) {
  const value = process.env[name];
  if (!ethers.isAddress(value || "")) throw new Error(`${name} must be a valid address`);
  return ethers.getAddress(value);
}

function sameAddress(a, b) {
  return ethers.getAddress(a) === ethers.getAddress(b);
}

function expectedPath() {
  const raw = process.env.PANCAKE_INFINITY_CL_PATH || "";
  if (!raw) return [];

  return raw.split(";").map((hop) => {
    const [intermediateCurrency, fee, hooks, poolManager, parameters] = hop
      .split(",")
      .map((part) => part.trim());

    return {
      intermediateCurrency: ethers.getAddress(intermediateCurrency),
      fee: Number(fee),
      hooks: ethers.getAddress(hooks),
      poolManager: ethers.getAddress(poolManager),
      parameters,
    };
  });
}

async function main() {
  const poolAddress = requireAddress("ARVO_WEEKLY_POOL_ADDRESS");
  const expectedRouter = requireAddress("PANCAKE_INFINITY_ROUTER_ADDRESS");
  const expectedPermit2 = requireAddress("PANCAKE_PERMIT2_ADDRESS");
  const expectedAmountOutMinimum = BigInt(process.env.PANCAKE_INFINITY_AMOUNT_OUT_MIN || "0");
  const expectedEnabled = (process.env.ENABLE_PANCAKE_INFINITY_BUY || "true").toLowerCase() === "true";
  const wantedPath = expectedPath();

  const pool = await ethers.getContractAt("ARVOWeeklyPool", poolAddress);
  const implementation = await upgrades.erc1967.getImplementationAddress(poolAddress);

  console.log("Network:", network.name);
  console.log("Pool proxy:", poolAddress);
  console.log("Pool implementation:", implementation);

  let enabled;
  let router;
  let permit2;
  let amountOutMinimum;
  let path;

  try {
    enabled = await pool.pancakeInfinitySwapEnabled();
    router = await pool.pancakeInfinityRouter();
    permit2 = await pool.pancakePermit2();
    amountOutMinimum = await pool.pancakeInfinityAmountOutMinimum();
    path = await pool.getPancakeInfinityPath();
  } catch (error) {
    console.log("\nStatus: NOT READY");
    console.log("The deployed pool does not expose Pancake Infinity functions.");
    console.log("Run first: npm run validate:pool:bscMainnet && npm run upgrade:pool:bscMainnet");
    console.log("Error:", error.shortMessage || error.message);
    process.exitCode = 1;
    return;
  }

  console.log("\nLive Pancake Infinity config:");
  console.log("  enabled:", enabled);
  console.log("  router:", router);
  console.log("  permit2:", permit2);
  console.log("  amountOutMinimum:", amountOutMinimum.toString());
  console.log("  path hops:", path.length);
  path.forEach((hop, index) => {
    console.log(
      `  hop ${index + 1}: intermediate=${hop.intermediateCurrency} fee=${hop.fee} hooks=${hop.hooks} manager=${hop.poolManager} parameters=${hop.parameters}`
    );
  });

  const checks = [
    ["enabled", enabled === expectedEnabled],
    ["router", sameAddress(router, expectedRouter)],
    ["permit2", sameAddress(permit2, expectedPermit2)],
    ["amountOutMinimum", amountOutMinimum === expectedAmountOutMinimum],
    ["path length", path.length === wantedPath.length],
  ];

  for (let i = 0; i < Math.min(path.length, wantedPath.length); i++) {
    checks.push([`hop ${i + 1} intermediate`, sameAddress(path[i].intermediateCurrency, wantedPath[i].intermediateCurrency)]);
    checks.push([`hop ${i + 1} fee`, Number(path[i].fee) === wantedPath[i].fee]);
    checks.push([`hop ${i + 1} hooks`, sameAddress(path[i].hooks, wantedPath[i].hooks)]);
    checks.push([`hop ${i + 1} poolManager`, sameAddress(path[i].poolManager, wantedPath[i].poolManager)]);
    checks.push([`hop ${i + 1} parameters`, path[i].parameters.toLowerCase() === wantedPath[i].parameters.toLowerCase()]);
  }

  console.log("\nChecks:");
  let ok = true;
  for (const [label, pass] of checks) {
    console.log(`  ${pass ? "OK" : "FAIL"} ${label}`);
    ok = ok && pass;
  }

  console.log("\nStatus:", ok ? "READY" : "CONFIG MISMATCH");
  if (!ok) {
    console.log("Run: npm run configure:pancakeInfinity:bscMainnet");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

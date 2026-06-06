/**
 * Configure ARVOWeeklyPool to buy ORBD through PancakeSwap Infinity / v4 CL pools.
 *
 * Required .env:
 *   ARVO_WEEKLY_POOL_ADDRESS
 *   PANCAKE_INFINITY_ROUTER_ADDRESS
 *   PANCAKE_PERMIT2_ADDRESS
 *   PANCAKE_INFINITY_CL_PATH
 *
 * PANCAKE_INFINITY_CL_PATH format:
 *   intermediateCurrency,fee,hooks,poolManager,parameters;intermediateCurrency,fee,hooks,poolManager,parameters
 *
 * Example for USDT -> native BNB -> ORBD:
 *   PANCAKE_INFINITY_CL_PATH=0x0000000000000000000000000000000000000000,3355,0x0000000000000000000000000000000000000000,0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b,0x000...;0x4E24C684a90f2c1f9030a5608A6c3A6fa4E854f5,3355,0x0000000000000000000000000000000000000000,0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b,0x000...
 *
 * Optional .env:
 *   PANCAKE_INFINITY_AMOUNT_OUT_MIN=0
 *   ENABLE_PANCAKE_INFINITY_BUY=true
 *   ORBD_PER_USDT_RATE=100  // fallback mint rate only; buy mode distributes actual Pancake output
 *   DRY_RUN=true
 */
const { ethers, network } = require("hardhat");

function requireAddress(name) {
  const value = process.env[name];
  if (!ethers.isAddress(value || "")) throw new Error(`${name} must be a valid address`);
  return value;
}

function optionalBool(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes"].includes(value.toLowerCase());
}

function parseUint128(name, fallback = "0") {
  const raw = process.env[name] || fallback;
  const value = BigInt(raw);
  if (value < 0n || value > (1n << 128n) - 1n) {
    throw new Error(`${name} must fit in uint128`);
  }
  return value;
}

function parseInfinityPath() {
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
      intermediateCurrency,
      fee,
      hooks,
      poolManager,
      hookData: "0x",
      parameters,
    };
  });

  if (!hops.length) throw new Error("PANCAKE_INFINITY_CL_PATH must include at least one hop");
  return hops;
}

async function main() {
  const [signer] = await ethers.getSigners();
  const poolAddress = requireAddress("ARVO_WEEKLY_POOL_ADDRESS");
  const router = requireAddress("PANCAKE_INFINITY_ROUTER_ADDRESS");
  const permit2 = requireAddress("PANCAKE_PERMIT2_ADDRESS");
  const path = parseInfinityPath();
  const amountOutMinimum = parseUint128("PANCAKE_INFINITY_AMOUNT_OUT_MIN", "0");
  const enabled = optionalBool("ENABLE_PANCAKE_INFINITY_BUY", true);
  const dryRun = optionalBool("DRY_RUN", false);

  const pool = await ethers.getContractAt("ARVOWeeklyPool", poolAddress);

  console.log("Network:", network.name);
  console.log("Signer:", signer.address);
  console.log("Pool:", poolAddress);
  console.log("Universal Router:", router);
  console.log("Permit2:", permit2);
  console.log("Infinity enabled:", enabled);
  console.log("Infinity amountOutMinimum:", amountOutMinimum.toString());
  console.log("Infinity hops:", path.length);

  const rate = process.env.ORBD_PER_USDT_RATE;
  if (rate) {
    const rateRaw = ethers.parseUnits(rate, 18);
    if (dryRun) {
      const gas = await pool.setOrbdRate.estimateGas(rateRaw);
      console.log(`DRY_RUN setOrbdRate(${rateRaw}) gas=${gas}`);
    } else {
      const tx = await pool.setOrbdRate(rateRaw);
      console.log("setOrbdRate tx:", tx.hash);
      await tx.wait();
    }
  }

  if (dryRun) {
    const gas = await pool.configurePancakeInfinitySwap.estimateGas(router, permit2, path, amountOutMinimum, enabled);
    console.log(`DRY_RUN configurePancakeInfinitySwap gas=${gas}`);
    return;
  }

  const tx = await pool.configurePancakeInfinitySwap(router, permit2, path, amountOutMinimum, enabled);
  console.log("configurePancakeInfinitySwap tx:", tx.hash);
  await tx.wait();
  console.log("Pancake Infinity/v4 buy mode configured");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

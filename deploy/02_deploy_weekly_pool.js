// TODO: Set final pool weights before deployment — MISSING from PDF
// These are equal-weight placeholders summing to 10000
const PLACEHOLDER_WEIGHTS = [910, 909, 909, 909, 909, 909, 909, 909, 909, 909, 909];

module.exports = async ({ deployments, getNamedAccounts, network }) => {
  const { deploy, get } = deployments;
  const { deployer } = await getNamedAccounts();

  const usdtAddress = process.env.USDT_ADDRESS;
  if (!usdtAddress) throw new Error("USDT_ADDRESS not set in .env");

  // Resolved from step 1: existing address on mainnet, MockORBDToken on testnet/local
  const orbdDeployment = await get("ORBDToken");

  console.log(`[${network.name}] Deploying ARVOWeeklyPool...`);
  console.log("  USDT:", usdtAddress);
  console.log("  ORBD:", orbdDeployment.address);

  const result = await deploy("ARVOWeeklyPool", {
    from:    deployer,
    args:    [usdtAddress, orbdDeployment.address, PLACEHOLDER_WEIGHTS],
    log:     true,
    waitConfirmations: network.name === "hardhat" ? 1 : 5,
  });

  // ── Grant MINTER_ROLE ─────────────────────────────────────────────────────
  if (network.name === "bscMainnet") {
    // ORBD is already deployed on mainnet with its own admin.
    // MINTER_ROLE cannot be granted here automatically.
    // ACTION REQUIRED: the ORBD contract admin must run:
    //   ORBDToken.grantRole(MINTER_ROLE, <ARVOWeeklyPool address>)
    // ARVOWeeklyPool address: ${result.address}
    console.log("\n⚠  MAINNET ACTION REQUIRED:");
    console.log("   The ORBD contract admin must grant MINTER_ROLE to ARVOWeeklyPool.");
    console.log("   ARVOWeeklyPool:", result.address);
    console.log(
      "   Call: ORBDToken.grantRole(keccak256('MINTER_ROLE'),",
      result.address, ")\n"
    );
  } else {
    // Testnet / local: MockORBDToken has no role gate — MINTER_ROLE does not exist.
    // No grant needed; mint() is publicly callable.
    console.log(`[${network.name}] MockORBDToken used — no MINTER_ROLE grant required.`);
  }
};

module.exports.tags      = ["ARVOWeeklyPool", "all"];
module.exports.dependencies = ["ORBDToken"];

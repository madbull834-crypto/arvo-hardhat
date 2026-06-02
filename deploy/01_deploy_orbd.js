const addresses = require("../config/addresses");

/**
 * Mainnet:  ORBD is already live — register the existing address so downstream
 *           scripts can resolve it with deployments.get("ORBDToken").
 *
 * Testnet / local: Deploy MockORBDToken (no MINTER_ROLE required, freely mintable).
 *                  Saved under the canonical name "ORBDToken" for step 2.
 */
module.exports = async ({ deployments, getNamedAccounts, network }) => {
  const { deploy, save, getArtifact } = deployments;
  const { deployer } = await getNamedAccounts();

  // ── Mainnet: reuse already-deployed ORBD ──────────────────────────────────
  if (network.name === "bscMainnet") {
    const existingAddress = addresses.bscMainnet.orbd;
    if (!existingAddress) {
      throw new Error(
        "addresses.bscMainnet.orbd is empty. " +
        "Set the mainnet ORBD contract address in config/addresses.js before deploying."
      );
    }

    const artifact = await getArtifact("ORBDToken");
    await save("ORBDToken", { address: existingAddress, abi: artifact.abi });
    console.log("Mainnet: ORBDToken already deployed at", existingAddress, "— skipping deploy.");
    return;
  }

  // ── Testnet / local: deploy MockORBDToken ─────────────────────────────────
  console.log(`[${network.name}] Deploying MockORBDToken...`);

  const result = await deploy("MockORBDToken", {
    from:    deployer,
    args:    [],
    log:     true,
    waitConfirmations: network.name === "hardhat" ? 1 : 5,
  });

  // Register under canonical name so step 2 resolves it with get("ORBDToken")
  const artifact = await getArtifact("MockORBDToken");
  await save("ORBDToken", { address: result.address, abi: artifact.abi });

  console.log("MockORBDToken deployed at:", result.address, "(registered as ORBDToken)");
};

module.exports.tags = ["ORBDToken", "all"];

/**
 * Diagnose why ARVOMatrix.register(referrer) cannot estimate gas.
 *
 * Usage:
 *   REGISTER_REFERRER=0x... npx hardhat run scripts/diagnose_register.js --network sepolia
 */
const { ethers, network } = require("hardhat");

const USDT_DECIMALS = 18;
const JOIN_FEE = ethers.parseUnits("10", USDT_DECIMALS);

async function requireAddress(name, value) {
  if (!value || !ethers.isAddress(value)) {
    throw new Error(`${name} must be set to a valid address`);
  }

  const code = await ethers.provider.getCode(value);
  if (code === "0x") {
    throw new Error(`${name} (${value}) has no bytecode on ${network.name}`);
  }
}

async function main() {
  const {
    USDT_ADDRESS,
    ARVO_MATRIX_ADDRESS,
    GENESIS_ADDRESS,
    REGISTER_REFERRER,
  } = process.env;

  await requireAddress("USDT_ADDRESS", USDT_ADDRESS);
  await requireAddress("ARVO_MATRIX_ADDRESS", ARVO_MATRIX_ADDRESS);

  const [signer] = await ethers.getSigners();
  const referrer = REGISTER_REFERRER || GENESIS_ADDRESS;
  if (!referrer || !ethers.isAddress(referrer)) {
    throw new Error("Set REGISTER_REFERRER or GENESIS_ADDRESS to a valid referrer address");
  }

  const usdt = await ethers.getContractAt("MockUSDT", USDT_ADDRESS);
  const matrix = await ethers.getContractAt("ARVOMatrix", ARVO_MATRIX_ADDRESS);

  const callerInfo = await matrix.getUserInfo(signer.address);
  const referrerInfo = await matrix.getUserInfo(referrer);
  const balance = await usdt.balanceOf(signer.address);
  const allowance = await usdt.allowance(signer.address, ARVO_MATRIX_ADDRESS);
  const paused = await matrix.paused();

  console.log(`Network: ${network.name}`);
  console.log(`Caller: ${signer.address}`);
  console.log(`Referrer: ${referrer}`);
  console.log(`Matrix: ${ARVO_MATRIX_ADDRESS}`);
  console.log(`USDT: ${USDT_ADDRESS}`);
  console.log("");
  console.log(`paused=${paused}`);
  console.log(`callerRegistered=${callerInfo.isRegistered}`);
  console.log(`referrerRegistered=${referrerInfo.isRegistered}`);
  console.log(`callerUSDT=${ethers.formatUnits(balance, USDT_DECIMALS)}`);
  console.log(`matrixAllowance=${ethers.formatUnits(allowance, USDT_DECIMALS)}`);
  console.log(`requiredUSDT=${ethers.formatUnits(JOIN_FEE, USDT_DECIMALS)}`);

  if (paused) console.log("Issue: registration is paused.");
  if (callerInfo.isRegistered) console.log("Issue: caller is already registered.");
  if (!referrerInfo.isRegistered) console.log("Issue: referrer is not registered.");
  if (balance < JOIN_FEE) console.log("Issue: caller does not have enough USDT.");
  if (allowance < JOIN_FEE) {
    console.log("Issue: caller has not approved enough USDT to ARVOMatrix.");
    console.log(`Fix: call USDT.approve(${ARVO_MATRIX_ADDRESS}, ${JOIN_FEE.toString()}) first.`);
  }

  try {
    const gas = await matrix.register.estimateGas(referrer);
    console.log(`estimateGas=${gas.toString()}`);
  } catch (error) {
    console.log(`estimateGas failed: ${error.shortMessage || error.message}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

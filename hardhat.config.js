require("./tasks/arvo");
require("@nomicfoundation/hardhat-toolbox");
require("@openzeppelin/hardhat-upgrades");
require("hardhat-gas-reporter");
require("solidity-coverage");
require("dotenv").config();
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");
const solc = require("solc");

const RAW_PRIVATE_KEY = (process.env.PRIVATE_KEY || "0x" + "0".repeat(64)).trim();
const PRIVATE_KEY = RAW_PRIVATE_KEY.startsWith("0x")
  ? RAW_PRIVATE_KEY
  : `0x${RAW_PRIVATE_KEY}`;
const BSC_TESTNET_RPC = process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545/";
const BSC_MAINNET_RPC = process.env.BSC_MAINNET_RPC || "https://bsc-dataseed.binance.org/";
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL || "";
const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY || "";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";
const EXPLORER_API_KEY = process.env.ETHERSCAN_API_KEY || process.env.BSCSCAN_API_KEY || "";
const LOCAL_SOLC_VERSION = solc.version();
const ETHERSCAN_SOLC_VERSION = LOCAL_SOLC_VERSION.replace(/\.Emscripten\.clang$/, "");

subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(
  async ({ solcVersion }, _hre, runSuper) => {
    if (LOCAL_SOLC_VERSION.startsWith(`${solcVersion}+`)) {
      return {
        compilerPath: require.resolve("solc/soljson.js"),
        isSolcJs: true,
        version: solcVersion,
        longVersion: ETHERSCAN_SOLC_VERSION,
      };
    }

    return runSuper();
  }
);

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.22",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: false,
    },
  },

  networks: {
    // Local development
    hardhat: {
      chainId: 31337,
      allowUnlimitedContractSize: false,
      gas: 12000000,
      blockGasLimit: 12000000,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },

    // BSC Testnet
    bscTestnet: {
      url: BSC_TESTNET_RPC,
      chainId: 97,
      accounts: [PRIVATE_KEY],
      gasPrice: 10000000000, // 10 gwei
    },

    // BSC Mainnet
    bscMainnet: {
      url: BSC_MAINNET_RPC,
      chainId: 56,
      accounts: [PRIVATE_KEY],
      gasPrice: 5000000000, // 5 gwei
    },

    // Ethereum Sepolia Testnet
    sepolia: {
      url: SEPOLIA_RPC_URL,
      chainId: 11155111,
      accounts: [PRIVATE_KEY],
    },
  },

  etherscan: {
    apiKey: EXPLORER_API_KEY,
    customChains: [
      {
        network: "bscMainnet",
        chainId: 56,
        urls: {
          apiURL:    "https://api.bscscan.com/api",
          browserURL:"https://bscscan.com",
        },
      },
      {
        network: "bscTestnet",
        chainId: 97,
        urls: {
          apiURL:    "https://api-testnet.bscscan.com/api",
          browserURL:"https://testnet.bscscan.com",
        },
      },
    ],
  },

  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    token: "BNB",
    gasPriceApi: "https://api.bscscan.com/api?module=proxy&action=eth_gasPrice",
    outputFile: "gas-report.txt",
    noColors: true,
  },

  paths: {
    sources:  "./contracts",
    tests:    "./test",
    cache:    "./cache",
    artifacts:"./artifacts",
  },

  mocha: {
    timeout: 120000,
  },
};

const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { ethers } = require("hardhat");
const { deployAll } = require("../helpers/fixtures");

describe("ARVOWeeklyPool", function () {
  let usdt, orbd, matrix, weeklyPool, deployer, genesis, users;

  beforeEach(async function () {
    ({ usdt, orbd, matrix, weeklyPool, deployer, genesis, users } = await deployAll());
  });

  async function seedQualifiedPool() {
    await matrix.connect(users[0]).register(genesis.address);
    await matrix.connect(users[1]).register(genesis.address);
  }

  it("prevents all-pool distribution before the weekly interval completes", async function () {
    await seedQualifiedPool();

    await expect(
      weeklyPool.distributeAllPools()
    ).to.be.revertedWithCustomError(weeklyPool, "DistributionTooSoon");
  });

  it("allows all-pool distribution after the weekly interval completes", async function () {
    await seedQualifiedPool();
    await time.increase(await weeklyPool.DISTRIBUTION_INTERVAL());

    await expect(weeklyPool.distributeAllPools()).to.not.be.reverted;
  });

  it("prevents single-pool distribution before that pool's weekly interval completes", async function () {
    await seedQualifiedPool();

    await expect(
      weeklyPool.distributeWeekly(0)
    ).to.be.revertedWithCustomError(weeklyPool, "DistributionTooSoon");
  });

  describe("PancakeSwap ORBD/USDT TWAP oracle", function () {
    async function deployPair({ usdtIsToken0 = true } = {}) {
      const Pair = await ethers.getContractFactory("MockPancakeV2Pair");
      const usdtAddress = await usdt.getAddress();
      const orbdAddress = await orbd.getAddress();
      const pair = await Pair.deploy(
        usdtIsToken0 ? usdtAddress : orbdAddress,
        usdtIsToken0 ? orbdAddress : usdtAddress
      );
      await pair.waitForDeployment();

      if (usdtIsToken0) {
        await pair.setReserves(ethers.parseUnits("1000", 18), ethers.parseUnits("2000", 18));
      } else {
        await pair.setReserves(ethers.parseUnits("2000", 18), ethers.parseUnits("1000", 18));
      }

      return pair;
    }

    async function configurePair(pair) {
      await weeklyPool.configurePancakeOracle(
        await pair.getAddress(),
        3600,
        9000,
        0
      );
      await time.increase(3600);
    }

    it("rejects a pair that is not ORBD/USDT", async function () {
      const MockUSDT = await ethers.getContractFactory("MockUSDT");
      const other = await MockUSDT.deploy();
      const Pair = await ethers.getContractFactory("MockPancakeV2Pair");
      const pair = await Pair.deploy(await usdt.getAddress(), await other.getAddress());
      await pair.setReserves(ethers.parseUnits("1000", 18), ethers.parseUnits("1000", 18));

      await expect(
        weeklyPool.configurePancakeOracle(await pair.getAddress(), 3600, 9000, 0)
      ).to.be.revertedWithCustomError(weeklyPool, "InvalidPair");
    });

    it("updates ORBD per USDT from a USDT-token0 pair TWAP", async function () {
      const pair = await deployPair({ usdtIsToken0: true });
      await configurePair(pair);

      await expect(weeklyPool.updateOrbdRateFromPancake())
        .to.emit(weeklyPool, "PancakeOracleUpdated");

      expect(await weeklyPool.orbdPerUsdtRate()).to.equal(ethers.parseUnits("2", 18));
    });

    it("updates ORBD per USDT from an ORBD-token0 pair TWAP", async function () {
      const pair = await deployPair({ usdtIsToken0: false });
      await configurePair(pair);

      await weeklyPool.updateOrbdRateFromPancake();

      expect(await weeklyPool.orbdPerUsdtRate()).to.equal(ethers.parseUnits("2", 18));
    });

    it("prevents oracle updates before the minimum TWAP interval", async function () {
      const pair = await deployPair();
      await weeklyPool.configurePancakeOracle(await pair.getAddress(), 3600, 9000, 0);

      await expect(
        weeklyPool.updateOrbdRateFromPancake()
      ).to.be.revertedWithCustomError(weeklyPool, "OracleTooSoon");
    });

    it("blocks distribution when the enabled oracle has not produced a fresh rate", async function () {
      const pair = await deployPair();
      await weeklyPool.configurePancakeOracle(
        await pair.getAddress(),
        8 * 24 * 3600,
        9 * 24 * 3600,
        0
      );
      await seedQualifiedPool();
      await time.increase(await weeklyPool.DISTRIBUTION_INTERVAL());

      await expect(
        weeklyPool.distributeAllPools()
      ).to.be.revertedWithCustomError(weeklyPool, "OracleStale");
    });

    it("auto-refreshes the Pancake rate during weekly distribution", async function () {
      const pair = await deployPair();
      await weeklyPool.configurePancakeOracle(await pair.getAddress(), 3600, 9 * 24 * 3600, 0);
      await seedQualifiedPool();
      await time.increase(await weeklyPool.DISTRIBUTION_INTERVAL());

      await expect(weeklyPool.distributeAllPools()).to.not.be.reverted;
      expect(await weeklyPool.orbdPerUsdtRate()).to.equal(ethers.parseUnits("2", 18));
    });
  });
});

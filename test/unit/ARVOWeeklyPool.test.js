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

  it("buys ORBD on contribution and distributes purchased ORBD weekly", async function () {
    const Router = await ethers.getContractFactory("MockPancakeV2Router");
    const router = await Router.deploy();
    await router.waitForDeployment();

    const minterRole = await orbd.MINTER_ROLE();
    await orbd.connect(deployer).grantRole(minterRole, deployer.address);
    await orbd.mint(await router.getAddress(), ethers.parseUnits("1000", 18));

    await weeklyPool.configurePancakeSwap(
      await router.getAddress(),
      [await usdt.getAddress(), await orbd.getAddress()],
      9500,
      true
    );

    await seedQualifiedPool();

    const pool0 = await weeklyPool.getPoolTokenStats(0);
    expect(pool0.accumulatedUsdt).to.equal(ethers.parseUnits("0.364", 18));
    expect(pool0.accumulatedOrbd).to.equal(ethers.parseUnits("0.364", 18) * 2n);

    const before = await orbd.balanceOf(genesis.address);
    await time.increase(await weeklyPool.DISTRIBUTION_INTERVAL());
    await weeklyPool.distributeWeekly(0);
    const after = await orbd.balanceOf(genesis.address);

    expect(after - before).to.equal(pool0.accumulatedOrbd);
    expect((await weeklyPool.getPoolTokenStats(0)).accumulatedOrbd).to.equal(0n);
  });

  it("uses the actual Pancake output even when the configured fallback rate is higher", async function () {
    const Router = await ethers.getContractFactory("MockPancakeV2Router");
    const router = await Router.deploy();
    await router.waitForDeployment();

    const minterRole = await orbd.MINTER_ROLE();
    await orbd.connect(deployer).grantRole(minterRole, deployer.address);
    await orbd.mint(await router.getAddress(), ethers.parseUnits("1000", 18));

    await router.setOrbdPerUsdtRate(ethers.parseUnits("2", 18));
    await weeklyPool.setOrbdRate(ethers.parseUnits("100", 18));
    await weeklyPool.configurePancakeSwap(
      await router.getAddress(),
      [await usdt.getAddress(), await orbd.getAddress()],
      9500,
      true
    );

    await seedQualifiedPool();

    const pool0 = await weeklyPool.getPoolTokenStats(0);
    expect(pool0.accumulatedUsdt).to.equal(ethers.parseUnits("0.364", 18));
    expect(pool0.accumulatedOrbd).to.equal(ethers.parseUnits("0.728", 18));
  });

  it("buys ORBD through Pancake Infinity CL route using Pancake output", async function () {
    const Permit2 = await ethers.getContractFactory("MockPermit2");
    const permit2 = await Permit2.deploy();
    await permit2.waitForDeployment();

    const Router = await ethers.getContractFactory("MockPancakeInfinityUniversalRouter");
    const router = await Router.deploy();
    await router.waitForDeployment();

    const minterRole = await orbd.MINTER_ROLE();
    await orbd.connect(deployer).grantRole(minterRole, deployer.address);
    await orbd.mint(await router.getAddress(), ethers.parseUnits("1000", 18));

    await router.setOrbdPerUsdtRate(ethers.parseUnits("2.25", 18));
    await weeklyPool.setOrbdRate(ethers.parseUnits("100", 18));

    const nativeBnb = ethers.ZeroAddress;
    const poolManager = "0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b";
    const hooks = ethers.ZeroAddress;
    const parameters = "0x0000000000000000000000000000000000000000000000000000000000010000";
    await weeklyPool.configurePancakeInfinitySwap(
      await router.getAddress(),
      await permit2.getAddress(),
      [
        {
          intermediateCurrency: nativeBnb,
          fee: 3355,
          hooks,
          poolManager,
          hookData: "0x",
          parameters,
        },
        {
          intermediateCurrency: await orbd.getAddress(),
          fee: 3355,
          hooks,
          poolManager,
          hookData: "0x",
          parameters,
        },
      ],
      0,
      true
    );

    await seedQualifiedPool();

    const pool0 = await weeklyPool.getPoolTokenStats(0);
    expect(pool0.accumulatedUsdt).to.equal(ethers.parseUnits("0.364", 18));
    expect(pool0.accumulatedOrbd).to.equal(ethers.parseUnits("0.819", 18));
    expect(await weeklyPool.pancakeInfinitySwapEnabled()).to.equal(true);
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

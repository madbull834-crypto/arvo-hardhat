const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployAll } = require("../helpers/fixtures");

describe("ARVOWeeklyPool", function () {
  let matrix, weeklyPool, genesis, users;

  beforeEach(async function () {
    ({ matrix, weeklyPool, genesis, users } = await deployAll());
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
});

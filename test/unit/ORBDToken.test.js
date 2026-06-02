const { expect }       = require("chai");
const { ethers }       = require("hardhat");
const { deployAll, ORBD_CAP } = require("../helpers/fixtures");

describe("ORBDToken", function () {
  let orbd, weeklyPool, deployer, users;

  beforeEach(async function () {
    ({ orbd, weeklyPool, deployer, users } = await deployAll());
  });

  describe("Deployment", function () {
    it("has correct name and symbol", async function () {
      expect(await orbd.name()).to.equal("ORBD Coin");
      expect(await orbd.symbol()).to.equal("ORBD");
    });

    it("starts with zero supply", async function () {
      expect(await orbd.totalSupply()).to.equal(0n);
    });

    it("deployer holds DEFAULT_ADMIN_ROLE", async function () {
      const role = await orbd.DEFAULT_ADMIN_ROLE();
      expect(await orbd.hasRole(role, deployer.address)).to.be.true;
    });

    it("ARVOWeeklyPool holds MINTER_ROLE", async function () {
      const role = await orbd.MINTER_ROLE();
      expect(await orbd.hasRole(role, await weeklyPool.getAddress())).to.be.true;
    });
  });

  describe("Minting", function () {
    it("ARVOWeeklyPool can mint to a user", async function () {
      const minterSigner = await ethers.getImpersonatedSigner(await weeklyPool.getAddress());
      await ethers.provider.send("hardhat_setBalance", [
        await weeklyPool.getAddress(), "0x56BC75E2D63100000"
      ]);
      const amount = ethers.parseUnits("100", 18);
      await orbd.connect(minterSigner).mint(users[0].address, amount);
      expect(await orbd.balanceOf(users[0].address)).to.equal(amount);
    });

    it("non-minter cannot mint", async function () {
      const amount = ethers.parseUnits("100", 18);
      await expect(
        orbd.connect(users[0]).mint(users[1].address, amount)
      ).to.be.reverted;
    });

    it("cannot mint beyond max supply", async function () {
      const minterSigner = await ethers.getImpersonatedSigner(await weeklyPool.getAddress());
      await ethers.provider.send("hardhat_setBalance", [
        await weeklyPool.getAddress(), "0x56BC75E2D63100000"
      ]);
      await expect(
        orbd.connect(minterSigner).mint(users[0].address, ORBD_CAP + 1n)
      ).to.be.reverted;
    });

    it("reverts on zero-address mint", async function () {
      const minterSigner = await ethers.getImpersonatedSigner(await weeklyPool.getAddress());
      await ethers.provider.send("hardhat_setBalance", [
        await weeklyPool.getAddress(), "0x56BC75E2D63100000"
      ]);
      await expect(
        orbd.connect(minterSigner).mint(ethers.ZeroAddress, 1n)
      ).to.be.revertedWithCustomError(orbd, "ZeroAddress");
    });
  });
});

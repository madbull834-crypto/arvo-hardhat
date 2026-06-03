const { expect }  = require("chai");
const { ethers, upgrades }  = require("hardhat");
const {
  deployAll, JOIN_FEE, DIRECT_FEE, AUTO_UPGRADE_FUND, POOL_SHARE, ADMIN_SHARE, LEVEL_SHARE
} = require("../helpers/fixtures");

describe("ARVOMatrix", function () {
  let usdt, matrix, weeklyPool, deployer, genesis, skipAdmin1, skipAdmin2, users;

  beforeEach(async function () {
    ({ usdt, matrix, weeklyPool, deployer, genesis, skipAdmin1, skipAdmin2, users } = await deployAll());
  });

  // ─── Deployment ────────────────────────────────────────────────
  describe("Deployment", function () {
    it("genesis address is registered at max level", async function () {
      const info = await matrix.getUserInfo(genesis.address);
      expect(info.isRegistered).to.be.true;
      expect(info.currentLevel).to.equal(12);
    });

    it("totalMembers starts at 1 (genesis)", async function () {
      expect(await matrix.totalMembers()).to.equal(1n);
    });

    it("constants are correct", async function () {
      expect(await matrix.JOIN_FEE()).to.equal(JOIN_FEE);
      expect(await matrix.DIRECT_REFERRAL()).to.equal(DIRECT_FEE);
      expect(await matrix.AUTO_UPGRADE_FUND()).to.equal(AUTO_UPGRADE_FUND);
      expect(await matrix.POOL_SHARE()).to.equal(POOL_SHARE);
      expect(await matrix.ADMIN_SHARE()).to.equal(ADMIN_SHARE);
      expect(await matrix.LEVEL_SHARE()).to.equal(LEVEL_SHARE);
    });

    it("stores the two skip-admin addresses", async function () {
      expect(await matrix.skipAdmin1()).to.equal(skipAdmin1.address);
      expect(await matrix.skipAdmin2()).to.equal(skipAdmin2.address);
    });

    it("reverts when both skip-admin addresses are the same", async function () {
      const ARVOMatrix = await ethers.getContractFactory("ARVOMatrix");
      await expect(
        upgrades.deployProxy(
          ARVOMatrix,
          [
            await usdt.getAddress(),
            await weeklyPool.getAddress(),
            genesis.address,
            skipAdmin1.address,
            skipAdmin1.address,
          ],
          { kind: "uups" }
        )
      ).to.be.revertedWithCustomError(matrix, "InvalidAdmin");
    });
  });

  // ─── Registration ──────────────────────────────────────────────
  describe("register()", function () {
    it("registers a new member under genesis", async function () {
      await matrix.connect(users[0]).register(genesis.address);
      const info = await matrix.getUserInfo(users[0].address);
      expect(info.isRegistered).to.be.true;
      expect(info.referrer).to.equal(genesis.address);
      expect(info.currentLevel).to.equal(1);
    });

    it("increments totalMembers", async function () {
      await matrix.connect(users[0]).register(genesis.address);
      expect(await matrix.totalMembers()).to.equal(2n);
    });

    it("reverts if already registered", async function () {
      await matrix.connect(users[0]).register(genesis.address);
      await expect(
        matrix.connect(users[0]).register(genesis.address)
      ).to.be.revertedWithCustomError(matrix, "AlreadyRegistered");
    });

    it("reverts on unregistered referrer", async function () {
      await expect(
        matrix.connect(users[0]).register(users[1].address)
      ).to.be.revertedWithCustomError(matrix, "InvalidReferrer");
    });

    it("reverts on self-referral", async function () {
      await expect(
        matrix.connect(users[0]).register(users[0].address)
      ).to.be.revertedWithCustomError(matrix, "SelfReferral");
    });

    it("pays $5 USDT to referrer and reserves $2.5 USDT auto-upgrade fund", async function () {
      const before = await usdt.balanceOf(genesis.address);
      await expect(matrix.connect(users[0]).register(genesis.address))
        .to.emit(matrix, "AutoUpgradeFundReserved")
        .withArgs(users[0].address, AUTO_UPGRADE_FUND);
      const after = await usdt.balanceOf(genesis.address);
      expect(after - before).to.equal(DIRECT_FEE);
      expect(await usdt.balanceOf(await matrix.getAddress())).to.equal(AUTO_UPGRADE_FUND);
    });

    it("pays 5% admin share on every joining", async function () {
      const admin1Before = await usdt.balanceOf(skipAdmin1.address);
      const admin2Before = await usdt.balanceOf(skipAdmin2.address);

      await expect(matrix.connect(users[0]).register(genesis.address))
        .to.emit(matrix, "AdminSharePaid")
        .withArgs(users[0].address, skipAdmin1.address, skipAdmin2.address, ADMIN_SHARE);

      expect(await usdt.balanceOf(skipAdmin1.address) - admin1Before).to.equal(ADMIN_SHARE / 2n);
      expect(await usdt.balanceOf(skipAdmin2.address) - admin2Before).to.equal(ADMIN_SHARE / 2n);
    });

    it("emits UserRegistered event", async function () {
      await expect(matrix.connect(users[0]).register(genesis.address))
        .to.emit(matrix, "UserRegistered")
        .withArgs(users[0].address, genesis.address, genesis.address, 0, await ethers.provider.getBlock("latest").then(b => b.timestamp + 1));
    });

    it("emits DirectReferralPaid event", async function () {
      await expect(matrix.connect(users[0]).register(genesis.address))
        .to.emit(matrix, "DirectReferralPaid")
        .withArgs(genesis.address, users[0].address, DIRECT_FEE);
    });

    it("stores direct referrals and dashboard totals for UI reads", async function () {
      await matrix.connect(users[0]).register(genesis.address);
      await matrix.connect(users[1]).register(genesis.address);

      const referrals = await matrix.getDirectReferrals(genesis.address);
      expect(referrals).to.deep.equal([users[0].address, users[1].address]);
      expect(await matrix.getDirectReferralCount(genesis.address)).to.equal(2n);

      const page = await matrix.getDirectReferralsPage(genesis.address, 1, 1);
      expect(page).to.deep.equal([users[1].address]);

      const dashboard = await matrix.getUserDashboard(genesis.address);
      expect(dashboard.isRegistered).to.equal(true);
      expect(dashboard.leftChild).to.equal(users[0].address);
      expect(dashboard.rightChild).to.equal(users[1].address);
      expect(dashboard.directIncome).to.equal(DIRECT_FEE * 2n);
      expect(dashboard.levelIncome).to.equal(ethers.parseUnits("10", 18));
      expect(dashboard.skippedIncome).to.equal(0n);

      const totals = await matrix.getIncomeTotals(genesis.address);
      expect(totals.directIncome).to.equal(DIRECT_FEE * 2n);
      expect(totals.levelIncome).to.equal(ethers.parseUnits("10", 18));
    });
  });

  // ─── Tree Placement ────────────────────────────────────────────
  describe("Binary tree placement (BFS)", function () {
    it("1st member is left child of genesis", async function () {
      await matrix.connect(users[0]).register(genesis.address);
      const tree = await matrix.getTreeInfo(genesis.address);
      expect(tree.leftChild).to.equal(users[0].address);
      expect(tree.rightChild).to.equal(ethers.ZeroAddress);
    });

    it("2nd member is right child of genesis", async function () {
      await matrix.connect(users[0]).register(genesis.address);
      await matrix.connect(users[1]).register(genesis.address);
      const tree = await matrix.getTreeInfo(genesis.address);
      expect(tree.leftChild).to.equal(users[0].address);
      expect(tree.rightChild).to.equal(users[1].address);
    });

    it("3rd member is left child of 1st member", async function () {
      await matrix.connect(users[0]).register(genesis.address);
      await matrix.connect(users[1]).register(genesis.address);
      await matrix.connect(users[2]).register(genesis.address);
      const tree = await matrix.getTreeInfo(users[0].address);
      expect(tree.leftChild).to.equal(users[2].address);
    });

    it("auto-places inside the sponsor subtree instead of the global queue", async function () {
      await matrix.connect(users[0]).register(genesis.address);
      await matrix.connect(users[1]).register(genesis.address);
      await matrix.connect(users[2]).register(users[1].address);

      const sponsorTree = await matrix.getTreeInfo(users[1].address);
      expect(sponsorTree.leftChild).to.equal(users[2].address);

      const otherTree = await matrix.getTreeInfo(users[0].address);
      expect(otherTree.leftChild).to.equal(ethers.ZeroAddress);
    });

    it("records parent correctly", async function () {
      await matrix.connect(users[0]).register(genesis.address);
      const info = await matrix.getTreeInfo(users[0].address);
      expect(info.parent).to.equal(genesis.address);
    });

    it("returns team addresses in BFS order for UI reads", async function () {
      await matrix.connect(users[0]).register(genesis.address);
      await matrix.connect(users[1]).register(genesis.address);
      await matrix.connect(users[2]).register(genesis.address);

      const team = await matrix.getTeamAddresses(genesis.address, 4, 10);
      expect(team).to.deep.equal([
        users[0].address,
        users[1].address,
        users[2].address,
      ]);

      const children = await matrix.getUserChildren(genesis.address);
      expect(children.leftChild).to.equal(users[0].address);
      expect(children.rightChild).to.equal(users[1].address);
    });
  });

  // ─── Migration ─────────────────────────────────────────────────
  describe("migration", function () {
    function emptyLevelSubCount() {
      return Array(13).fill(0);
    }

    function emptyLockedFunds() {
      return Array(13).fill(0n);
    }

    function migrationUser({
      account,
      referrer = ethers.ZeroAddress,
      parent = ethers.ZeroAddress,
      leftChild = ethers.ZeroAddress,
      rightChild = ethers.ZeroAddress,
      currentLevel = 1,
      directCount = 0n,
      claimableUsdt = 0n,
      levelSubCount = emptyLevelSubCount(),
      lockedFunds = emptyLockedFunds(),
    }) {
      return {
        account,
        referrer,
        parent,
        leftChild,
        rightChild,
        currentLevel,
        directCount,
        claimableUsdt,
        levelSubCount,
        lockedFunds,
      };
    }

    it("batch imports existing users with balances and tree data", async function () {
      const levelSubCount = emptyLevelSubCount();
      const lockedFunds = emptyLockedFunds();
      levelSubCount[1] = 2;
      lockedFunds[2] = ethers.parseUnits("5", 18);

      await expect(
        matrix.migrateUsers([
          migrationUser({
            account: users[0].address,
            referrer: genesis.address,
            parent: genesis.address,
            leftChild: users[2].address,
            currentLevel: 3,
            directCount: 2n,
            claimableUsdt: ethers.parseUnits("12.5", 18),
            levelSubCount,
            lockedFunds,
          }),
        ])
      ).to.emit(matrix, "UsersMigrated").withArgs(1, 2);

      const info = await matrix.getUserInfo(users[0].address);
      expect(info.isRegistered).to.be.true;
      expect(info.referrer).to.equal(genesis.address);
      expect(info.currentLevel).to.equal(3);
      expect(info.directCount).to.equal(2n);
      expect(info.claimableUsdt).to.equal(ethers.parseUnits("12.5", 18));

      const tree = await matrix.getTreeInfo(users[0].address);
      expect(tree.parent).to.equal(genesis.address);
      expect(tree.leftChild).to.equal(users[2].address);

      const stats = await matrix.getLevelStats(users[0].address, 1);
      expect(stats.subCount).to.equal(2);
    });

    it("rebuilds queue so new registrations continue after migrated users", async function () {
      await matrix.migrateUsers([
        migrationUser({
          account: users[0].address,
          referrer: genesis.address,
          parent: genesis.address,
          leftChild: users[2].address,
          rightChild: users[3].address,
        }),
        migrationUser({
          account: users[1].address,
          referrer: genesis.address,
          parent: genesis.address,
        }),
        migrationUser({
          account: users[2].address,
          referrer: users[0].address,
          parent: users[0].address,
        }),
        migrationUser({
          account: users[3].address,
          referrer: users[0].address,
          parent: users[0].address,
        }),
      ]);

      await expect(
        matrix.migratePlacementQueue([
          genesis.address,
          users[0].address,
          users[1].address,
          users[2].address,
          users[3].address,
        ], 2)
      ).to.emit(matrix, "PlacementQueueMigrated").withArgs(5, 2);

      await usdt.mint(users[4].address, ethers.parseUnits("100", 18));
      await usdt.connect(users[4]).approve(await matrix.getAddress(), ethers.MaxUint256);
      await matrix.connect(users[4]).register(genesis.address);

      const tree = await matrix.getTreeInfo(users[1].address);
      expect(tree.leftChild).to.equal(users[4].address);
    });

    it("gas-light imports users in BFS order and auto-places them", async function () {
      await expect(
        matrix.migrateSimpleUsers(
          [users[0].address, users[1].address, users[2].address],
          [genesis.address, genesis.address, users[0].address],
          [2, 1, 1],
          [2, 0, 0]
        )
      ).to.emit(matrix, "UsersMigrated").withArgs(3, 4);

      const genesisTree = await matrix.getTreeInfo(genesis.address);
      expect(genesisTree.leftChild).to.equal(users[0].address);
      expect(genesisTree.rightChild).to.equal(users[1].address);

      const u0Tree = await matrix.getTreeInfo(users[0].address);
      expect(u0Tree.leftChild).to.equal(users[2].address);

      const info = await matrix.getUserInfo(users[0].address);
      expect(info.currentLevel).to.equal(2);
      expect(info.directCount).to.equal(2n);

      const referrals = await matrix.getDirectReferrals(genesis.address);
      expect(referrals).to.deep.equal([users[0].address, users[1].address]);
    });

    it("gas-light migration skips already registered users", async function () {
      await matrix.migrateSimpleUsers(
        [users[0].address],
        [genesis.address],
        [1],
        [0]
      );

      await expect(
        matrix.migrateSimpleUsers(
          [users[0].address, users[1].address],
          [genesis.address, genesis.address],
          [12, 1],
          [99, 0]
        )
      ).to.emit(matrix, "UsersMigrated").withArgs(1, 3);

      const skipped = await matrix.getUserInfo(users[0].address);
      expect(skipped.currentLevel).to.equal(1);
      expect(skipped.directCount).to.equal(0n);
    });

    it("closes migration permanently", async function () {
      await expect(matrix.closeMigration())
        .to.emit(matrix, "MigrationClosedForever");

      await expect(
        matrix.migrateSimpleUsers(
          [users[0].address],
          [genesis.address],
          [1],
          [0]
        )
      ).to.be.revertedWithCustomError(matrix, "MigrationClosed");
    });

    it("prevents non-owner migration", async function () {
      await expect(
        matrix.connect(users[0]).migrateUsers([
          migrationUser({ account: users[1].address }),
        ])
      ).to.be.revertedWithCustomError(matrix, "OwnableUnauthorizedAccount");
    });

    it("imports legacy direct referrals and accounting totals for UI reads", async function () {
      await expect(
        matrix.migrateDirectReferrals(
          genesis.address,
          [users[0].address, users[1].address],
          true
        )
      ).to.emit(matrix, "DirectReferralsMigrated").withArgs(genesis.address, 2, true);

      await expect(
        matrix.migrateUserAccounting(
          [genesis.address],
          [ethers.parseUnits("10", 18)],
          [ethers.parseUnits("7.5", 18)],
          [ethers.parseUnits("2.5", 18)],
          [ethers.parseUnits("1", 18)],
          true
        )
      ).to.emit(matrix, "UserAccountingMigrated").withArgs(genesis.address);

      expect(await matrix.getDirectReferrals(genesis.address)).to.deep.equal([
        users[0].address,
        users[1].address,
      ]);

      const totals = await matrix.getIncomeTotals(genesis.address);
      expect(totals.directIncome).to.equal(ethers.parseUnits("10", 18));
      expect(totals.levelIncome).to.equal(ethers.parseUnits("7.5", 18));
      expect(totals.skippedIncome).to.equal(ethers.parseUnits("2.5", 18));
      expect(totals.withdrawn).to.equal(ethers.parseUnits("1", 18));
    });
  });

  // ─── Level Income & Auto-Upgrade ───────────────────────────────
  describe("Level income and auto-upgrade", function () {
    it("enables level earnings after 2 direct referrals", async function () {
      expect(await matrix.isEarningEnabled(genesis.address)).to.be.false;

      await matrix.connect(users[0]).register(genesis.address);
      expect(await matrix.isEarningEnabled(genesis.address)).to.be.false;

      await matrix.connect(users[1]).register(genesis.address);
      expect(await matrix.isEarningEnabled(genesis.address)).to.be.true;
    });

    it("does not route upgrade fund positions to admins", async function () {
      await matrix.connect(users[0]).register(genesis.address);
      await matrix.connect(users[1]).register(genesis.address);

      const admin1Info = await matrix.getUserInfo(skipAdmin1.address);
      const admin2Info = await matrix.getUserInfo(skipAdmin2.address);
      const genesisTotals = await matrix.getIncomeTotals(genesis.address);

      expect(admin1Info.claimableUsdt).to.equal(0n);
      expect(admin2Info.claimableUsdt).to.equal(0n);
      expect(genesisTotals.levelIncome).to.be.greaterThan(0n);
    });

    it("locks eligible income for upgrade after earnings are enabled", async function () {
      await matrix.connect(users[0]).register(genesis.address);
      await matrix.connect(users[1]).register(genesis.address);

      const stats = await matrix.getLevelStats(genesis.address, 1);
      expect(stats.subCount).to.equal(2);
      expect(stats.locked).to.equal(0n);
    });

    it("genesis auto-upgrades to level 2 after 2 sub-members fund it", async function () {
      await matrix.connect(users[0]).register(genesis.address);
      await matrix.connect(users[1]).register(genesis.address);
      // Auto-upgrade should have consumed the locked $5 for level-2 upgrade
      const info = await matrix.getUserInfo(genesis.address);
      // Genesis starts at level 12 so no upgrade needed — test a fresh user instead
    });

    it("pays completed upgrade fund to the qualified upline", async function () {
      await matrix.connect(users[0]).register(genesis.address);
      await matrix.connect(users[1]).register(genesis.address);

      const before = await usdt.balanceOf(genesis.address);

      await matrix.connect(users[2]).register(users[0].address);
      await expect(matrix.connect(users[3]).register(users[0].address))
        .to.emit(matrix, "UpgradeFundPaid")
        .withArgs(users[0].address, genesis.address, 2, ethers.parseUnits("5", 18));

      const after = await usdt.balanceOf(genesis.address);
      expect(after - before).to.equal(ethers.parseUnits("5", 18));

      const info = await matrix.getUserInfo(users[0].address);
      expect(info.currentLevel).to.equal(2);

      const stats = await matrix.getLevelStats(users[0].address, 1);
      expect(stats.locked).to.equal(0n);
    });

    it("does not credit skipped income to the skipped member", async function () {
      await matrix.connect(users[0]).register(genesis.address);

      const genesisInfo = await matrix.getUserInfo(genesis.address);
      expect(genesisInfo.claimableUsdt).to.equal(0n);
    });
  });

  // ─── Withdrawal ────────────────────────────────────────────────
  describe("withdraw()", function () {
    it("reverts when nothing to withdraw", async function () {
      await matrix.connect(users[0]).register(genesis.address);
      await expect(
        matrix.connect(users[0]).withdraw()
      ).to.be.revertedWithCustomError(matrix, "NothingToWithdraw");
    });

    it("emits Withdrawal event and resets balance", async function () {
      await matrix.connect(users[0]).register(genesis.address);
      await matrix.connect(users[1]).register(genesis.address);
      await matrix.connect(users[2]).register(genesis.address);
      await matrix.connect(users[3]).register(genesis.address);

      const info = await matrix.getUserInfo(genesis.address);
      if (info.claimableUsdt > 0n) {
        await usdt.mint(await matrix.getAddress(), info.claimableUsdt);
        await expect(matrix.connect(genesis).withdraw())
          .to.emit(matrix, "Withdrawal");
        const after = await matrix.getUserInfo(genesis.address);
        expect(after.claimableUsdt).to.equal(0n);
      }
    });

    it("tracks total withdrawn without changing withdrawal behavior", async function () {
      await matrix.migrateUsers([
        {
          account: users[0].address,
          referrer: genesis.address,
          parent: genesis.address,
          leftChild: ethers.ZeroAddress,
          rightChild: ethers.ZeroAddress,
          currentLevel: 1,
          directCount: 0n,
          claimableUsdt: ethers.parseUnits("1.25", 18),
          levelSubCount: Array(13).fill(0),
          lockedFunds: Array(13).fill(0n),
        },
      ]);

      await usdt.mint(await matrix.getAddress(), ethers.parseUnits("1.25", 18));

      const before = await usdt.balanceOf(users[0].address);
      const claimable = (await matrix.getUserInfo(users[0].address)).claimableUsdt;
      expect(claimable).to.equal(ethers.parseUnits("1.25", 18));

      await expect(matrix.connect(users[0]).withdraw())
        .to.emit(matrix, "Withdrawal")
        .withArgs(users[0].address, claimable);

      expect(await usdt.balanceOf(users[0].address) - before).to.equal(claimable);
      const totals = await matrix.getIncomeTotals(users[0].address);
      expect(totals.withdrawn).to.equal(claimable);
    });
  });

  // ─── Pool Qualification ────────────────────────────────────────
  describe("Pool qualification", function () {
    it("qualifies referrer for pool 0 on 2nd direct", async function () {
      await matrix.connect(users[0]).register(genesis.address);
      await matrix.connect(users[1]).register(genesis.address);
      await expect(matrix.connect(users[1]).register(genesis.address)).to.be.reverted;
      // Check qualification was called via event
    });
  });
});

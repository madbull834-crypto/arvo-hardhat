const { expect }  = require("chai");
const { ethers }  = require("hardhat");
const {
  deployAll, JOIN_FEE, DIRECT_FEE, POOL_SHARE
} = require("../helpers/fixtures");

describe("Integration: Full Registration Flow", function () {
  let usdt, orbd, weeklyPool, matrix, deployer, genesis, users;

  beforeEach(async function () {
    ({ usdt, orbd, weeklyPool, matrix, deployer, genesis, users } = await deployAll());
  });

  it("7-member BFS tree produces correct structure", async function () {
    // Register u0–u6 all under genesis as referrer
    for (let i = 0; i < 7; i++) {
      await matrix.connect(users[i]).register(genesis.address);
    }
    expect(await matrix.totalMembers()).to.equal(8n); // genesis + 7

    // Level 1 of tree: genesis.left = u0, genesis.right = u1
    const genesisTree = await matrix.getTreeInfo(genesis.address);
    expect(genesisTree.leftChild).to.equal(users[0].address);
    expect(genesisTree.rightChild).to.equal(users[1].address);

    // Level 2: u0.left=u2, u0.right=u3, u1.left=u4, u1.right=u5
    const u0tree = await matrix.getTreeInfo(users[0].address);
    const u1tree = await matrix.getTreeInfo(users[1].address);
    expect(u0tree.leftChild).to.equal(users[2].address);
    expect(u0tree.rightChild).to.equal(users[3].address);
    expect(u1tree.leftChild).to.equal(users[4].address);
    expect(u1tree.rightChild).to.equal(users[5].address);

    // Level 3: u2.left = u6
    const u2tree = await matrix.getTreeInfo(users[2].address);
    expect(u2tree.leftChild).to.equal(users[6].address);
  });

  it("USDT balance accounting is correct after multiple registrations", async function () {
    const initialContractBalance = await usdt.balanceOf(await matrix.getAddress());

    await matrix.connect(users[0]).register(genesis.address);
    await matrix.connect(users[1]).register(genesis.address);
    await matrix.connect(users[2]).register(genesis.address);

    // Each registration: $5 goes to referrer, $2 to pool, $3 stays in matrix
    const poolBal = await usdt.balanceOf(await weeklyPool.getAddress());
    expect(poolBal).to.equal(POOL_SHARE * 3n);
  });

  it("direct count increments correctly", async function () {
    await matrix.connect(users[0]).register(genesis.address);
    await matrix.connect(users[1]).register(genesis.address);
    await matrix.connect(users[2]).register(genesis.address);

    const info = await matrix.getUserInfo(genesis.address);
    expect(info.directCount).to.equal(3n);
  });

  it("pool receives contribution on every registration", async function () {
    for (let i = 0; i < 5; i++) {
      await matrix.connect(users[i]).register(genesis.address);
    }
    const poolBal = await usdt.balanceOf(await weeklyPool.getAddress());
    expect(poolBal).to.equal(POOL_SHARE * 5n);
    expect(await weeklyPool.totalContributed()).to.equal(POOL_SHARE * 5n);
  });
});

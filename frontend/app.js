const { ethers } = window.ethers;
const CONFIG = window.ARVO_CONFIG;

const MATRIX_ABI = [
  "function JOIN_FEE() view returns (uint256)",
  "function getUserInfo(address user) view returns (bool isRegistered,address referrer,uint8 currentLevel,uint256 directCount,uint256 claimableUsdt)",
  "function getTreeInfo(address user) view returns (address parent,address leftChild,address rightChild)",
  "function getLevelStats(address user,uint8 level) view returns (uint256 subCount,uint256 locked)",
  "function getIncomeTotals(address user) view returns (uint256 directIncome,uint256 levelIncome,uint256 skippedIncome,uint256 withdrawn)",
  "function getDirectReferrals(address user) view returns (address[])",
  "function getTeamAddresses(address root,uint256 maxDepth,uint256 maxMembers) view returns (address[])",
  "function totalMembers() view returns (uint256)",
  "function paused() view returns (bool)",
  "function register(address referrer)",
  "function withdraw()",
  "event UserRegistered(address indexed user,address indexed referrer,address indexed parent,uint8 side,uint256 timestamp)",
  "event DirectReferralPaid(address indexed referrer,address indexed from,uint256 amount)",
  "event LevelIncomePaid(address indexed beneficiary,address indexed from,uint8 level,uint256 amount,bool isWithdrawable)",
  "event Withdrawal(address indexed user,uint256 amount)"
];

const USDT_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

const POOL_ABI = [
  "function getPoolStats(uint8 poolId) view returns (uint256 accumulated,uint256 weight,uint256 target,uint256 memberCount)",
  "function getMemberStats(address member,uint8 poolId) view returns (bool active,uint256 totalReceived,uint256 remaining)",
  "function getPancakeOracleState() view returns (address pair,bool enabled,bool ready,uint256 rate,uint256 minInterval,uint256 maxAge,uint256 lastRateTimestamp)",
  "function previewOracleRate() view returns (uint256 rate,uint256 elapsed,bool canUpdate)"
];

const ORBD_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)"
];

const EVENT_LOOKBACK_BLOCKS = 250000;
const EVENT_CHUNK_BLOCKS = 25000;
// 18-decimal BSC USDT: $5 direct referral = 5 * 10^18
const DIRECT_REFERRAL_AMOUNT = 5_000_000_000_000_000_000n; // 5e18
const SESSION_KEY = "arvo.wallet.connected";
const ZERO = ethers.ZeroAddress;
const MAX_LEVEL = 12;
const POOL_COUNT = 11; // pools 0–10
const TEAM_MAX_DEPTH = 20;
const TEAM_MAX_MEMBERS = 1000;
const CONTRACT_TEAM_PAGE_SIZE = 200;

const state = {
  account: "",
  provider: null,
  signer: null,
  reader: null,
  matrix: null,
  usdt: null,
  pool: null,
  readMatrix: null,
  readUsdt: null,
  readPool: null,
  readOrbd: null,
  tab: "dashboard",
  selectedDownlineLevel: 0,
  status: "",
  statusType: "info",
  busy: false,
  loading: false,
  data: null,
  treeRoot: "",
  previewTree: null,
  previewRootInfo: null,
  previewMembers: [],
  initialized: false
};

const tabs = [
  ["dashboard", "Dashboard"],
  ["directs", "Directs"],
  ["team", "My Team"],
  ["community", "Community Info"],
  ["tree", "Tree"]
];

const ranks = Array.from({ length: MAX_LEVEL }, (_, index) => `Level ${index + 1}`);

const packages = [
  ["5 USDT", "Level 1"],
  ["10 USDT", "Level 2"],
  ["20 USDT", "Level 3"],
  ["40 USDT", "Level 4"],
  ["80 USDT", "Level 5"],
  ["160 USDT", "Level 6"],
  ["320 USDT", "Level 7"],
  ["640 USDT", "Level 8"],
  ["1280 USDT", "Level 9"],
  ["2560 USDT", "Level 10"],
  ["5120 USDT", "Level 11"],
  ["Max Level", "Level 12"]
];

const app = document.querySelector("#app");
const eventCache = new Map();

function sameAddress(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function copyText(value) {
  const text = String(value || "");
  if (!text) throw new Error("Nothing to copy.");

  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.left = "-9999px";
  input.style.top = "0";
  document.body.appendChild(input);
  input.focus();
  input.select();

  try {
    if (!document.execCommand("copy")) {
      throw new Error("Copy command failed.");
    }
  } finally {
    document.body.removeChild(input);
  }
}

function shortAddress(value) {
  if (!value || value === ZERO) return "-";
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

function explorerAddress(address) {
  return `${CONFIG.blockExplorerUrl}/address/${address}`;
}

function explorerTx(hash) {
  return `${CONFIG.blockExplorerUrl}/tx/${hash}`;
}

// USDT uses 18 decimals on BSC
function formatUnits(value, decimals = 18, maxDigits = 4) {
  const n = Number(ethers.formatUnits(value || 0n, decimals));
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: maxDigits });
}

function formatUsdt(value) {
  return formatUnits(value, 18, 4);
}

function formatOrbd(value) {
  return formatUnits(value, 18, 2);
}

function formatNative(value) {
  return formatUnits(value, 18, 5);
}

function rankName(level) {
  const index = Math.max(0, Math.min(ranks.length - 1, Number(level || 1) - 1));
  return ranks[index];
}

function levelBadge(level) {
  const numericLevel = Number(level || 0);
  const currentLevel = Number(state.data?.user?.currentLevel || 0);
  const statusClass = numericLevel > 0 && numericLevel <= currentLevel ? "unlocked" : "locked";
  return `<span class="level-badge ${statusClass}">${rankName(numericLevel)}</span>`;
}

function setStatus(message, type = "info") {
  state.status = message || "";
  state.statusType = type;
  render();
}

function setBusy(value, message) {
  state.busy = value;
  if (message) state.status = message;
  render();
}

function normalizeError(error) {
  const message = extractErrorMessage(error);
  if (message.includes("user rejected")) return "Transaction rejected in wallet.";
  if (message.includes("AlreadyRegistered")) return "This wallet is already registered.";
  if (message.includes("InvalidReferrer")) return "The upline/referrer is not registered.";
  if (message.includes("SelfReferral")) return "You cannot use your own address as upline.";
  if (message.includes("NothingToWithdraw")) return "There is no withdrawable balance.";
  if (message.includes("ERC20InsufficientAllowance")) return "Approve USDT before registering.";
  if (message.includes("ERC20InsufficientBalance")) return "Your USDT balance is too low.";
  if (message.includes("missing revert data") || message.includes("could not decode result data")) return "Contract read failed. Check that the frontend is using the latest deployed addresses for this network.";
  if (message.includes("network changed") || message.includes("chain changed")) return "Wallet network changed. Refresh the page and connect again.";
  if (message.includes("could not coalesce error")) return "RPC returned an unreadable error. Refresh once and check the transaction on BscScan.";
  if (message.includes("failed to detect network") || message.includes("getaddrinfo") || message.includes("ENOTFOUND")) return "Configured RPC is not reachable. The app will try your wallet provider after connection.";
  return message;
}

function extractErrorMessage(error) {
  const seen = new Set();
  const queue = [error];

  while (queue.length) {
    const item = queue.shift();
    if (item == null || seen.has(item)) continue;
    if (typeof item === "string") return item;
    seen.add(item);

    for (const key of ["shortMessage", "reason", "message"]) {
      if (typeof item[key] === "string" && item[key]) return item[key];
    }

    for (const key of ["error", "info", "payload", "data"]) {
      if (item[key]) queue.push(item[key]);
    }
  }

  return String(error);
}

function validateAddress(name, value) {
  if (!value || !ethers.isAddress(value)) {
    throw new Error(`${name} is missing or invalid in frontend/config.js`);
  }
}

function validateConfig() {
  validateAddress("USDT address", CONFIG.contracts.usdt);
  validateAddress("ORBD address", CONFIG.contracts.orbd);
  validateAddress("WeeklyPool address", CONFIG.contracts.weeklyPool);
  validateAddress("Matrix address", CONFIG.contracts.matrix);
  validateAddress("Genesis address", CONFIG.contracts.genesis);
  if (!CONFIG.rpcUrl) throw new Error("RPC URL is missing in frontend/config.js");
  if (!CONFIG.chainId) throw new Error("chainId is missing in frontend/config.js");
}

function makeReadContracts() {
  state.reader = new ethers.JsonRpcProvider(CONFIG.rpcUrl, CONFIG.chainId);
  state.readMatrix = new ethers.Contract(CONFIG.contracts.matrix, MATRIX_ABI, state.reader);
  state.readUsdt   = new ethers.Contract(CONFIG.contracts.usdt,   USDT_ABI,   state.reader);
  state.readPool   = new ethers.Contract(CONFIG.contracts.weeklyPool, POOL_ABI, state.reader);
  state.readOrbd   = new ethers.Contract(CONFIG.contracts.orbd,   ORBD_ABI,   state.reader);
}

function makeReadContractsWith(provider) {
  state.reader = provider;
  state.readMatrix = new ethers.Contract(CONFIG.contracts.matrix, MATRIX_ABI, provider);
  state.readUsdt   = new ethers.Contract(CONFIG.contracts.usdt,   USDT_ABI,   provider);
  state.readPool   = new ethers.Contract(CONFIG.contracts.weeklyPool, POOL_ABI, provider);
  state.readOrbd   = new ethers.Contract(CONFIG.contracts.orbd,   ORBD_ABI,   provider);
}

async function ensureChain() {
  if (!window.ethereum) throw new Error("Wallet not found. Install MetaMask or another injected wallet.");
  const hexChain = `0x${CONFIG.chainId.toString(16)}`;
  const current = await window.ethereum.request({ method: "eth_chainId" });
  if (current === hexChain) return;

  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexChain }] });
  } catch (error) {
    if (error.code !== 4902) throw error;
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: hexChain,
        chainName: CONFIG.chainName,
        nativeCurrency: CONFIG.nativeCurrency,
        rpcUrls: [CONFIG.rpcUrl],
        blockExplorerUrls: [CONFIG.blockExplorerUrl]
      }]
    });
  }
}

async function connect({ silent = false } = {}) {
  if (!window.ethereum) {
    if (!silent) setStatus("Wallet not found. Install MetaMask.", "error");
    return;
  }

  try {
    await ensureChain();
    const method = silent ? "eth_accounts" : "eth_requestAccounts";
    const accounts = await window.ethereum.request({ method });
    if (!accounts.length) return;

    state.account = ethers.getAddress(accounts[0]);
    state.provider = new ethers.BrowserProvider(window.ethereum);
    state.signer   = await state.provider.getSigner();
    state.matrix   = new ethers.Contract(CONFIG.contracts.matrix,     MATRIX_ABI, state.signer);
    state.usdt     = new ethers.Contract(CONFIG.contracts.usdt,        USDT_ABI,   state.signer);
    state.pool     = new ethers.Contract(CONFIG.contracts.weeklyPool,  POOL_ABI,   state.signer);
    state.treeRoot = state.account;
    state.previewTree = null;
    state.previewRootInfo = null;
    state.previewMembers = [];

    try {
      await state.reader.getBlockNumber();
    } catch {
      makeReadContractsWith(state.provider);
    }

    await refresh();
  } catch (error) {
    if (!silent) setStatus(normalizeError(error), "error");
  }
}

function disconnect() {
  localStorage.removeItem(SESSION_KEY);
  state.account = "";
  state.signer  = null;
  state.provider = null;
  state.matrix  = null;
  state.usdt    = null;
  state.pool    = null;
  state.data    = null;
  state.treeRoot = "";
  state.previewTree = null;
  state.previewRootInfo = null;
  state.previewMembers = [];
  state.status  = "";
  render();
}

async function refresh() {
  if (!state.account || state.loading) return;
  state.loading = true;
  render();

  try {
    let latest;
    try {
      latest = await state.reader.getBlockNumber();
    } catch (error) {
      if (state.provider && state.reader !== state.provider) {
        makeReadContractsWith(state.provider);
        latest = await state.reader.getBlockNumber();
      } else {
        throw error;
      }
    }
    const configuredStart = Number(CONFIG.eventStartBlock || 0);
    const fromBlock = configuredStart > 0 ? configuredStart : Math.max(0, latest - EVENT_LOOKBACK_BLOCKS);

    const [user, tree, totalMembers, paused, joinFee] = await Promise.all([
      state.readMatrix.getUserInfo(state.account),
      state.readMatrix.getTreeInfo(state.account),
      state.readMatrix.totalMembers(),
      state.readMatrix.paused(),
      state.readMatrix.JOIN_FEE()
    ]);

    const [nativeBalance, usdtBalance, allowance, tokenSymbol, orbdBalance, orbdSymbol] = await Promise.all([
      state.reader.getBalance(state.account).catch(() => 0n),
      state.readUsdt.balanceOf(state.account).catch(() => 0n),
      state.readUsdt.allowance(state.account, CONFIG.contracts.matrix).catch(() => 0n),
      state.readUsdt.symbol().catch(() => "USDT"),
      state.readOrbd.balanceOf(state.account).catch(() => 0n),
      state.readOrbd.symbol().catch(() => "ORBD")
    ]);

    const [registeredEvents, directEvents, history, poolStats, oracleState, treeMembers, directReferralAddresses, incomeTotals] = await Promise.all([
      queryRegistrations(state.account, fromBlock, latest),
      queryDirects(state.account, fromBlock, latest),
      queryHistory(state.account, fromBlock, latest),
      queryPoolStats(state.account),
      queryOracleState(),
      queryTeamFromContract(state.account, tree),
      state.readMatrix.getDirectReferrals(state.account).catch(() => []),
      state.readMatrix.getIncomeTotals(state.account).catch(() => ({
        directIncome: 0n,
        levelIncome: 0n,
        skippedIncome: 0n,
        withdrawn: 0n,
      }))
    ]);

    const immediateTreeMembers = await queryImmediateTreeMembers(state.account, tree);
    const directReferralMembers = await queryDirectReferralMembers(directReferralAddresses, state.account, tree);
    const mergedTreeMembers = normalizeSponsorTeamMembers(
      state.account,
      mergeTeamMembers(treeMembers, immediateTreeMembers, directReferralMembers)
    );

    state.data = {
      user,
      tree,
      nativeBalance,
      usdtBalance,
      allowance,
      totalMembers,
      paused,
      joinFee,
      tokenSymbol,
      orbdBalance,
      orbdSymbol,
      registeredEvents,
      directEvents,
      history,
      poolStats,
      oracleState,
      treeMembers: mergedTreeMembers,
      directReferralAddresses,
      incomeTotals
    };
    if (user.isRegistered) {
      localStorage.setItem(SESSION_KEY, "1");
    } else {
      localStorage.removeItem(SESSION_KEY);
    }
    state.status = user.isRegistered ? "" : "Wallet connected only. This address is not registered yet.";
    state.statusType = user.isRegistered ? "info" : "error";
  } catch (error) {
    state.status = normalizeError(error);
    state.statusType = "error";
  } finally {
    state.loading = false;
    render();
  }
}

async function queryRegistrations(account, fromBlock, latest) {
  const all = await safeQueryFilter(state.readMatrix.filters.UserRegistered(), fromBlock, latest);
  return {
    all,
    asUser:     all.filter((event) => sameAddress(event.args.user,     account)),
    asReferrer: all.filter((event) => sameAddress(event.args.referrer, account)),
    asParent:   all.filter((event) => sameAddress(event.args.parent,   account)),
  };
}

async function queryDirects(account, fromBlock, latest) {
  const all = await safeQueryFilter(state.readMatrix.filters.DirectReferralPaid(), fromBlock, latest);
  return all.filter((event) => sameAddress(event.args.referrer, account));
}

async function queryHistory(account, fromBlock, latest) {
  const [direct, withdrawals] = await Promise.all([
    queryDirects(account, fromBlock, latest),
    safeQueryFilter(state.readMatrix.filters.Withdrawal(), fromBlock, latest)
  ]);
  return [...direct, ...withdrawals.filter((event) => sameAddress(event.args.user, account))]
    .sort((a, b) => Number(b.blockNumber) - Number(a.blockNumber))
    .slice(0, 10);
}

async function safeQueryFilter(filter, fromBlock, latest) {
  const cacheKey = `${filter.topics?.[0] || "unknown"}:${fromBlock}:${latest}`;
  if (eventCache.has(cacheKey)) return eventCache.get(cacheKey);

  const explorerEvents = await queryExplorerLogs(filter, fromBlock, latest);
  if (explorerEvents) {
    eventCache.set(cacheKey, explorerEvents);
    return explorerEvents;
  }

  const events = [];

  for (let start = fromBlock; start <= latest; start += EVENT_CHUNK_BLOCKS + 1) {
    const end = Math.min(latest, start + EVENT_CHUNK_BLOCKS);
    try {
      events.push(...await state.readMatrix.queryFilter(filter, start, end));
    } catch {
      // Some public RPCs reject log ranges. Keep dashboard usable with partial data.
    }
  }

  eventCache.set(cacheKey, events);
  return events;
}

async function queryExplorerLogs(filter, fromBlock, latest) {
  if (!CONFIG.logsApiPath || !filter?.topics?.length) return null;

  const params = new URLSearchParams({
    chainid: String(CONFIG.chainId),
    address: CONFIG.contracts.matrix,
    fromBlock: String(fromBlock),
    toBlock: String(latest),
  });

  filter.topics.forEach((topic, index) => {
    if (typeof topic === "string") params.set(`topic${index}`, topic);
  });

  try {
    const response = await fetch(`${CONFIG.logsApiPath}?${params.toString()}`);
    if (!response.ok) return null;
    const payload = await response.json();
    if (payload.status !== "1" || !Array.isArray(payload.result)) return null;

    return payload.result.map((log) => {
      const parsed = state.readMatrix.interface.parseLog({
        topics: log.topics,
        data: log.data,
      });
      return {
        args: parsed.args,
        eventName: parsed.name,
        fragment: parsed.fragment,
        blockNumber: Number(log.blockNumber),
        transactionHash: log.transactionHash,
      };
    });
  } catch {
    return null;
  }
}

async function queryTreeMembers(root, maxDepth = TEAM_MAX_DEPTH, maxMembers = TEAM_MAX_MEMBERS) {
  const members = [];
  const queue = [{ address: root, parent: ZERO, side: "-", depth: 0 }];
  const seen = new Set([root.toLowerCase()]);

  while (queue.length && members.length < maxMembers) {
    const current = queue.shift();

    try {
      const [info, tree] = await Promise.all([
        state.readMatrix.getUserInfo(current.address),
        state.readMatrix.getTreeInfo(current.address),
      ]);

      if (!sameAddress(current.address, root)) {
        members.push({ ...current, info, tree });
      }

      if (current.depth >= maxDepth) continue;

      for (const [sideIndex, child] of [tree.leftChild, tree.rightChild].entries()) {
        if (child === ZERO) continue;
        const key = child.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push({
          address: child,
          parent: current.address,
          side: sideIndex === 0 ? "Left" : "Right",
          depth: current.depth + 1,
        });
      }
    } catch {
      // Keep loading the rest of the tree if one node fails.
    }
  }

  return members;
}

async function queryTeamFromContract(root, rootTree = null) {
  try {
    const addresses = await state.readMatrix.getTeamAddresses(root, TEAM_MAX_DEPTH, CONTRACT_TEAM_PAGE_SIZE);
    if (!addresses.length) return queryTreeMembers(root);

    if (addresses.length >= CONTRACT_TEAM_PAGE_SIZE) {
      return queryTreeMembers(root);
    }

    const members = await Promise.all(addresses.map(async (address) => {
      const [info, tree] = await Promise.all([
        state.readMatrix.getUserInfo(address),
        state.readMatrix.getTreeInfo(address),
      ]);

      return {
        address,
        parent: tree.parent,
        side: "-",
        depth: 0,
        info,
        tree,
      };
    }));

    return annotateTreeMembers(root, members, rootTree);
  } catch {
    return queryTreeMembers(root);
  }
}

function queryDirectReferralMembers(addresses, root, rootTree = null) {
  const uniqueAddresses = [...new Set((addresses || [])
    .filter((address) => address && address !== ZERO)
    .map((address) => ethers.getAddress(address).toLowerCase()))]
    .map((address) => ethers.getAddress(address));

  return Promise.all(uniqueAddresses.map(async (address) => {
    try {
      const [info, tree] = await Promise.all([
        state.readMatrix.getUserInfo(address),
        state.readMatrix.getTreeInfo(address),
      ]);
      const isPlacedUnderRoot = sameAddress(tree.parent, root);
      return {
        address,
        parent: info.referrer && info.referrer !== ZERO ? info.referrer : root,
        placementParent: tree.parent && tree.parent !== ZERO ? tree.parent : root,
        side: isPlacedUnderRoot ? sideFromTree(rootTree, address, "Referral") : "Referral",
        depth: isPlacedUnderRoot ? 1 : 1,
        info,
        tree,
      };
    } catch {
      return null;
    }
  })).then((members) => members.filter(Boolean));
}

function queryImmediateTreeMembers(root, rootTree = null) {
  if (!rootTree) return Promise.resolve([]);

  const children = [
    { address: rootTree.leftChild, side: "Left" },
    { address: rootTree.rightChild, side: "Right" },
  ].filter((child) => child.address && child.address !== ZERO);

  return Promise.all(children.map(async (child) => {
    try {
      const [info, tree] = await Promise.all([
        state.readMatrix.getUserInfo(child.address),
        state.readMatrix.getTreeInfo(child.address),
      ]);

      return {
        address: child.address,
        parent: root,
        placementParent: root,
        side: child.side,
        placementSide: child.side,
        depth: 1,
        placementDepth: 1,
        info,
        tree,
      };
    } catch {
      return null;
    }
  })).then((members) => members.filter(Boolean));
}

function mergeTeamMembers(...memberLists) {
  const merged = new Map();

  for (const list of memberLists) {
    for (const member of list || []) {
      if (!member?.address || sameAddress(member.address, state.account)) continue;
      const key = member.address.toLowerCase();
      const existing = merged.get(key);
      if (!existing || Number(existing.depth || 0) === 0 || existing.side === "Referral") {
        merged.set(key, member);
      }
    }
  }

  return [...merged.values()].sort((a, b) => {
    const depthDelta = Number(a.depth || 0) - Number(b.depth || 0);
    if (depthDelta) return depthDelta;
    if (a.side === b.side) return a.address.localeCompare(b.address);
    if (a.side === "Left") return -1;
    if (b.side === "Left") return 1;
    return 0;
  });
}

function normalizeSponsorTeamMembers(root, members) {
  const rootKey = root.toLowerCase();
  const byAddress = new Map();

  for (const member of members || []) {
    if (!member?.address || sameAddress(member.address, root)) continue;
    const placementParent = member.placementParent || member.parent || member.tree?.parent || ZERO;
    const sponsorParent = member.info?.referrer && member.info.referrer !== ZERO
      ? member.info.referrer
      : placementParent;

    byAddress.set(member.address.toLowerCase(), {
      ...member,
      placementParent,
      placementSide: member.placementSide || member.side || "-",
      placementDepth: Number(member.placementDepth || member.depth || 0),
      parent: sponsorParent,
      side: "Sponsor",
      depth: 0,
    });
  }

  const childrenBySponsor = new Map();
  for (const member of byAddress.values()) {
    const parentKey = member.parent?.toLowerCase?.() || rootKey;
    if (!childrenBySponsor.has(parentKey)) childrenBySponsor.set(parentKey, []);
    childrenBySponsor.get(parentKey).push(member);
  }

  for (const children of childrenBySponsor.values()) {
    children.sort((a, b) => a.address.localeCompare(b.address));
  }

  const ordered = [];
  const seen = new Set();
  const queue = [{ address: root, depth: 0 }];

  while (queue.length) {
    const current = queue.shift();
    const children = childrenBySponsor.get(current.address.toLowerCase()) || [];

    for (const child of children) {
      const key = child.address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      child.depth = current.depth + 1;
      child.side = "Sponsor";
      ordered.push(child);
      queue.push({ address: child.address, depth: child.depth });
    }
  }

  const orphaned = [...byAddress.values()]
    .filter((member) => !seen.has(member.address.toLowerCase()))
    .map((member) => ({
      ...member,
      parent: member.placementParent || member.parent || root,
      side: member.placementSide || "Placement",
      depth: Number(member.placementDepth || member.depth || 1),
    }))
    .sort((a, b) => Number(a.depth || 0) - Number(b.depth || 0) || a.address.localeCompare(b.address));

  return [...ordered, ...orphaned];
}

function sideFromTree(tree, childAddress, fallback = "-") {
  if (!tree) return fallback;
  if (sameAddress(tree.leftChild, childAddress)) return "Left";
  if (sameAddress(tree.rightChild, childAddress)) return "Right";
  return fallback;
}

function annotateTreeMembers(root, members, rootTree = null) {
  const byParent  = new Map();
  const byAddress = new Map();

  for (const member of members) {
    byAddress.set(member.address.toLowerCase(), member);
    const parentKey = member.parent.toLowerCase();
    if (!byParent.has(parentKey)) byParent.set(parentKey, []);
    byParent.get(parentKey).push(member);
  }

  const queue = [{ address: root, depth: 0 }];
  const annotated = [];

  while (queue.length) {
    const current = queue.shift();
    const children = byParent.get(current.address.toLowerCase()) || [];

    for (const child of children) {
      const parentTree = current.address === root
        ? rootTree || (sameAddress(root, state.account) ? state.data?.tree : state.previewTree)
        : byAddress.get(current.address.toLowerCase())?.tree;
      child.depth = current.depth + 1;
      child.side = sideFromTree(parentTree, child.address, child.side || "-");
      annotated.push(child);
      queue.push({ address: child.address, depth: child.depth });
    }
  }

  return (annotated.length ? annotated : members).sort((a, b) => {
    const depthDelta = Number(a.depth || 0) - Number(b.depth || 0);
    if (depthDelta) return depthDelta;
    return a.address.localeCompare(b.address);
  });
}

// Query all 11 pools (0–10)
async function queryPoolStats(account) {
  const jobs = Array.from({ length: POOL_COUNT }, async (_, index) => {
    try {
      const [member, pool] = await Promise.all([
        state.readPool.getMemberStats(account, index),
        state.readPool.getPoolStats(index)
      ]);
      return { index, member, pool };
    } catch {
      return null;
    }
  });
  return Promise.all(jobs);
}

async function queryOracleState() {
  try {
    const [stateResult, preview] = await Promise.all([
      state.readPool.getPancakeOracleState(),
      state.readPool.previewOracleRate().catch(() => null),
    ]);

    return {
      pair: stateResult.pair,
      enabled: stateResult.enabled,
      ready: stateResult.ready,
      rate: stateResult.rate,
      minInterval: stateResult.minInterval,
      maxAge: stateResult.maxAge,
      lastRateTimestamp: stateResult.lastRateTimestamp,
      preview,
    };
  } catch {
    return null;
  }
}

async function validateRegistration(referrer) {
  if (!ethers.isAddress(referrer)) throw new Error("Enter a valid upline address.");
  if (ethers.getAddress(referrer) === state.account) throw new Error("You cannot use your own address as upline.");
  const [caller, sponsor, paused, balance, joinFee] = await Promise.all([
    state.readMatrix.getUserInfo(state.account),
    state.readMatrix.getUserInfo(referrer),
    state.readMatrix.paused(),
    state.readUsdt.balanceOf(state.account),
    getJoinFee()
  ]);
  if (paused) throw new Error("Registration is paused.");
  if (caller.isRegistered) throw new Error("This wallet is already registered.");
  if (!sponsor.isRegistered) throw new Error("The upline/referrer is not registered.");
  if (balance < joinFee) throw new Error(`You need ${formatUsdt(joinFee)} USDT to register.`);
  return joinFee;
}

async function getJoinFee() {
  if (state.data?.joinFee != null) return state.data.joinFee;
  return state.readMatrix.JOIN_FEE();
}

async function approveAndRegister(referrer) {
  if (!state.account) {
    await connect();
    if (!state.account) return;
  }

  try {
    setBusy(true, "Validating registration...");
    const cleanReferrer = ethers.getAddress(String(referrer).trim());
    const joinFee = await validateRegistration(cleanReferrer);

    const allowance = await state.usdt.allowance(state.account, CONFIG.contracts.matrix);
    if (allowance < joinFee) {
      setBusy(true, "Open wallet and approve USDT...");
      const approveTx = await state.usdt.approve(CONFIG.contracts.matrix, joinFee);
      setStatus(`USDT approval submitted: ${approveTx.hash}`, "info");
      await approveTx.wait();
    }

    setBusy(true, "Open wallet and confirm registration...");
    const gas = await state.matrix.register.estimateGas(cleanReferrer);
    const tx  = await state.matrix.register(cleanReferrer, { gasLimit: (gas * 120n) / 100n });
    setStatus(`Registration submitted: ${tx.hash}`, "info");
    await tx.wait();

    const user = await state.readMatrix.getUserInfo(state.account);
    if (!user.isRegistered) {
      throw new Error("Registration transaction completed, but this wallet is not registered yet. Refresh and check the transaction.");
    }

    setStatus("Registration complete.", "success");
    await refresh();
  } catch (error) {
    setStatus(normalizeError(error), "error");
  } finally {
    setBusy(false);
  }
}

async function withdraw() {
  try {
    if (!state.data?.user?.claimableUsdt) throw new Error("There is no withdrawable balance.");
    setBusy(true, "Open wallet and confirm withdrawal...");
    const gas = await state.matrix.withdraw.estimateGas();
    const tx  = await state.matrix.withdraw({ gasLimit: (gas * 120n) / 100n });
    setStatus(`Withdrawal submitted: ${tx.hash}`, "info");
    await tx.wait();
    setStatus("Withdrawal complete.", "success");
    await refresh();
  } catch (error) {
    setStatus(normalizeError(error), "error");
  } finally {
    setBusy(false);
  }
}

function statusHtml() {
  if (!state.status) return "";
  return `<div class="app-status ${state.statusType}">${escapeHtml(state.status)}</div>`;
}

function spinner() {
  return state.loading || state.busy ? `<span class="spinner"></span>` : "";
}

function shell(content) {
  return `
    <div class="shell">
      <header class="topbar">
        <div class="logo" aria-label="Arvo"></div>
        <div class="top-actions">
          <a class="wallet-pill" href="${explorerAddress(state.account)}" target="_blank" rel="noreferrer">
            <span class="coin-mark">${escapeHtml(CONFIG.nativeCurrency.symbol)}</span>${formatNative(state.data?.nativeBalance || 0n)} ${escapeHtml(CONFIG.nativeCurrency.symbol)}
            <span class="avatar-mark"></span>${shortAddress(state.account)}
          </a>
          <span class="notification">!</span>
          <button class="gold-button" data-action="logout" ${state.busy ? "disabled" : ""}>Logout</button>
        </div>
      </header>
      <nav class="nav">
        ${tabs.map(([id, label]) => `<button class="${state.tab === id ? "active" : ""}" data-tab="${id}" ${state.busy ? "disabled" : ""}>${label}</button>`).join("")}
      </nav>
      <main class="content">${statusHtml()}${content}</main>
    </div>
  `;
}

function login() {
  const params = new URLSearchParams(location.search);
  const defaultReferrer = params.get("ref") || CONFIG.contracts.genesis;
  const connected = Boolean(state.account);
  const unregistered = connected && state.data && !state.data.user.isRegistered;
  const joinFee = state.data?.joinFee || 10_000_000_000_000_000_000n;
  const walletUsdt = state.data?.usdtBalance || 0n;
  const registrationMeta = !connected
    ? "Connect wallet to approve USDT and register"
    : unregistered
      ? `Not registered on-chain. Wallet balance: ${formatUsdt(walletUsdt)} ${state.data.tokenSymbol}. Registration fee: ${formatUsdt(joinFee)} ${state.data.tokenSymbol}.`
      : "This wallet is already registered";
  return `
    <div class="login-page">
      <section class="login-stack">
        <div class="wallet-pill"><span class="coin-mark">${escapeHtml(CONFIG.nativeCurrency.symbol)}</span>${connected ? shortAddress(state.account) : "Wallet not connected"}</div>
        <div class="login-card">
          <h1>Member Access</h1>
          <p>${connected ? unregistered ? "Wallet connected only. Registration required." : "Registered wallet connected" : "Connect wallet to continue"}</p>
          <button class="connect-button" data-action="connect" ${state.busy ? "disabled" : ""}>${connected ? "Refresh Wallet" : "Connect Wallet"}</button>
        </div>
        <div class="login-card">
          <h2>Create Your Account</h2>
          <form class="upline-form" data-register-form>
            <input name="referrer" placeholder="Upline Address" value="${escapeHtml(defaultReferrer)}" ${state.busy ? "disabled" : ""}>
            <div class="login-meta">
              ${registrationMeta}
            </div>
            <button class="connect-button" type="submit" ${state.busy || (connected && !unregistered) ? "disabled" : ""}>${connected ? "Approve & Register" : "Connect Wallet & Register"}</button>
          </form>
        </div>
        ${statusHtml()}
      </section>
    </div>
  `;
}

function dashboard() {
  const data = state.data;
  const user = data.user;
  const joined = data.registeredEvents.asUser[0];
  const ref = `${location.origin}${location.pathname}?ref=${state.account}`;
  const eventDirectIncome  = data.directEvents.reduce((sum, item) => sum + item.args.amount, 0n);
  const storedDirectIncome = data.incomeTotals.directIncome || 0n;
  const directIncome       = eventDirectIncome > storedDirectIncome ? eventDirectIncome : storedDirectIncome;
  const totalIncome        = directIncome + user.claimableUsdt;

  // ORBD earnings from pool stats
  const totalOrbdReceived  = data.poolStats
    .filter(Boolean)
    .reduce((sum, s) => sum + (s.member?.totalReceived || 0n), 0n);
  const oracle = data.oracleState;
  const oracleRate = oracle?.rate ? `${formatOrbd(oracle.rate)} ORBD / USDT` : "-";
  const oracleStatus = !oracle
    ? "Unavailable"
    : oracle.enabled
      ? oracle.ready ? "Ready" : "Waiting for TWAP"
      : "Disabled";

  // Pool stats rows — all 11 pools
  const poolRows = data.poolStats.filter(Boolean).map(({ index, member, pool }) => `
    <div class="rank-row">
      <div>Pool ${index} <span>${member.active ? "Active" : "Inactive"}</span></div>
      <div>${formatUsdt(member.totalReceived)} USDT received / target ${formatUsdt(pool.target)} USDT (${pool.memberCount.toString()} members)</div>
    </div>
  `).join("");

  const referralRows = referralEarningRows(data);

  return `
    <div class="center">
      <div class="wallet-pill">
        <span class="coin-mark">USDT</span>${formatUsdt(data.usdtBalance)} ${data.tokenSymbol}
        &nbsp;|&nbsp;
        <span class="coin-mark">ORBD</span>${formatOrbd(data.orbdBalance)} ${data.orbdSymbol}
        <span class="avatar-mark"></span>${shortAddress(state.account)}
      </div>
    </div>
    <section class="dark-card">
      <div class="profile-grid">
        <div class="profile-list">
          <div>User id : ${shortAddress(state.account)}</div>
          <div>Sponsor ID : ${shortAddress(user.referrer)}</div>
          <div>Address : <a href="${explorerAddress(state.account)}" target="_blank" rel="noreferrer">${shortAddress(state.account)}</a> <button class="tiny-black" data-copy="${escapeHtml(state.account)}">Copy</button></div>
          <div>Rank : ${rankName(user.currentLevel)}</div>
          <div>Level : ${Number(user.currentLevel)} / ${MAX_LEVEL}</div>
          <div>Total Members : ${data.totalMembers.toString()}</div>
        </div>
        <div class="mini-stats">
          <div class="mini-stat"><span class="mini-icon">$</span><span>USDT Balance<br>${formatUsdt(data.usdtBalance)} ${data.tokenSymbol}</span></div>
          <div class="mini-stat"><span class="mini-icon">O</span><span>ORBD Balance<br>${formatOrbd(data.orbdBalance)} ${data.orbdSymbol}</span></div>
          <div class="mini-stat"><span class="mini-icon">D</span><span>Date of Joining<br>${joined ? `Block #${joined.blockNumber}` : "-"}</span></div>
        </div>
      </div>
      <div class="ref-box">
        <strong>Referral Link</strong>
        <div class="copy-row">
          <input readonly value="${escapeHtml(ref)}">
          <button data-copy="${escapeHtml(ref)}">Copy</button>
        </div>
      </div>
    </section>
    <div class="section-label">Packages (Level 2-12 Progress)</div>
    <section class="packages">${packages.slice(0, MAX_LEVEL - 1).map(([price], i) => {
      const level = i + 2;
      const unlocked = Number(user.currentLevel) >= level;
      const current = Number(user.currentLevel) === level;
      return `
      <article class="package-card ${unlocked ? "unlocked" : "locked"} ${current ? "current" : ""}">
        <div>${price}</div>
        <div class="rank-pill">Level ${level}</div>
        <div class="coin-mark">USDT</div>
        <button class="tiny-black" disabled>${current ? "Current" : unlocked ? "Unlocked" : "Locked"}</button>
      </article>
    `;
    }).join("")}</section>
    <section class="tile-grid">
      <div class="income-tile"><div class="amount">$ ${formatUsdt(directIncome)}</div><strong>Direct Income</strong></div>
      <div class="income-tile"><div class="amount">$ ${formatUsdt(user.claimableUsdt)}</div><strong>Withdrawable Income</strong><button class="tiny-black" data-action="withdraw" ${state.busy || user.claimableUsdt === 0n ? "disabled" : ""}>Withdraw</button></div>
      <div class="income-tile"><div class="amount">${formatOrbd(data.orbdBalance)} ORBD</div><strong>ORBD Balance</strong></div>
      <div class="income-tile"><div class="amount">${formatOrbd(totalOrbdReceived)} ORBD</div><strong>Total ORBD Earned</strong></div>
      <div class="income-tile"><div class="amount">${oracleRate}</div><strong>Oracle Rate</strong><span>${oracleStatus}</span></div>
      <div class="income-tile"><div class="amount">$ ${formatUsdt(totalIncome)}</div><strong>Total USDT Income</strong></div>
    </section>
    <div class="section-label">ORBD Pool Rewards (Pools 0–10)</div>
    <section class="rank-table">${poolRows || '<div class="rank-row"><div>No pool memberships yet</div><div>-</div></div>'}</section>
    <div class="section-label">Recent History</div>
    <section class="history">${dashboardHistoryRows(data, directIncome)}</section>
    <div class="section-label">Referral Earnings</div>
    <section class="history">${referralRows}</section>
    <footer class="footer-addresses">
      <div>Arvo Address Link</div>
      <div class="address-chip">Contract Address : ${shortAddress(CONFIG.contracts.matrix)} <button class="tiny-black" data-copy="${escapeHtml(CONFIG.contracts.matrix)}">Copy</button></div>
      <div class="address-chip">USDT Address : ${shortAddress(CONFIG.contracts.usdt)} <button class="tiny-black" data-copy="${escapeHtml(CONFIG.contracts.usdt)}">Copy</button></div>
      <div class="address-chip">ORBD Address : ${shortAddress(CONFIG.contracts.orbd)} <button class="tiny-black" data-copy="${escapeHtml(CONFIG.contracts.orbd)}">Copy</button></div>
      ${CONFIG.contracts.oraclePair ? `<div class="address-chip">Oracle Pair : ${shortAddress(CONFIG.contracts.oraclePair)} <button class="tiny-black" data-copy="${escapeHtml(CONFIG.contracts.oraclePair)}">Copy</button></div>` : ""}
    </footer>
  `;
}

function historyRows(history) {
  return history.map((event) => {
    const eventName = event.eventName || event.fragment?.name || "Event";
    const amount = event.args.amount || 0n;
    const text = eventName === "DirectReferralPaid"
      ? `DIRECT From ${shortAddress(event.args.from)}`
      : eventName === "Withdrawal"
        ? "Withdrawal"
        : `L ${event.args.level}, Rank ${rankName(event.args.level)}`;
    return `
      <div class="history-row">
        <div>${eventName.replace("ReferralPaid", "")}</div>
        <div>${formatUsdt(amount)} USDT</div>
        <div>${text}</div>
        <div><a href="${explorerTx(event.transactionHash)}" target="_blank" rel="noreferrer">#${event.blockNumber}</a></div>
      </div>
    `;
  }).join("") || `<div class="history-row"><div>-</div><div>0 USDT</div><div>No history yet</div><div>-</div></div>`;
}

function directReferralAddresses(data) {
  const directMembers = data.treeMembers
    .filter((member) => !sameAddress(member.address, state.account) && sameAddress(member.info.referrer, state.account));
  return [...new Set([
    ...data.directReferralAddresses.map((address) => address.toLowerCase()),
    ...directMembers.map((member) => member.address.toLowerCase()),
    ...data.registeredEvents.asReferrer.map((event) => String(event.args.user).toLowerCase()),
  ])].map((address) => ethers.getAddress(address));
}

function dashboardHistoryRows(data, directIncome) {
  const eventRows = historyRows(data.history);
  if (data.history.length) return eventRows;

  const rows = [];
  if (directIncome > 0n) {
    rows.push(`
      <div class="history-row">
        <div>Direct</div>
        <div>${formatUsdt(directIncome)} USDT</div>
        <div>Total direct income from contract storage</div>
        <div>On-chain</div>
      </div>
    `);
  }
  if (data.user.claimableUsdt > 0n) {
    rows.push(`
      <div class="history-row">
        <div>Claimable</div>
        <div>${formatUsdt(data.user.claimableUsdt)} USDT</div>
        <div>Available withdrawable income</div>
        <div>On-chain</div>
      </div>
    `);
  }
  if ((data.incomeTotals.withdrawn || 0n) > 0n) {
    rows.push(`
      <div class="history-row">
        <div>Withdrawn</div>
        <div>${formatUsdt(data.incomeTotals.withdrawn)} USDT</div>
        <div>Total withdrawn from contract storage</div>
        <div>On-chain</div>
      </div>
    `);
  }

  return rows.join("") || eventRows;
}

function referralEarningRows(data) {
  const eventRows = data.registeredEvents.asReferrer.map((event, index) => {
    const paid = data.directEvents.find((direct) => direct.args.from.toLowerCase() === event.args.user.toLowerCase());
    return `
      <div class="history-row">
        <div>${index + 1}</div>
        <div><a href="${explorerAddress(event.args.user)}" target="_blank" rel="noreferrer">${shortAddress(event.args.user)}</a></div>
        <div>${paid ? `${formatUsdt(paid.args.amount)} USDT direct paid` : "Registered referral"}</div>
        <div><a href="${explorerTx(event.transactionHash)}" target="_blank" rel="noreferrer">#${event.blockNumber}</a></div>
      </div>
    `;
  });

  const eventAddresses = new Set(data.registeredEvents.asReferrer.map((event) => String(event.args.user).toLowerCase()));
  const storageRows = directReferralAddresses(data)
    .filter((address) => !eventAddresses.has(address.toLowerCase()))
    .map((address, index) => `
      <div class="history-row">
        <div>${eventRows.length + index + 1}</div>
        <div><a href="${explorerAddress(address)}" target="_blank" rel="noreferrer">${shortAddress(address)}</a></div>
        <div>Direct referral from contract storage</div>
        <div>Contract storage</div>
      </div>
    `);

  const rows = [...eventRows, ...storageRows];
  if (!rows.length && Number(data.user.directCount || 0n) > 0) {
    rows.push(`
      <div class="history-row">
        <div>${data.user.directCount.toString()}</div>
        <div>Direct referrals</div>
        <div>Count only. No direct income payment found.</div>
        <div>Contract count</div>
      </div>
    `);
  }

  return rows.join("") ||
    `<div class="history-row"><div>-</div><div>-</div><div>No direct referrals found on-chain</div><div>-</div></div>`;
}

function downlineLevelFilter() {
  return Number(state.selectedDownlineLevel || 0);
}

function filterByDownlineLevel(members) {
  const selectedLevel = downlineLevelFilter();
  if (!selectedLevel) return members;
  return members.filter((member) => Number(member.info?.currentLevel || 0) === selectedLevel);
}

function teamMembers() {
  return (state.data?.treeMembers || [])
    .filter((member) => !sameAddress(member.address, state.account));
}

function levelCounts(members) {
  const counts = new Map();
  for (const member of members || []) {
    const level = Number(member.info?.currentLevel || 0);
    if (level > 0) counts.set(level, (counts.get(level) || 0) + 1);
  }
  return counts;
}

function memberIdCell(address) {
  if (!address || address === ZERO) return "-";
  return `<a href="${explorerAddress(address)}" target="_blank" rel="noreferrer">${shortAddress(address)}</a>`;
}

function memberAddressCell(address) {
  if (!address || address === ZERO) return "-";
  return `<a href="${explorerAddress(address)}" target="_blank" rel="noreferrer">${address}</a>`;
}

function sponsorCell(member) {
  return memberIdCell(member.info.referrer);
}

function placementText(member) {
  const parent = member.placementParent || member.tree?.parent || member.parent;
  const side = member.placementSide || member.side || "-";
  return `${shortAddress(parent)} / ${side}`;
}

function memberListRows(members, emptyText, options = {}) {
  const showClaimable = options.showClaimable === true;
  const rows = (members || []).map((member, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${memberIdCell(member.address)}</td>
      <td>${memberAddressCell(member.address)}</td>
      <td>${sponsorCell(member)}</td>
      <td>${levelBadge(member.info.currentLevel)}</td>
      <td>Sponsor Level ${member.depth}</td>
      <td>${placementText(member)}</td>
      <td>${member.info.directCount.toString()}</td>
      ${showClaimable ? `<td>${formatUsdt(member.info.claimableUsdt)} USDT</td>` : ""}
    </tr>
  `).join("");

  const columnCount = showClaimable ? 9 : 8;
  return rows || `<tr><td colspan="${columnCount}">${emptyText}</td></tr>`;
}

function memberListColumns(options = {}) {
  const columns = ["SNo.", "Member ID", "Address", "Sponsor/Upline", "Member Level", "Sponsor Depth", "Placement Parent", "Direct Team"];
  return options.showClaimable ? [...columns, "Claimable"] : columns;
}

function tablePage(title, rows, columns, options = {}) {
  const selectedLevel = downlineLevelFilter();
  const showAllButton = options.showAllButton !== false;
  const counts = options.levelCounts || new Map();
  const levelButtons = Array.from({ length: MAX_LEVEL }, (_, i) => {
    const level = i + 1;
    const statusClass = level === selectedLevel ? "current" : "unlocked";
    const count = counts.get(level) || 0;
    return `<button class="${statusClass}" data-downline-level="${level}">Level ${level}${count ? ` (${count})` : ""}</button>`;
  }).join("");
  const allButton = showAllButton
    ? `<button class="${selectedLevel ? "unlocked" : "current"}" data-downline-level="0">All${counts.size ? ` (${[...counts.values()].reduce((sum, count) => sum + count, 0)})` : ""}</button>`
    : "";
  const subtitle = selectedLevel
    ? `<div class="table-filter-note">Showing members at Level ${selectedLevel}</div>`
    : "";

  return `
    <div class="pager level-sequence">${allButton}${levelButtons}</div>
    <section class="data-panel">
      <h2>${title}</h2>
      ${subtitle}
      <div class="table-wrap">
        <table>
          <thead><tr>${columns.map((c) => `<th>${c}</th>`).join("")}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  `;
}

function directs() {
  const selectedLevel = downlineLevelFilter();
  const allMembers = teamMembers();
  const counts = levelCounts(allMembers);
  if (selectedLevel) {
    const members = filterByDownlineLevel(allMembers);
    const rows = memberListRows(members, `No wallets found at member Level ${selectedLevel}`);
    return tablePage("Direct Team", rows, memberListColumns(), { levelCounts: counts });
  }

  const events = state.data.registeredEvents.asReferrer;
  const directMembers = allMembers
    .filter((member) => sameAddress(member.info.referrer, state.account));
  const directAddressSet = new Set([
    ...state.data.directReferralAddresses.map((address) => address.toLowerCase()),
    ...directMembers.map((member) => member.address.toLowerCase()),
  ]);
  const directAddresses = [...directAddressSet];
  const eventAddresses  = new Set(events.map((event) => String(event.args.user).toLowerCase()));
  const rowsFromEvents = events.map((event, index) => {
    const paid = state.data.directEvents.find((direct) => sameAddress(direct.args.from, event.args.user));
    const member = directMembers.find((item) => sameAddress(item.address, event.args.user));
    return `
    <tr>
      <td>${index + 1}</td>
      <td>${memberIdCell(event.args.user)}</td>
      <td>${memberAddressCell(event.args.user)}</td>
      <td>${member ? levelBadge(member.info.currentLevel) : "-"}</td>
      <td>Block #${event.blockNumber}</td>
      <td>${paid ? `${formatUsdt(paid.args.amount)} USDT` : "Registered"}</td>
    </tr>
  `;
  });
  const rowsFromStorage = directAddresses
    .filter((address) => !eventAddresses.has(address))
    .map((address, index) => {
      const member = directMembers.find((item) => sameAddress(item.address, address));
      return `
      <tr>
        <td>${rowsFromEvents.length + index + 1}</td>
        <td>${memberIdCell(address)}</td>
        <td>${memberAddressCell(address)}</td>
        <td>${member ? levelBadge(member.info.currentLevel) : "-"}</td>
        <td>${member ? `Sponsor level ${member.depth}` : "Contract storage"}</td>
        <td>Referral record</td>
      </tr>
    `;
    });
  const directRows = [...rowsFromEvents, ...rowsFromStorage].join("");
  if (!directRows && allMembers.length) {
    return tablePage(
      "Direct Team",
      memberListRows(allMembers, "No team wallets found"),
      memberListColumns(),
      { levelCounts: counts }
    );
  }
  const rows = directRows || `<tr><td colspan="6">No direct referral records found. Contract direct count: ${state.data.user.directCount.toString()}</td></tr>`;
  return tablePage("Direct Team", rows, ["Sr. No.", "Member ID", "Address", "Level", "Join Block", "Direct Income"], { levelCounts: counts });
}

function myTeam() {
  const selectedLevel = downlineLevelFilter();
  const allMembers = teamMembers();
  const members = filterByDownlineLevel(allMembers);
  const counts = levelCounts(allMembers);
  const rows = memberListRows(members, selectedLevel ? `No team records found at member Level ${selectedLevel}` : "No team records yet");
  return tablePage("My Team", rows, memberListColumns(), { levelCounts: counts });
}

function community() {
  const selectedLevel = downlineLevelFilter();
  const allMembers = teamMembers();
  const members = filterByDownlineLevel(allMembers);
  const counts = levelCounts(allMembers);
  const rows = memberListRows(
    members,
    selectedLevel ? `No community members found at member Level ${selectedLevel}` : "No community members found under this wallet",
    { showClaimable: true }
  );
  return tablePage("Community Info", rows, memberListColumns({ showClaimable: true }), { levelCounts: counts });
}

function tree() {
  return treeView("Team Tree", true);
}

function treeView(title, showSearch) {
  const root = state.treeRoot || state.account;
  const isOwnRoot = sameAddress(root, state.account);
  const members = isOwnRoot ? state.data.treeMembers || [] : state.previewMembers || [];
  const memberByAddress = new Map(members.map((member) => [member.address.toLowerCase(), member]));
  const rootInfo = isOwnRoot
    ? state.data.user
    : state.previewRootInfo || memberByAddress.get(root.toLowerCase())?.info;
  const rootTree = isOwnRoot ? state.data.tree : state.previewTree;

  const treeNode = (address, info, label, actionLabel, actionAddress = address) => {
    const empty   = !address;
    const rank    = info ? rankName(info.currentLevel) : "Level unknown";
    const directs = info ? Number(info.directCount || 0n) : 0;
    return `
      <article class="tree-node ${empty ? "is-empty" : ""}">
        <div class="tree-node-top">
          <span class="tree-avatar"></span>
          <span class="tree-side">${label}</span>
        </div>
        <strong>${empty ? "Empty Position" : shortAddress(address)}</strong>
        <div class="tree-meta">
          <span>${empty ? "No member here yet" : rank}</span>
          <span>${empty ? "Ready for next member" : `${directs} direct referrals`}</span>
        </div>
        <button ${empty ? "disabled" : `data-tree-address="${actionAddress}"`}>${actionLabel}</button>
      </article>
    `;
  };

  const childBranch = (parentTree, side) => {
    const childAddress = side === "Left" ? parentTree?.leftChild : parentTree?.rightChild;
    if (!childAddress || childAddress === ZERO) {
      return `<li>${treeNode("", null, side, "Empty")}</li>`;
    }

    const child = memberByAddress.get(childAddress.toLowerCase());
    return renderBranch(
      childAddress,
      child?.info || null,
      side,
      "Focus",
      childAddress,
      child?.tree || null
    );
  };

  const renderBranch = (address, info, label, actionLabel, actionAddress = address, treeInfo = null) => {
    const activeTree = treeInfo || memberByAddress.get(address.toLowerCase())?.tree;
    const hasLoadedChildren = Boolean(
      activeTree &&
      ((activeTree.leftChild && activeTree.leftChild !== ZERO) ||
       (activeTree.rightChild && activeTree.rightChild !== ZERO))
    );

    return `
      <li>
        ${treeNode(address, info, label, actionLabel, actionAddress)}
        ${hasLoadedChildren ? `
          <ul>
            ${childBranch(activeTree, "Left")}
            ${childBranch(activeTree, "Right")}
          </ul>
        ` : ""}
      </li>
    `;
  };

  const totalShown = members.length + (rootInfo?.isRegistered ? 1 : 0);
  const treeMarkup = rootInfo?.isRegistered
    ? `<ul class="tree-list">${renderBranch(
        root,
        rootInfo,
        isOwnRoot ? "Your Wallet" : "Selected Wallet",
        isOwnRoot ? "You are here" : "Back to My Wallet",
        isOwnRoot ? root : state.account,
        rootTree
      )}</ul>`
    : `<div class="tree-empty">No registered member found for this wallet.</div>`;

  return `
    <section class="community-tool">
      <div class="tree-header">
        <div>
          <p>This shows the binary Left and Right placement tree. Sponsor/upline is shown in Direct, My Team, and Community Info.</p>
          <h1>${title}</h1>
          <span class="tree-count">${totalShown} wallet${totalShown === 1 ? "" : "s"} shown</span>
        </div>
        ${showSearch ? `<form class="search-row" data-tree-search><input name="address" placeholder="Paste wallet address" value="${!isOwnRoot ? root : ""}"><button>Show Tree</button></form>` : ""}
      </div>
      <div class="tree-board">
        ${treeMarkup}
      </div>
    </section>
  `;
}

function renderApp() {
  if (!state.data) return shell(`<div class="center"><div class="status-line">Loading...</div></div>`);
  if (!state.data.user.isRegistered) return login();
  const views = { dashboard, directs, team: myTeam, community, tree };
  return shell(views[state.tab]());
}

function render() {
  if (!state.initialized) {
    app.innerHTML = `<div class="login-page"><div class="status-line">Starting Arvo...</div></div>`;
    return;
  }
  if (!state.account || !state.data || !state.data.user?.isRegistered) {
    app.innerHTML = login();
  } else {
    app.innerHTML = renderApp();
  }
}

app.addEventListener("click", async (event) => {
  const tab = event.target.closest("[data-tab]");
  if (tab) {
    state.tab = tab.dataset.tab;
    state.selectedDownlineLevel = 0;
    render();
    return;
  }

  const downlineLevel = event.target.closest("[data-downline-level]");
  if (downlineLevel) {
    state.selectedDownlineLevel = Number(downlineLevel.dataset.downlineLevel || 0);
    render();
    return;
  }

  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "connect")  await connect();
  if (action === "logout")   disconnect();
  if (action === "refresh")  await refresh();
  if (action === "withdraw") await withdraw();

  const copy = event.target.closest("[data-copy]");
  if (copy) {
    try {
      await copyText(copy.dataset.copy);
      setStatus("Copied.", "success");
    } catch (error) {
      setStatus("Copy failed. Select the text and copy manually.", "error");
    }
  }

  const treeButton = event.target.closest("[data-tree-address]");
  if (treeButton) {
    await loadTree(treeButton.dataset.treeAddress);
  }
});

app.addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-register-form]");
  if (form) {
    event.preventDefault();
    const referrer = new FormData(form).get("referrer");
    await approveAndRegister(referrer);
    return;
  }

  const search = event.target.closest("[data-tree-search]");
  if (search) {
    event.preventDefault();
    const address = new FormData(search).get("address");
    await loadTree(address);
  }
});

async function loadTree(address) {
  try {
    if (!ethers.isAddress(address)) throw new Error("Enter a valid wallet address.");
    const root = ethers.getAddress(address);
    state.treeRoot = root;

    if (sameAddress(root, state.account)) {
      state.previewTree = null;
      state.previewRootInfo = null;
      state.previewMembers = [];
      render();
      return;
    }

    const [info, tree] = await Promise.all([
      state.readMatrix.getUserInfo(root),
      state.readMatrix.getTreeInfo(root),
    ]);
    state.previewRootInfo = info;
    state.previewTree = tree;
    const [teamMembers, immediateTreeMembers, directReferrals] = await Promise.all([
      queryTeamFromContract(root, tree),
      queryImmediateTreeMembers(root, tree),
      state.readMatrix.getDirectReferrals(root).catch(() => []),
    ]);
    const directReferralMembers = await queryDirectReferralMembers(directReferrals, root, tree);
    state.previewMembers = normalizeSponsorTeamMembers(
      root,
      mergeTeamMembers(teamMembers, immediateTreeMembers, directReferralMembers)
    );
    render();
  } catch (error) {
    setStatus(normalizeError(error), "error");
  }
}

async function init() {
  try {
    validateConfig();
    makeReadContracts();
    state.initialized = true;
    render();
    if (localStorage.getItem(SESSION_KEY) === "1") await connect({ silent: true });
  } catch (error) {
    state.initialized = true;
    setStatus(normalizeError(error), "error");
    render();
  }
}

if (window.ethereum) {
  window.ethereum.on("accountsChanged", () => location.reload());
  window.ethereum.on("chainChanged",    () => location.reload());
}

init();

// PRJX LP Manager — Transaction Executor
const { ethers } = require('ethers');
const chain = require('./chain');
const config = require('./config');
const log = require('./logger');
const tg = require('./telegram');

// PRJX Swap Router (confirmed from on-chain tx history)
const SWAP_ROUTER_ADDRESS = '0x1ebdfc75ffe3ba3de61e7138a3e8706ac841af9b';
const SWAP_ROUTER_ABI = [
  'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function exactInput(tuple(bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
];

const MAX_UINT128 = 2n ** 128n - 1n;
const DEADLINE_BUFFER = 300; // 5 minutes

// Stablecoins that don't need swapping to USDT0
const STABLECOINS = ['usdc', 'usdt', 'dai', 'frax', 'lusd'];
function isStable(symbol) {
  return STABLECOINS.some(s => symbol.toLowerCase().includes(s));
}

function deadline() {
  return Math.floor(Date.now() / 1000) + DEADLINE_BUFFER;
}

function slippage(amount, bps = 50) {
  return (BigInt(amount) * BigInt(10000 - bps)) / 10000n;
}

// HyperEVM gas settings — use explicit gas price to avoid underpriced errors
async function gasOpts(extraGas = 0n, priceMult = 2n) {
  const provider = chain.getProvider();
  const feeData = await provider.getFeeData();
  // Use priceMult× the suggested gas price to ensure inclusion on HyperEVM
  const gasPrice = (feeData.gasPrice || 1_000_000_000n) * priceMult;
  return { gasPrice, gasLimit: 400_000n + extraGas };
}

// Wait a short time between sequential txns to avoid nonce collisions
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Send a transaction with automatic gas bump retries on REPLACEMENT_UNDERPRICED.
// fn receives a gas-opts object and must return a transaction promise.
async function sendTx(fn, extraGas = 0n) {
  const MAX_RETRIES = 3;
  let priceMult = 2n;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const opts = await gasOpts(extraGas, priceMult);
      return await fn(opts);
    } catch (err) {
      const isUnderpriced = err.code === 'REPLACEMENT_UNDERPRICED' ||
        err.info?.error?.code === -32603;
      if (isUnderpriced && attempt < MAX_RETRIES) {
        priceMult = priceMult * 13n / 10n; // bump ~30% each retry
        await sleep(1000);
        continue;
      }
      throw err;
    }
  }
}

// ── Collect Fees ──────────────────────────────────────────────────────────────
// Collects all accrued fees for a position.
// If claimAsUSDT is true, uses PRJX's multicall to swap to USDT0 after collecting.
async function collectFees(pos) {
  const pm = chain.getPositionManager();
  const wallet = chain.getSigner();

  console.log(`[#${pos.tokenId}] Collecting fees: $${pos.totalFeesUSD.toFixed(4)}...`);

  // Step 1: decreaseLiquidity(0) to push fees into tokensOwed
  // Then collect
  const collectParams = {
    tokenId: pos.tokenId,
    recipient: wallet.address,
    amount0Max: MAX_UINT128,
    amount1Max: MAX_UINT128,
  };

  let tx;
  try {
    tx = await sendTx(opts => pm.collect(collectParams, opts));
    await tx.wait();

    log.action(pos.tokenId, 'claim_fees', {
      pool: pos.poolAddress,
      token0: pos.sym0,
      token1: pos.sym1,
      amount0: pos.fees0Human.toFixed(6),
      amount1: pos.fees1Human.toFixed(6),
      usdValue: pos.totalFeesUSD,
      txHash: tx.hash,
      notes: 'Fees collected to wallet',
    });

    console.log(`[#${pos.tokenId}] ✅ Fees collected. tx: ${tx.hash}`);

    // Step 2: if USDT conversion requested, swap collected tokens to USDT0
    if (config.strategy.claimFeesAsUSDT) {
      await swapFeesToUSDT(pos);
    }

    return tx.hash;
  } catch (err) {
    console.error(`[#${pos.tokenId}] ❌ collectFees failed: ${err.message}`);
    throw err;
  }
}

// ── Swap fees to USDT0 ────────────────────────────────────────────────────────
// Uses PRJX Swap Router to convert collected token fees → USDT0
async function swapFeesToUSDT(pos) {
  const wallet = chain.getSigner();
  const usdt0 = config.tokens.USDT0.toLowerCase();
  const router = new ethers.Contract(SWAP_ROUTER_ADDRESS, SWAP_ROUTER_ABI, wallet);

  let totalUSDT = 0n;
  const txHashes = [];

  // Swap only non-stable, non-USDT0 tokens → USDT0
  // (USDC, USDT etc. are already stable — no swap needed, just keep them)
  const swapTargets = [
    { token: pos.token0, symbol: pos.sym0, decimals: pos.dec0 },
    { token: pos.token1, symbol: pos.sym1, decimals: pos.dec1 },
  ].filter(t => t.token.toLowerCase() !== usdt0 && !isStable(t.symbol));

  if (swapTargets.length === 0) {
    console.log(`[#${pos.tokenId}] Fees are already in stablecoins — no swap needed.`);
    return;
  }

  for (const { token, symbol, decimals } of swapTargets) {
    const tokenContract = chain.getToken(token);
    const bal = await tokenContract.balanceOf(wallet.address);
    if (bal === 0n) continue;

    const humanBal = ethers.formatUnits(bal, decimals);
    console.log(`[#${pos.tokenId}] Swapping ${humanBal} ${symbol} → USDT0...`);

    try {
      // Approve router
      const approveTx = await sendTx(opts => tokenContract.approve(SWAP_ROUTER_ADDRESS, bal, opts));
      await approveTx.wait();
      await sleep(2000); // brief pause before next tx to avoid nonce collision

      const tx = await sendTx(opts => router.exactInputSingle({
        tokenIn: token,
        tokenOut: config.tokens.USDT0,
        fee: pos.fee,
        recipient: wallet.address,
        deadline: deadline(),
        amountIn: bal,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      }, opts), 100_000n);

      const receipt = await tx.wait();

      // Parse amountOut from logs
      const iface = new ethers.Interface(['event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)']);
      let usdtOut = 0n;
      for (const log_ of receipt.logs) {
        try {
          const parsed = iface.parseLog(log_);
          if (parsed) {
            const a0 = parsed.args.amount0 < 0n ? -parsed.args.amount0 : parsed.args.amount0;
            const a1 = parsed.args.amount1 < 0n ? -parsed.args.amount1 : parsed.args.amount1;
            usdtOut = a0 > a1 ? a0 : a1;
          }
        } catch { /* skip */ }
      }

      totalUSDT += usdtOut;
      txHashes.push(tx.hash);

      const usdtHuman = Number(ethers.formatUnits(usdtOut, 6)).toFixed(4);
      console.log(`[#${pos.tokenId}] ✅ Swapped ${humanBal} ${symbol} → ${usdtHuman} USDT0. tx: ${tx.hash}`);

      log.action(pos.tokenId, 'swap_to_usdt', {
        token0: symbol, token1: 'USDT0',
        amount0: humanBal, amount1: usdtHuman,
        usdValue: Number(usdtHuman),
        txHash: tx.hash,
      });

    } catch (err) {
      console.error(`[#${pos.tokenId}] ❌ Swap ${symbol}→USDT0 failed: ${err.message}`);
      await tg.alertError(pos.tokenId, `swap ${symbol}→USDT0`, err.message);
    }
  }

  if (txHashes.length > 0) {
    const totalHuman = Number(ethers.formatUnits(totalUSDT, 6));
    await tg.alertSwappedToUSDT(pos, totalHuman, txHashes.join(', '));
  }
}

// ── Remove Liquidity ──────────────────────────────────────────────────────────
async function removeLiquidity(pos, percentToRemove = 100) {
  const pm = chain.getPositionManager();

  const liquidityToRemove = percentToRemove === 100
    ? pos.liquidity
    : (pos.liquidity * BigInt(percentToRemove)) / 100n;

  console.log(`[#${pos.tokenId}] Removing ${percentToRemove}% liquidity...`);

  try {
    // Estimate minimum amounts with slippage
    const decreaseParams = {
      tokenId: pos.tokenId,
      liquidity: liquidityToRemove,
      amount0Min: 0n, // conservative — let strategy handle slippage
      amount1Min: 0n,
      deadline: deadline(),
    };

    const tx = await sendTx(opts => pm.decreaseLiquidity(decreaseParams, opts), 100_000n);
    const receipt = await tx.wait();
    await sleep(2000);

    // Now collect the tokens out
    const collectTx = await sendTx(opts => pm.collect({
      tokenId: pos.tokenId,
      recipient: chain.getSigner().address,
      amount0Max: MAX_UINT128,
      amount1Max: MAX_UINT128,
    }, opts));
    await collectTx.wait();

    log.action(pos.tokenId, 'remove_liquidity', {
      pool: pos.poolAddress,
      token0: pos.sym0,
      token1: pos.sym1,
      usdValue: null,
      txHash: tx.hash,
      notes: `Removed ${percentToRemove}% liquidity. Collect tx: ${collectTx.hash}`,
    });

    console.log(`[#${pos.tokenId}] ✅ Liquidity removed. tx: ${tx.hash}`);
    return { removeTx: tx.hash, collectTx: collectTx.hash };
  } catch (err) {
    console.error(`[#${pos.tokenId}] ❌ removeLiquidity failed: ${err.message}`);
    throw err;
  }
}

// ── Add Liquidity (mint new position) ────────────────────────────────────────
// Creates a new position centered on current price ± rangePercent
async function mintNewPosition(pos, currentPrice, rangePercent) {
  const pm = chain.getPositionManager();
  const wallet = chain.getSigner();

  // Calculate new tick range based on current price ± rangePercent
  const lowerPrice = currentPrice * (1 - rangePercent / 100);
  const upperPrice = currentPrice * (1 + rangePercent / 100);

  // Convert prices to ticks (Uniswap V3 formula)
  // tick = log(price) / log(1.0001), adjusted for decimals
  const adjustedLower = lowerPrice * (10 ** pos.dec1) / (10 ** pos.dec0);
  const adjustedUpper = upperPrice * (10 ** pos.dec1) / (10 ** pos.dec0);

  let tickLower = Math.floor(Math.log(adjustedLower) / Math.log(1.0001));
  let tickUpper = Math.ceil(Math.log(adjustedUpper) / Math.log(1.0001));

  // Round to nearest tick spacing (typically 60 for 0.3% pools, 10 for 0.05%)
  const tickSpacing = pos.fee === 500 ? 10 : pos.fee === 3000 ? 60 : 200;
  tickLower = Math.floor(tickLower / tickSpacing) * tickSpacing;
  tickUpper = Math.ceil(tickUpper / tickSpacing) * tickSpacing;

  // Get available token balances
  const t0 = chain.getToken(pos.token0);
  const t1 = chain.getToken(pos.token1);
  const [bal0, bal1] = await Promise.all([
    t0.balanceOf(wallet.address),
    t1.balanceOf(wallet.address),
  ]);

  console.log(`[#${pos.tokenId}] Minting new position: ticks ${tickLower} → ${tickUpper} (price ${lowerPrice.toFixed(6)} → ${upperPrice.toFixed(6)})`);
  console.log(`[#${pos.tokenId}] Available: ${ethers.formatUnits(bal0, pos.dec0)} ${pos.sym0}, ${ethers.formatUnits(bal1, pos.dec1)} ${pos.sym1}`);

  try {
    // Approve position manager to spend tokens
    const ap0 = await sendTx(opts => t0.approve(config.contracts.positionManager, bal0, opts));
    await ap0.wait();
    await sleep(2000);
    const ap1 = await sendTx(opts => t1.approve(config.contracts.positionManager, bal1, opts));
    await ap1.wait();
    await sleep(2000);

    const mintParams = {
      token0: pos.token0,
      token1: pos.token1,
      fee: pos.fee,
      tickLower,
      tickUpper,
      amount0Desired: bal0,
      amount1Desired: bal1,
      amount0Min: slippage(bal0),
      amount1Min: slippage(bal1),
      recipient: wallet.address,
      deadline: deadline(),
    };

    const tx = await sendTx(opts => pm.mint(mintParams, opts), 200_000n);
    const receipt = await tx.wait();

    log.action(pos.tokenId, 'add_liquidity', {
      pool: pos.poolAddress,
      token0: pos.sym0,
      token1: pos.sym1,
      txHash: tx.hash,
      notes: `New position minted. Ticks: ${tickLower} → ${tickUpper}`,
    });

    console.log(`[#${pos.tokenId}] ✅ New position minted. tx: ${tx.hash}`);
    return tx.hash;
  } catch (err) {
    console.error(`[#${pos.tokenId}] ❌ mintNewPosition failed: ${err.message}`);
    throw err;
  }
}

// ── Full Rebalance ────────────────────────────────────────────────────────────
async function rebalance(pos) {
  console.log(`[#${pos.tokenId}] 🔄 Starting rebalance...`);
  try {
    // 1. Remove all liquidity
    await removeLiquidity(pos, 100);

    // 2. Mint new position at current price ± rangePercent
    await mintNewPosition(pos, pos.currentPrice, config.strategy.rebalanceRangePercent);

    log.action(pos.tokenId, 'rebalance', {
      pool: pos.poolAddress,
      token0: pos.sym0,
      token1: pos.sym1,
      notes: `Rebalanced at price ${pos.currentPrice.toFixed(6)}. New range ±${config.strategy.rebalanceRangePercent}%`,
    });
  } catch (err) {
    console.error(`[#${pos.tokenId}] ❌ Rebalance failed: ${err.message}`);
  }
}

module.exports = { collectFees, removeLiquidity, mintNewPosition, rebalance };

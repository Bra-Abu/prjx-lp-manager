// PRJX LP Manager — Position Reader
const { ethers } = require('ethers');
const axios = require('axios');
const chain = require('./chain');
const config = require('./config');

const Q128 = 2n ** 128n;

let _factoryAddress = null;

async function getFactoryAddress() {
  if (_factoryAddress) return _factoryAddress;
  const pm = chain.getPositionManager(true); // read-only
  _factoryAddress = await pm.factory();
  return _factoryAddress;
}

// Fetch USD price of a token via CoinGecko
const priceCache = {};
async function getTokenPriceUSD(symbol) {
  if (priceCache[symbol] && Date.now() - priceCache[symbol].ts < 60_000) {
    return priceCache[symbol].price;
  }
  try {
    const ids = {
      HYPE: 'hyperliquid', WHYPE: 'hyperliquid',
      USDC: '1', USDT0: '1', USDT: '1',
    };
    const id = ids[symbol.toUpperCase()];
    if (!id) return 1;
    if (id === '1') { priceCache[symbol] = { price: 1, ts: Date.now() }; return 1; }

    const res = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
      { timeout: 5000 }
    );
    const price = res.data[id]?.usd || 0;
    priceCache[symbol] = { price, ts: Date.now() };
    return price;
  } catch {
    return priceCache[symbol]?.price || 0;
  }
}

// ── Uniswap V3 Fee Accrual Calculation ────────────────────────────────────────
// Fees = liquidity × (feeGrowthInside - feeGrowthInsideLast) / 2^128
// feeGrowthInside = feeGrowthGlobal - feeGrowthBelow - feeGrowthAbove
// feeGrowthBelow/Above are derived from each tick's feeGrowthOutside values.

function subIn256(a, b) {
  // Handles uint256 underflow (wraps around)
  return a >= b ? a - b : (2n ** 256n) + a - b;
}

async function calcUnclaimedFees(pool, pos, currentTick) {
  const {
    tickLower, tickUpper, liquidity,
    feeGrowthInside0LastX128, feeGrowthInside1LastX128,
    tokensOwed0, tokensOwed1,
  } = pos;

  const liq = BigInt(liquidity.toString());
  if (liq === 0n) return { fees0: 0n, fees1: 0n };

  // Fetch global fee growth and per-tick data in parallel
  const [
    feeGrowthGlobal0, feeGrowthGlobal1,
    lowerTick, upperTick,
  ] = await Promise.all([
    pool.feeGrowthGlobal0X128(),
    pool.feeGrowthGlobal1X128(),
    pool.ticks(tickLower),
    pool.ticks(tickUpper),
  ]);

  const fg0 = BigInt(feeGrowthGlobal0.toString());
  const fg1 = BigInt(feeGrowthGlobal1.toString());
  const lo0 = BigInt(lowerTick.feeGrowthOutside0X128.toString());
  const lo1 = BigInt(lowerTick.feeGrowthOutside1X128.toString());
  const hi0 = BigInt(upperTick.feeGrowthOutside0X128.toString());
  const hi1 = BigInt(upperTick.feeGrowthOutside1X128.toString());
  const tick = Number(currentTick);

  // feeGrowthBelow: if current tick >= tickLower, use outside values directly
  const fgBelow0 = tick >= Number(tickLower) ? lo0 : subIn256(fg0, lo0);
  const fgBelow1 = tick >= Number(tickLower) ? lo1 : subIn256(fg1, lo1);

  // feeGrowthAbove: if current tick < tickUpper, use outside values directly
  const fgAbove0 = tick < Number(tickUpper) ? hi0 : subIn256(fg0, hi0);
  const fgAbove1 = tick < Number(tickUpper) ? hi1 : subIn256(fg1, hi1);

  // feeGrowthInside = global - below - above
  const fgInside0 = subIn256(subIn256(fg0, fgBelow0), fgAbove0);
  const fgInside1 = subIn256(subIn256(fg1, fgBelow1), fgAbove1);

  const last0 = BigInt(feeGrowthInside0LastX128.toString());
  const last1 = BigInt(feeGrowthInside1LastX128.toString());

  // Uncollected = liquidity × (feeGrowthInside - last) / 2^128 + tokensOwed
  const uncollected0 = (liq * subIn256(fgInside0, last0)) / Q128 + BigInt(tokensOwed0.toString());
  const uncollected1 = (liq * subIn256(fgInside1, last1)) / Q128 + BigInt(tokensOwed1.toString());

  return { fees0: uncollected0, fees1: uncollected1 };
}

// ── Read full on-chain state of a position ─────────────────────────────────────
async function readPosition(tokenId) {
  const pm = chain.getPositionManager(true);
  const factoryAddr = await getFactoryAddress();

  // Raw position data
  const pos = await pm.positions(tokenId);
  const { token0, token1, fee, tickLower, tickUpper, liquidity } = pos;

  // Token metadata
  const t0 = chain.getToken(token0, true);
  const t1 = chain.getToken(token1, true);
  const [sym0, dec0, sym1, dec1] = await Promise.all([
    t0.symbol(), t0.decimals(), t1.symbol(), t1.decimals()
  ]);

  // Pool address + current state
  const factory = chain.getFactory(factoryAddr);
  const [tA, tB] = token0.toLowerCase() < token1.toLowerCase()
    ? [token0, token1] : [token1, token0];
  const poolAddress = await factory.getPool(tA, tB, fee);
  const pool = chain.getPool(poolAddress);
  const slot0 = await pool.slot0();
  const currentTick = Number(slot0.tick);

  // In-range check
  const inRange = currentTick >= Number(tickLower) && currentTick <= Number(tickUpper);

  // Prices
  const currentPrice = chain.tickToPrice(currentTick, Number(dec0), Number(dec1));
  const lowerPrice   = chain.tickToPrice(Number(tickLower), Number(dec0), Number(dec1));
  const upperPrice   = chain.tickToPrice(Number(tickUpper), Number(dec0), Number(dec1));

  // USD prices
  const [price0USD, price1USD] = await Promise.all([
    getTokenPriceUSD(sym0),
    getTokenPriceUSD(sym1),
  ]);

  // ── Real uncollected fee calculation ────────────────────────────────────────
  const { fees0: raw0, fees1: raw1 } = await calcUnclaimedFees(pool, pos, currentTick);
  const fees0Human = Number(ethers.formatUnits(raw0, Number(dec0)));
  const fees1Human = Number(ethers.formatUnits(raw1, Number(dec1)));
  const fees0USD   = fees0Human * price0USD;
  const fees1USD   = fees1Human * price1USD;
  const totalFeesUSD = fees0USD + fees1USD;

  // Distance from boundaries
  const distToLower = ((currentPrice - lowerPrice) / currentPrice) * 100;
  const distToUpper = ((upperPrice - currentPrice) / currentPrice) * 100;

  return {
    tokenId,
    token0, token1,
    sym0, sym1,
    dec0: Number(dec0), dec1: Number(dec1),
    fee: Number(fee),
    tickLower: Number(tickLower),
    tickUpper: Number(tickUpper),
    currentTick,
    liquidity,
    inRange,
    poolAddress,
    currentPrice,
    lowerPrice,
    upperPrice,
    distToLower,
    distToUpper,
    fees0Raw: raw0,
    fees1Raw: raw1,
    fees0Human,
    fees1Human,
    fees0USD,
    fees1USD,
    totalFeesUSD,
    price0USD,
    price1USD,
  };
}

// Read all positions
async function readAllPositions() {
  const results = [];
  for (const id of config.positionIds) {
    try {
      const pos = await readPosition(id);
      results.push(pos);
    } catch (err) {
      console.error(`[#${id}] Failed to read position: ${err.message}`);
    }
  }
  return results;
}

// Human-readable console summary
function printPositionSummary(pos) {
  const rangeStr = pos.inRange ? '✅ IN RANGE' : '❌ OUT OF RANGE';
  const feeAlert = pos.distToLower <= 5 ? ' ⚠️  NEAR LOWER' : pos.distToUpper <= 5 ? ' ⚠️  NEAR UPPER' : '';
  console.log(`
┌─────────────────────────────────────────────────────┐
│ Position #${pos.tokenId} — ${pos.sym0}/${pos.sym1} (${pos.fee / 10000}% fee)
│ Status    : ${rangeStr}${feeAlert}
│ Price     : ${pos.currentPrice.toFixed(4)} ${pos.sym1}/${pos.sym0}
│ Range     : ${pos.lowerPrice.toFixed(4)} → ${pos.upperPrice.toFixed(4)}
│ To lower  : ${pos.distToLower.toFixed(2)}%  |  To upper: ${pos.distToUpper.toFixed(2)}%
│ Fees      : $${pos.totalFeesUSD.toFixed(4)}
│             ${pos.fees0Human.toFixed(6)} ${pos.sym0} ($${pos.fees0USD.toFixed(4)})
│             ${pos.fees1Human.toFixed(6)} ${pos.sym1} ($${pos.fees1USD.toFixed(4)})
└─────────────────────────────────────────────────────┘`);
}

module.exports = { readPosition, readAllPositions, printPositionSummary, getTokenPriceUSD };

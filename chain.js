// PRJX LP Manager — Chain Connection (HyperEVM)
const { ethers } = require('ethers');
const config = require('./config');

let _provider = null;
let _signer = null;

function getProvider() {
  if (!_provider) {
    _provider = new ethers.JsonRpcProvider(config.rpcUrl, {
      chainId: config.chainId,
      name: 'hyperevm',
    });
  }
  return _provider;
}

function getSigner() {
  if (!_signer) {
    if (!config.privateKey) throw new Error('PRIVATE_KEY not set in .env');
    _signer = new ethers.Wallet(config.privateKey, getProvider());
  }
  return _signer;
}

// Minimal ERC20 ABI for token info + allowance
const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

// Uniswap V3 Pool ABI (minimal)
const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function liquidity() view returns (uint128)',
  'function tickSpacing() view returns (int24)',
  'function feeGrowthGlobal0X128() view returns (uint256)',
  'function feeGrowthGlobal1X128() view returns (uint256)',
  'function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)',
];

// Uniswap V3 NonfungiblePositionManager ABI (minimal)
const POSITION_MANAGER_ABI = [
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) returns (uint256 amount0, uint256 amount1)',
  'function decreaseLiquidity(tuple(uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) returns (uint256 amount0, uint256 amount1)',
  'function increaseLiquidity(tuple(uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) returns (uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) returns (uint128 liquidity, uint256 amount0, uint256 amount1, uint256 tokenId)',
  'function multicall(bytes[] calldata data) payable returns (bytes[] memory results)',
  'function sweepToken(address token, uint256 amountMinimum, address recipient)',
  'function refundETH()',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function factory() view returns (address)',
];

// Uniswap V3 Factory ABI (minimal)
const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
];

function getPositionManager(readOnly = false) {
  return new ethers.Contract(
    config.contracts.positionManager,
    POSITION_MANAGER_ABI,
    readOnly ? getProvider() : getSigner()
  );
}

function getPool(poolAddress) {
  return new ethers.Contract(poolAddress, POOL_ABI, getProvider());
}

function getToken(tokenAddress, readOnly = false) {
  return new ethers.Contract(tokenAddress, ERC20_ABI, readOnly ? getProvider() : getSigner());
}

function getFactory(factoryAddress) {
  return new ethers.Contract(factoryAddress, FACTORY_ABI, getProvider());
}

// Compute pool address from factory (Uniswap V3 CREATE2)
async function getPoolAddress(factoryAddress, token0, token1, fee) {
  const factory = getFactory(factoryAddress);
  // Sort tokens
  const [t0, t1] = token0.toLowerCase() < token1.toLowerCase()
    ? [token0, token1] : [token1, token0];
  return factory.getPool(t0, t1, fee);
}

// Convert sqrt price to human-readable price (token1 per token0)
function sqrtPriceX96ToPrice(sqrtPriceX96, decimals0, decimals1) {
  const Q96 = 2n ** 96n;
  const price = (BigInt(sqrtPriceX96) * BigInt(sqrtPriceX96) * 10n ** BigInt(decimals0)) /
    (Q96 * Q96 * 10n ** BigInt(decimals1));
  return Number(price);
}

// Convert tick to price
function tickToPrice(tick, decimals0, decimals1) {
  const price = 1.0001 ** tick;
  return price * (10 ** decimals0) / (10 ** decimals1);
}

module.exports = {
  getProvider,
  getSigner,
  getPositionManager,
  getPool,
  getToken,
  getFactory,
  getPoolAddress,
  sqrtPriceX96ToPrice,
  tickToPrice,
  POOL_ABI,
  ERC20_ABI,
};

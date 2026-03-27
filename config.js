// PRJX LP Manager — Configuration
require('dotenv').config();

module.exports = {
  // ── Chain ──────────────────────────────────────────────────────────────────
  rpcUrl: process.env.RPC_URL || 'https://rpc.hyperliquid.xyz/evm',
  chainId: 999, // HyperEVM mainnet

  // ── Wallet ─────────────────────────────────────────────────────────────────
  walletAddress: process.env.WALLET_ADDRESS,
  privateKey: process.env.PRIVATE_KEY, // loaded from .env — never hardcoded

  // ── PRJX Contracts (Uniswap V3 fork on HyperEVM) ──────────────────────────
  contracts: {
    positionManager: '0xead19ae861c29bbb2101e834922b2feee69b9091',
    // Factory and router discovered at runtime from position data
  },

  // ── Your LP Positions ──────────────────────────────────────────────────────
  positionIds: [398822, 398814, 399396],

  // ── Strategy Parameters ────────────────────────────────────────────────────
  strategy: {
    // Fee claiming
    feeClaimThresholdUSD: 10,         // claim when accrued fees > $10
    feeClaimIntervalHours: 24,        // also claim every 24hrs regardless of amount
    claimFeesAsUSDT: true,            // convert claimed fees to USDT0 on PRJX

    // Range management
    rebalanceRangePercent: 20,        // new range = current price ± 20%
    warningZonePercent: 5,            // alert when price within 5% of range boundary
    outOfRangeAction: 'rebalance',    // 'rebalance' | 'remove' | 'alert-only'

    // Volatility protection
    maxRebalancesPerDay: 3,           // if > 3 rebalances needed in 24hrs → pull position
    volatilityPullThreshold: 3,       // pull entirely after this many out-of-range events/24hr

    // Slippage
    slippagePercent: 0.5,             // 0.5% slippage tolerance on txns
  },

  // ── Monitoring ─────────────────────────────────────────────────────────────
  monitorIntervalMinutes: 5,          // check positions every 5 minutes

  // ── Token addresses on HyperEVM ───────────────────────────────────────────
  tokens: {
    USDT0: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625EB1', // USDT0 on HyperEVM
    WHYPE: '0x5555555555555555555555555555555555555555', // confirmed on-chain (HYPE's vanity address)
  },
};

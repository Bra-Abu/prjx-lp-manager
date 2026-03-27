// PRJX LP Manager — Main Entry Point
require('dotenv').config();

const cron = require('node-cron');
const config = require('./config');
const { readAllPositions, printPositionSummary } = require('./position');
const { runStrategy } = require('./strategy');
const log = require('./logger');
const tg = require('./telegram');

let isRunning = false;

// ── Single Monitor Cycle ───────────────────────────────────────────────────────
async function runCycle() {
  if (isRunning) {
    console.log('[Monitor] Previous cycle still running — skipping.');
    return;
  }
  isRunning = true;
  const now = new Date().toISOString();
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  PRJX LP Manager — Cycle @ ${now}`);
  console.log(`${'═'.repeat(60)}`);

  try {
    // 1. Read all positions from chain
    const positions = await readAllPositions();

    if (positions.length === 0) {
      console.log('[Monitor] No positions found or all failed to read.');
      return;
    }

    // 2. Print summary for each
    for (const pos of positions) {
      printPositionSummary(pos);
      log.snapshot(pos.tokenId, {
        tickLower: pos.tickLower,
        tickUpper: pos.tickUpper,
        currentTick: pos.currentTick,
        inRange: pos.inRange,
        liquidity: pos.liquidity,
        fees0Usd: pos.fees0USD,
        fees1Usd: pos.fees1USD,
      });
    }

    // 3. Run strategy decisions
    await runStrategy(positions);

  } catch (err) {
    console.error('[Monitor] Cycle error:', err.message);
  } finally {
    isRunning = false;
  }
}

// ── Startup Checks ─────────────────────────────────────────────────────────────
function validateConfig() {
  if (!process.env.PRIVATE_KEY) {
    console.error('❌ PRIVATE_KEY not set in .env file. Cannot execute transactions.');
    console.error('   Copy .env.example → .env and fill in your private key.');
    process.exit(1);
  }
  if (!config.positionIds.length) {
    console.error('❌ No position IDs configured.');
    process.exit(1);
  }
  console.log(`✅ Config OK. Managing ${config.positionIds.length} positions: #${config.positionIds.join(', #')}`);
  console.log(`✅ Chain: HyperEVM (Chain ID: ${config.chainId}), RPC: ${config.rpcUrl}`);
  console.log(`✅ Fee claim threshold: $${config.strategy.feeClaimThresholdUSD}`);
  console.log(`✅ Rebalance range: ±${config.strategy.rebalanceRangePercent}%`);
  console.log(`✅ Monitor interval: every ${config.monitorIntervalMinutes} minutes\n`);
}

// ── Start ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🚀 PRJX LP Manager starting...');
  validateConfig();

  // Start Telegram command listener (/status /fees /history)
  tg.startCommandListener(readAllPositions, log.getHistory);

  // Notify Telegram on startup
  await tg.alertStartup(config.positionIds);

  // Run immediately on startup
  await runCycle();

  // Then schedule on cron interval
  const cronExpr = `*/${config.monitorIntervalMinutes} * * * *`;
  console.log(`\n⏰ Scheduler started: ${cronExpr}`);

  cron.schedule(cronExpr, runCycle);
}

// ── CLI Flags ─────────────────────────────────────────────────────────────────
const arg = process.argv[2];

if (arg === '--history') {
  const history = log.getHistory(30);
  console.table(history);
  process.exit(0);
}

if (arg === '--monitor') {
  // Read-only mode: print position state, no transactions
  (async () => {
    console.log('\n👁️  MONITOR MODE (read-only, no transactions)\n');
    const { readAllPositions, printPositionSummary } = require('./position');
    const positions = await readAllPositions();
    for (const pos of positions) printPositionSummary(pos);
    process.exit(0);
  })().catch(err => { console.error(err.message); process.exit(1); });
} else {
  main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

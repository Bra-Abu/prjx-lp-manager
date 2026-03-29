// PRJX LP Manager — Strategy Engine
// Acts as an expert DeFi liquidity farmer: decides WHEN to claim, rebalance, or pull.

const config = require('./config');
const log = require('./logger');
const executor = require('./executor');
const tg = require('./telegram');

// ── Decision Engine ────────────────────────────────────────────────────────────
async function evaluatePosition(pos) {
  const { tokenId, inRange, totalFeesUSD, distToLower, distToUpper, sym0, sym1 } = pos;
  const { feeClaimThresholdUSD, feeClaimIntervalHours, warningZonePercent,
    volatilityPullThreshold, outOfRangeAction } = config.strategy;

  const decisions = [];

  // ── 1. Fee Claim Check ──────────────────────────────────────────────────────
  const shouldClaimByAmount = totalFeesUSD >= feeClaimThresholdUSD;

  const lastClaim = log.getLastClaimTime(tokenId);
  const hoursSinceLastClaim = lastClaim
    ? (Date.now() - lastClaim.getTime()) / (1000 * 60 * 60)
    : Infinity;
  const shouldClaimByTime = hoursSinceLastClaim >= feeClaimIntervalHours;

  if (shouldClaimByAmount) {
    decisions.push({
      action: 'claim_fees',
      reason: `Fees $${totalFeesUSD.toFixed(4)} exceeded $${feeClaimThresholdUSD} threshold`,
      priority: 1,
    });
  } else if (shouldClaimByTime && totalFeesUSD > 0.01) {
    decisions.push({
      action: 'claim_fees',
      reason: `${hoursSinceLastClaim.toFixed(1)}hrs since last claim (interval: ${feeClaimIntervalHours}hrs)`,
      priority: 2,
    });
  }

  // ── 2. Range Status Check ──────────────────────────────────────────────────
  if (!inRange) {
    const rebalancesLast24h = log.getRebalanceCount(tokenId, 24);

    if (rebalancesLast24h >= volatilityPullThreshold) {
      // Too many rebalances → market is too volatile → pull entirely
      decisions.push({
        action: 'pull',
        reason: `${rebalancesLast24h} rebalances in 24hrs — market too volatile. Pulling position.`,
        priority: 0, // highest priority
      });
    } else {
      decisions.push({
        action: outOfRangeAction,
        reason: `Price out of range. ${rebalancesLast24h} rebalances today.`,
        priority: 1,
      });
    }
  } else {
    // In range — check if approaching boundary (warning zone)
    const nearLower = distToLower <= warningZonePercent;
    const nearUpper = distToUpper <= warningZonePercent;

    if (nearLower) {
      console.log(`[#${tokenId}] ⚠️  WARNING: Price ${distToLower.toFixed(2)}% from LOWER boundary (${sym0}/${sym1})`);
      await tg.alertNearBoundary(pos, 'lower');
    }
    if (nearUpper) {
      console.log(`[#${tokenId}] ⚠️  WARNING: Price ${distToUpper.toFixed(2)}% from UPPER boundary (${sym0}/${sym1})`);
      await tg.alertNearBoundary(pos, 'upper');
    }
  }

  return decisions.sort((a, b) => a.priority - b.priority);
}

// ── Execute Decisions ──────────────────────────────────────────────────────────
async function executeDecisions(pos, decisions) {
  for (const decision of decisions) {
    console.log(`[#${pos.tokenId}] 📋 Decision: ${decision.action.toUpperCase()} — ${decision.reason}`);

    switch (decision.action) {
      case 'claim_fees':
        await tg.alertFeesAvailable(pos);
        console.log(`[#${pos.tokenId}] 💰 Fees available: $${pos.totalFeesUSD.toFixed(4)} — notified via Telegram.`);
        break;

      case 'rebalance':
        await tg.alertOutOfRange(pos);
        try {
          await executor.rebalance(pos);
          await tg.alertRebalanced(pos, 'see logs');
        } catch (e) {
          await tg.alertError(pos.tokenId, 'rebalance', e.message);
        }
        break;

      case 'remove':
        try {
          await executor.removeLiquidity(pos, 100);
        } catch (e) {
          await tg.alertError(pos.tokenId, 'remove_liquidity', e.message);
        }
        break;

      case 'pull':
        console.log(`[#${pos.tokenId}] 🛑 PULLING position — removing all liquidity without re-adding.`);
        try {
          await executor.removeLiquidity(pos, 100);
          log.action(pos.tokenId, 'pull_position', { pool: pos.poolAddress, notes: decision.reason });
          await tg.alertPulled(pos, decision.reason);
        } catch (e) {
          await tg.alertError(pos.tokenId, 'pull', e.message);
        }
        break;

      case 'alert-only':
        console.log(`[#${pos.tokenId}] 🔔 ALERT: Position out of range. Monitoring only.`);
        log.action(pos.tokenId, 'out_of_range_alert', { pool: pos.poolAddress, notes: decision.reason });
        await tg.alertOutOfRange(pos);
        break;
    }
  }
}

// ── Main Strategy Run ─────────────────────────────────────────────────────────
async function runStrategy(positions) {
  for (const pos of positions) {
    const decisions = await evaluatePosition(pos);
    if (decisions.length === 0) {
      console.log(`[#${pos.tokenId}] ✓ No action needed. In range: ${pos.inRange}, Fees: $${pos.totalFeesUSD.toFixed(4)}`);
    } else {
      await executeDecisions(pos, decisions);
    }
  }
}

module.exports = { runStrategy, evaluatePosition };

// PRJX LP Manager — Telegram Alerts + Interactive Commands
const TelegramBot = require('node-telegram-bot-api');

let _bot = null;
let _chatId = null;

// Injected at startup so commands can trigger live reads
let _getPositions = null;
let _getHistory = null;

function isConfigured() {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

function getBot() {
  if (!_bot && isConfigured()) {
    _bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
    _chatId = process.env.TELEGRAM_CHAT_ID;
  }
  return _bot;
}

async function send(message, silent = false) {
  const bot = getBot();
  if (!bot) return; // Telegram not configured — silent skip
  try {
    await bot.sendMessage(_chatId, message, {
      parse_mode: 'HTML',
      disable_notification: silent,
    });
  } catch (err) {
    console.error('[Telegram] Failed to send message:', err.message);
  }
}

// ── Alert Templates ────────────────────────────────────────────────────────────

function alertFeesCollected(pos, usdValue, txHash) {
  return send(
    `💰 <b>Fees Collected — #${pos.tokenId}</b>\n` +
    `Pool: ${pos.sym0}/${pos.sym1}\n` +
    `Amount: <b>$${usdValue.toFixed(4)}</b>\n` +
    `(${pos.fees0Human.toFixed(6)} ${pos.sym0} + ${pos.fees1Human.toFixed(6)} ${pos.sym1})\n` +
    `Converted to: USDT0\n` +
    `Tx: <code>${txHash}</code>`
  );
}

function alertOutOfRange(pos) {
  return send(
    `⚠️ <b>OUT OF RANGE — #${pos.tokenId}</b>\n` +
    `Pool: ${pos.sym0}/${pos.sym1}\n` +
    `Current price: <b>${pos.currentPrice.toFixed(4)}</b>\n` +
    `Range: ${pos.lowerPrice.toFixed(4)} → ${pos.upperPrice.toFixed(4)}\n` +
    `Action: Rebalancing...`
  );
}

function alertRebalanced(pos, txHash) {
  return send(
    `🔄 <b>Rebalanced — #${pos.tokenId}</b>\n` +
    `Pool: ${pos.sym0}/${pos.sym1}\n` +
    `New range: ±${require('./config').strategy.rebalanceRangePercent}% from $${pos.currentPrice.toFixed(4)}\n` +
    `Tx: <code>${txHash}</code>`
  );
}

function alertNearBoundary(pos, side) {
  const pct = side === 'lower' ? pos.distToLower : pos.distToUpper;
  return send(
    `🔔 <b>Near ${side.toUpperCase()} boundary — #${pos.tokenId}</b>\n` +
    `Pool: ${pos.sym0}/${pos.sym1}\n` +
    `Price: ${pos.currentPrice.toFixed(4)} | ${side} boundary: ${side === 'lower' ? pos.lowerPrice.toFixed(4) : pos.upperPrice.toFixed(4)}\n` +
    `Distance: <b>${pct.toFixed(2)}%</b>`,
    true // silent — informational only
  );
}

function alertPulled(pos, reason) {
  return send(
    `🛑 <b>Position PULLED — #${pos.tokenId}</b>\n` +
    `Pool: ${pos.sym0}/${pos.sym1}\n` +
    `Reason: ${reason}\n` +
    `All liquidity removed. Monitor market before re-entering.`
  );
}

function alertSwappedToUSDT(pos, usdtAmount, txHash) {
  return send(
    `💵 <b>Fees → USDT0 — #${pos.tokenId}</b>\n` +
    `Received: <b>${usdtAmount.toFixed(4)} USDT0</b>\n` +
    `Tx: <code>${txHash}</code>`
  );
}

function alertFeesAvailable(pos) {
  return send(
    `💰 <b>Fees Ready — #${pos.tokenId}</b>\n` +
    `Pool: ${pos.sym0}/${pos.sym1}\n` +
    `Unclaimed: <b>$${pos.totalFeesUSD.toFixed(4)}</b>\n` +
    `(${pos.fees0Human.toFixed(6)} ${pos.sym0} + ${pos.fees1Human.toFixed(6)} ${pos.sym1})`
  );
}

function alertError(positionId, action, error) {
  return send(
    `❌ <b>Error — #${positionId}</b>\n` +
    `Action: ${action}\n` +
    `Error: ${error}`
  );
}

function alertStartup(positionIds) {
  return send(
    `🚀 <b>PRJX LP Manager started</b>\n` +
    `Managing positions: ${positionIds.map(id => '#' + id).join(', ')}\n` +
    `Monitoring every 5 minutes.\n\n` +
    `Commands:\n` +
    `/status — live position status\n` +
    `/fees — accrued fees summary\n` +
    `/weekly — fees claimed this week\n` +
    `/monthly — fees claimed this month\n` +
    `/alltime — total fees ever claimed\n` +
    `/history — last 10 actions`
  );
}

// ── Register "/" command menu with Telegram ────────────────────────────────────
async function registerCommands() {
  const bot = getBot();
  if (!bot) return;
  try {
    await bot.setMyCommands([
      { command: 'status',  description: 'Live position status & fees' },
      { command: 'fees',    description: 'Accrued fees across all positions' },
      { command: 'weekly',  description: 'Fees claimed in the last 7 days' },
      { command: 'monthly', description: 'Fees claimed in the last 30 days' },
      { command: 'alltime', description: 'Total fees claimed all time' },
      { command: 'history', description: 'Last 10 bot actions' },
    ]);
    console.log('[Telegram] Commands registered (/ menu active).');
  } catch (err) {
    console.error('[Telegram] Failed to register commands:', err.message);
  }
}

// ── Interactive Command Listener ───────────────────────────────────────────────
function startCommandListener(getPositionsFn, getHistoryFn) {
  if (!isConfigured()) return;
  _getPositions = getPositionsFn;
  _getHistory = getHistoryFn;

  const bot = getBot();
  if (!bot) return;

  // /status — full position snapshot
  bot.onText(/\/status/, async (msg) => {
    if (String(msg.chat.id) !== String(_chatId)) return;
    await send('🔄 Fetching live positions...');
    try {
      const positions = await _getPositions();
      for (const pos of positions) {
        const rangeIcon = pos.inRange ? '✅' : '❌';
        const warn = pos.distToLower <= 5 ? '\n⚠️ <b>NEAR LOWER boundary!</b>' : pos.distToUpper <= 5 ? '\n⚠️ <b>NEAR UPPER boundary!</b>' : '';
        await send(
          `${rangeIcon} <b>#${pos.tokenId} — ${pos.sym0}/${pos.sym1}</b>${warn}\n` +
          `Price  : <b>$${pos.currentPrice.toFixed(4)}</b>\n` +
          `Range  : $${pos.lowerPrice.toFixed(4)} → $${pos.upperPrice.toFixed(4)}\n` +
          `To lower: ${pos.distToLower.toFixed(2)}%  |  To upper: ${pos.distToUpper.toFixed(2)}%\n` +
          `Fees   : <b>$${pos.totalFeesUSD.toFixed(4)}</b>\n` +
          `         ${pos.fees0Human.toFixed(6)} ${pos.sym0} + ${pos.fees1Human.toFixed(6)} ${pos.sym1}`
        );
      }
    } catch (e) {
      await send('❌ Failed to fetch positions: ' + e.message);
    }
  });

  // /fees — fees summary across all positions
  bot.onText(/\/fees/, async (msg) => {
    if (String(msg.chat.id) !== String(_chatId)) return;
    await send('🔄 Fetching fees...');
    try {
      const positions = await _getPositions();
      let total = 0;
      let lines = '';
      for (const pos of positions) {
        total += pos.totalFeesUSD;
        lines += `#${pos.tokenId}: <b>$${pos.totalFeesUSD.toFixed(4)}</b> (${pos.fees0Human.toFixed(6)} ${pos.sym0} + ${pos.fees1Human.toFixed(6)} ${pos.sym1})\n`;
      }
      await send(
        `💰 <b>Accrued Fees</b>\n\n${lines}\n` +
        `Total: <b>$${total.toFixed(4)}</b>\n` +
        `Claim threshold: $${require('./config').strategy.feeClaimThresholdUSD}`
      );
    } catch (e) {
      await send('❌ Failed: ' + e.message);
    }
  });

  // /history — last 10 logged actions
  bot.onText(/\/history/, async (msg) => {
    if (String(msg.chat.id) !== String(_chatId)) return;
    try {
      const history = _getHistory(10);
      if (!history.length) { await send('No actions logged yet.'); return; }
      let lines = '<b>Last 10 Actions</b>\n\n';
      for (const row of history) {
        const usd = row.usd_value ? ` $${Number(row.usd_value).toFixed(2)}` : '';
        lines += `• <code>${row.timestamp.slice(5, 16)}</code> #${row.position_id} <b>${row.action}</b>${usd}\n`;
        if (row.notes) lines += `  <i>${row.notes.slice(0, 60)}</i>\n`;
      }
      await send(lines);
    } catch (e) {
      await send('❌ Failed: ' + e.message);
    }
  });

  // Shared fee summary formatter
  async function sendFeeSummary(days, label) {
    const log = require('./logger');
    const { byPosition, total } = log.getFeeSummary(days);
    if (!total.claim_count) {
      await send(`📊 <b>${label} Fees</b>\n\nNo claims recorded yet in this period.`);
      return;
    }
    let lines = `📊 <b>${label} Fee Report</b>\n\n`;
    for (const row of byPosition) {
      lines += `#${row.position_id}: <b>$${Number(row.total_usd).toFixed(4)}</b> (${row.claim_count} claim${row.claim_count > 1 ? 's' : ''})\n`;
    }
    lines += `\n<b>Total: $${Number(total.total_usd).toFixed(4)}</b> across ${total.claim_count} claim${total.claim_count > 1 ? 's' : ''}`;
    await send(lines);
  }

  // /weekly — fees claimed in the last 7 days
  bot.onText(/\/weekly/, async (msg) => {
    if (String(msg.chat.id) !== String(_chatId)) return;
    await sendFeeSummary(7, 'Weekly (Last 7 Days)');
  });

  // /monthly — fees claimed in the last 30 days
  bot.onText(/\/monthly/, async (msg) => {
    if (String(msg.chat.id) !== String(_chatId)) return;
    await sendFeeSummary(30, 'Monthly (Last 30 Days)');
  });

  // /alltime — all fees ever claimed
  bot.onText(/\/alltime/, async (msg) => {
    if (String(msg.chat.id) !== String(_chatId)) return;
    const log = require('./logger');
    const data = log.getAllTimeFees();
    if (!data.claim_count) {
      await send('📊 <b>All-Time Fees</b>\n\nNo claims recorded yet.'); return;
    }
    await send(
      `📊 <b>All-Time Fee Report</b>\n\n` +
      `Total claimed : <b>$${Number(data.total_usd).toFixed(4)}</b>\n` +
      `No. of claims : ${data.claim_count}\n` +
      `First claim   : <code>${data.first_claim?.slice(0, 16)}</code>\n` +
      `Last claim    : <code>${data.last_claim?.slice(0, 16)}</code>`
    );
  });

  console.log('[Telegram] Command listener active (/status /fees /weekly /monthly /alltime /history)');
}

module.exports = {
  isConfigured,
  send,
  alertFeesCollected,
  alertFeesAvailable,
  alertOutOfRange,
  alertRebalanced,
  alertNearBoundary,
  alertPulled,
  alertSwappedToUSDT,
  alertError,
  alertStartup,
  registerCommands,
  startCommandListener,
};

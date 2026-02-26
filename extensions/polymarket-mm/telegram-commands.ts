// ---------------------------------------------------------------------------
// Telegram command handlers — v5: /mm start|stop|kill|status|markets|config|...
// ---------------------------------------------------------------------------

import type { PluginCommandContext, PluginCommandResult } from "../../src/plugins/types.js";
import { formatConfig } from "./config.js";
import type { MmEngine } from "./engine.js";
import { fmtUsd, fmtPct, fmtDuration, truncQ } from "./utils.js";

export function createMmCommandHandler(engine: MmEngine) {
  return async (ctx: PluginCommandContext): Promise<PluginCommandResult> => {
    const args = (ctx.args || "").trim().split(/\s+/);
    const subcmd = (args[0] || "status").toLowerCase();

    switch (subcmd) {
      case "start":
        return handleStart(engine);
      case "stop":
        return handleStop(engine);
      case "kill":
        return handleKill(engine);
      case "status":
        return handleStatus(engine);
      case "markets":
        return handleMarkets(engine);
      case "config":
        return handleConfig(engine, args.slice(1));
      case "rewards":
        return handleRewards(engine);
      case "trades":
        return handleTrades(engine, args[1]);
      case "fills":
        return handleFills(engine, args[1]);
      case "pause":
        return handlePause(engine, args[1]);
      case "resume":
        return handleResume(engine, args[1]);
      case "scan":
        return handleScan(engine);
      case "liquidate":
        return handleLiquidate(engine);
      case "redeem":
        return handleRedeem(engine, args[1]);
      case "portfolio":
        return handlePortfolio(engine);
      case "help":
        return handleHelp();
      default:
        return { text: `未知命令: ${subcmd}\n使用 /mm help 查看帮助` };
    }
  };
}

async function handleStart(engine: MmEngine): Promise<PluginCommandResult> {
  if (engine.isRunning()) return { text: "⚠️ MM 已在运行中" };
  try {
    await engine.start();
    return { text: "✅ MM v5 已启动 (cancel-before-fill)" };
  } catch (err: any) {
    return { text: `❌ 启动失败: ${err.message}` };
  }
}

async function handleStop(engine: MmEngine): Promise<PluginCommandResult> {
  if (!engine.isRunning()) return { text: "⚠️ MM 未在运行" };
  await engine.stop("Telegram /mm stop");
  return { text: "✅ MM 已停止" };
}

async function handleKill(engine: MmEngine): Promise<PluginCommandResult> {
  const result = await engine.emergencyKill("Telegram /mm kill");
  let text = "🚨 紧急停止！";
  if (result.liquidated) text += "\n💰 已清仓。";
  return { text };
}

function handleStatus(engine: MmEngine): PluginCommandResult {
  const status = engine.getStatus();
  const st = status.state;
  const running = status.running ? "🟢 运行中" : "🔴 已停止";

  const posValue = status.positionValue;
  const portfolio = status.balance + posValue;

  let text = `📊 MM v5 状态\n${"━".repeat(24)}\n`;
  text += `${running}\n`;
  text += `💼 总资产: $${portfolio.toFixed(2)}\n`;
  text += `   💵 USDC: $${status.balance.toFixed(2)}\n`;
  if (posValue > 0) text += `   📦 持仓: $${posValue.toFixed(2)}\n`;
  text += `📈 未实现盈亏: ${fmtUsd(status.unrealizedPnl)}\n`;
  text += `📉 日盈亏: ${fmtUsd(st.dailyPnl)}\n`;
  text += `📊 总盈亏: ${fmtUsd(st.totalPnl)}\n`;
  text += `🏪 活跃市场: ${st.activeMarkets.length}/${status.config.maxConcurrentMarkets}\n`;
  text += `📋 挂单: ${status.liveOrders}\n`;
  text += `🎯 计分: ${status.scoringOrders}/${status.liveOrders}\n`;

  // Market phases (v5)
  const phases = Object.entries(status.marketPhases);
  if (phases.length > 0) {
    text += `\n📍 阶段:`;
    for (const [cid, phase] of phases) {
      const phaseEmoji = phase === "quoting" ? "✅" : phase === "cooldown" ? "⏳" : "🚪";
      text += ` ${phaseEmoji}${phase}`;
    }
  }

  if (st.startedAt) text += `\n⏱️ 运行: ${fmtDuration(Date.now() - st.startedAt)}`;
  if (st.lastRefreshAt)
    text += `\n🔄 刷新: ${((Date.now() - st.lastRefreshAt) / 1000).toFixed(0)}s前`;
  if (st.killSwitchTriggered) text += `\n🚨 Kill Switch!`;
  if (st.dayPaused) text += `\n⏸️ 今日暂停`;

  return { text };
}

function handleMarkets(engine: MmEngine): PluginCommandResult {
  const markets = engine.getActiveMarkets();
  if (markets.length === 0) return { text: "暂无活跃市场" };

  let text = "🏪 活跃市场:\n";
  const positions = engine.getPositionSummaries();

  for (let i = 0; i < markets.length; i++) {
    const m = markets[i];
    const pos = positions.get(m.conditionId);
    const netVal = pos ? fmtUsd(pos.netValue) : "$0";
    const reward = `$${m.rewardsDailyRate.toFixed(2)}/日`;

    text += `\n${i + 1}. ${truncQ(m.question, 35)}\n`;
    text += `   持仓: ${netVal} | 奖励: ${reward}\n`;
    text += `   spread上限: ${m.rewardsMaxSpread} | min_size: ${m.rewardsMinSize}\n`;
  }

  return { text };
}

function handleConfig(engine: MmEngine, args: string[]): PluginCommandResult {
  const cfg = engine.getConfig();
  if (args.length === 0) return { text: `⚙️ v5配置:\n${formatConfig(cfg)}` };

  if (args.length === 1) {
    const key = args[0] as keyof typeof cfg;
    if (key in cfg) return { text: `${key} = ${(cfg as any)[key]}` };
    return { text: `未知: ${key}` };
  }

  const [key, value] = args;
  try {
    engine.updateConfig(key, value);
    return { text: `✅ ${key} = ${value}` };
  } catch (err: any) {
    return { text: `❌ ${err.message}` };
  }
}

async function handleRewards(engine: MmEngine): Promise<PluginCommandResult> {
  return { text: await engine.getRewardStatus() };
}

function handleTrades(engine: MmEngine, countStr?: string): PluginCommandResult {
  const count = parseInt(countStr || "10", 10) || 10;
  const trades = engine.getRecentFills(count);
  if (trades.length === 0) return { text: "暂无成交" };

  let text = `📝 最近 ${trades.length} 笔成交:\n`;
  for (const t of trades) {
    const time = new Date(t.placedAt).toLocaleTimeString("zh-CN");
    text += `  ${t.side} ${t.filledSize.toFixed(1)} @ ${t.price.toFixed(3)} | ${time}\n`;
  }
  return { text };
}

function handleFills(engine: MmEngine, countStr?: string): PluginCommandResult {
  const count = parseInt(countStr || "10", 10) || 10;
  const fills = engine.getRecentFillEvents(count);
  if (fills.length === 0) return { text: "最近1小时无成交" };

  let totalBuy = 0;
  let totalSell = 0;

  let text = `📝 最近 ${fills.length} 笔 (1h):\n`;
  for (const f of fills) {
    const time = new Date(f.timestamp).toLocaleTimeString("zh-CN");
    const value = f.size * f.price;
    const emoji = f.side === "BUY" ? "🟢" : "🔴";
    text += `  ${emoji} ${f.side} ${f.size.toFixed(1)} @ ${f.price.toFixed(3)} ($${value.toFixed(2)}) | ${time}\n`;
    if (f.side === "BUY") totalBuy += value;
    else totalSell += value;
  }
  text += `\n📊 买 $${totalBuy.toFixed(2)} | 卖 $${totalSell.toFixed(2)} | 净 $${(totalBuy - totalSell).toFixed(2)}`;
  return { text };
}

async function handleLiquidate(engine: MmEngine): Promise<PluginCommandResult> {
  if (engine.isRunning()) return { text: "⚠️ 先 /mm stop" };
  try {
    const result = await engine.liquidateAllPositions();
    return { text: `💰 清仓: ✅${result.success} ❌${result.failed}` };
  } catch (err: any) {
    return { text: `❌ ${err.message}` };
  }
}

async function handlePause(engine: MmEngine, id?: string): Promise<PluginCommandResult> {
  if (!id) return { text: "用法: /mm pause <id>" };
  try {
    await engine.pauseMarket(id);
    return { text: `⏸️ 已暂停 ${id.slice(0, 12)}…` };
  } catch (err: any) {
    return { text: `❌ ${err.message}` };
  }
}

async function handleResume(engine: MmEngine, id?: string): Promise<PluginCommandResult> {
  if (!id) return { text: "用法: /mm resume <id>" };
  try {
    engine.resumeMarket(id);
    return { text: `▶️ 已恢复 ${id.slice(0, 12)}…` };
  } catch (err: any) {
    return { text: `❌ ${err.message}` };
  }
}

async function handleScan(engine: MmEngine): Promise<PluginCommandResult> {
  const count = await engine.rescanMarkets();
  return { text: `🔍 扫描完成: ${count} 个奖励市场` };
}

async function handleRedeem(engine: MmEngine, conditionId?: string): Promise<PluginCommandResult> {
  if (!conditionId) {
    const st = engine.getStatus().state;
    const positions = Object.values(st.positions).filter((p) => p.netShares > 0);
    if (positions.length === 0) return { text: "暂无持仓" };

    let text = "📦 持仓:\n";
    const condMap = new Map<string, { shares: number; outcome: string }[]>();
    for (const p of positions) {
      const arr = condMap.get(p.conditionId) || [];
      arr.push({ shares: p.netShares, outcome: p.outcome });
      condMap.set(p.conditionId, arr);
    }
    let i = 0;
    for (const [cid, ps] of condMap) {
      i++;
      const detail = ps.map((p) => `${p.outcome} ${p.shares.toFixed(1)}`).join(", ");
      text += `\n${i}. ${cid.slice(0, 16)}...\n   ${detail}\n`;
    }
    text += `\n用法: /mm redeem <condition_id>`;
    return { text };
  }

  try {
    const txHash = await engine.redeemPosition(conditionId);
    const bal = engine.getStatus().balance;
    return { text: `✅ 赎回成功!\ntx: ${txHash.slice(0, 16)}...\n余额: $${bal.toFixed(2)}` };
  } catch (err: any) {
    return { text: `❌ ${err.message}` };
  }
}

function handlePortfolio(engine: MmEngine): PluginCommandResult {
  const status = engine.getStatus();
  const st = status.state;
  const posValue = status.positionValue;
  const portfolio = status.balance + posValue;

  let text = `💼 资产组合\n${"━".repeat(24)}\n`;
  text += `📊 总资产: $${portfolio.toFixed(2)}\n`;
  text += `   💵 USDC: $${status.balance.toFixed(2)}\n`;
  text += `   📦 持仓: $${posValue.toFixed(2)}\n\n`;

  const positions = Object.values(st.positions).filter((p) => p.netShares > 0);
  if (positions.length > 0) {
    text += `📋 持仓:\n`;
    for (const p of positions) {
      const val = p.netShares * p.avgEntry;
      text += `  ${p.outcome} ${p.netShares.toFixed(1)} @ $${p.avgEntry.toFixed(3)} = $${val.toFixed(2)}\n`;
    }
  }

  text += `\n📈 未实现: ${fmtUsd(status.unrealizedPnl)}`;
  text += `\n📊 总盈亏: ${fmtUsd(st.totalPnl)}`;
  return { text };
}

function handleHelp(): PluginCommandResult {
  return {
    text: [
      "📖 MM v5 命令:",
      "  /mm start       - 启动 (cancel-before-fill)",
      "  /mm stop        - 停止",
      "  /mm kill        - 紧急停止+清仓",
      "  /mm status      - 状态 (含market phase)",
      "  /mm portfolio   - 资产明细",
      "  /mm markets     - 活跃市场",
      "  /mm config      - 查看/修改配置",
      "  /mm rewards     - 奖励状态",
      "  /mm trades [n]  - 最近成交",
      "  /mm fills [n]   - 1h内填充",
      "  /mm redeem [id] - 赎回已结算",
      "  /mm liquidate   - 清仓",
      "  /mm pause <id>  - 暂停市场",
      "  /mm resume <id> - 恢复市场",
      "  /mm scan        - 重新扫描",
    ].join("\n"),
  };
}

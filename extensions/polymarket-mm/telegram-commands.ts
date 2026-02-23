// ---------------------------------------------------------------------------
// Telegram command handlers: /mm start|stop|kill|status|markets|config|...
// ---------------------------------------------------------------------------

import type { PluginCommandContext, PluginCommandResult } from "../../src/plugins/types.js";
import { formatConfig } from "./config.js";
import type { MmEngine } from "./engine.js";
import { fmtUsd, fmtPct, fmtDuration, truncQ } from "./utils.js";

/**
 * Create the /mm command handler connected to the MM engine.
 */
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
  if (engine.isRunning()) {
    return { text: "⚠️ MM 已在运行中" };
  }
  try {
    await engine.start();
    return { text: "✅ MM 已启动" };
  } catch (err: any) {
    return { text: `❌ 启动失败: ${err.message}` };
  }
}

async function handleStop(engine: MmEngine): Promise<PluginCommandResult> {
  if (!engine.isRunning()) {
    return { text: "⚠️ MM 未在运行" };
  }
  await engine.stop("Telegram /mm stop");
  return { text: "✅ MM 已停止（订单已全部取消）" };
}

async function handleKill(engine: MmEngine): Promise<PluginCommandResult> {
  await engine.emergencyKill("Telegram /mm kill");
  return { text: "🚨 紧急停止！所有订单已取消。" };
}

function handleStatus(engine: MmEngine): PluginCommandResult {
  const status = engine.getStatus();
  const st = status.state;
  const running = status.running ? "🟢 运行中" : "🔴 已停止";

  const posValue = status.positionValue;
  const portfolio = status.balance + posValue;

  let text = `📊 Polymarket MM 状态\n${"━".repeat(24)}\n`;
  text += `${running}\n`;
  text += `💼 总资产: $${portfolio.toFixed(2)}\n`;
  text += `   💵 USDC: $${status.balance.toFixed(2)}\n`;
  if (posValue > 0) {
    text += `   📦 持仓: $${posValue.toFixed(2)}\n`;
  }
  text += `📈 未实现盈亏: ${fmtUsd(status.unrealizedPnl)}\n`;
  text += `📉 日盈亏: ${fmtUsd(st.dailyPnl)}\n`;
  text += `📊 总盈亏: ${fmtUsd(st.totalPnl)}\n`;
  text += `🏪 活跃市场: ${st.activeMarkets.length}/${status.config.maxConcurrentMarkets}\n`;
  text += `📋 挂单: ${status.liveOrders}\n`;
  text += `🎯 计分: ${status.scoringOrders}/${status.liveOrders}\n`;

  if (st.startedAt) {
    text += `\n⏱️ 运行时间: ${fmtDuration(Date.now() - st.startedAt)}`;
  }
  if (st.lastRefreshAt) {
    text += `\n🔄 上次刷新: ${((Date.now() - st.lastRefreshAt) / 1000).toFixed(0)}s 前`;
  }
  if (st.killSwitchTriggered) {
    text += `\n🚨 触发过 Kill Switch!`;
  }
  if (st.dayPaused) {
    text += `\n⏸️ 今日已暂停（达到日亏损限制）`;
  }

  return { text };
}

function handleMarkets(engine: MmEngine): PluginCommandResult {
  const markets = engine.getActiveMarkets();
  if (markets.length === 0) {
    return { text: "暂无活跃市场" };
  }

  let text = "🏪 活跃市场:\n";
  const positions = engine.getPositionSummaries();

  for (let i = 0; i < markets.length; i++) {
    const m = markets[i];
    const pos = positions.get(m.conditionId);
    const netVal = pos ? fmtUsd(pos.netValue) : "$0";
    const reward = `$${m.rewardsDailyRate.toFixed(2)}/日`;

    text += `\n${i + 1}. ${truncQ(m.question, 35)}\n`;
    text += `   持仓: ${netVal} | 奖励: ${reward}\n`;
    text += `   spread上限: ${m.rewardsMaxSpread} | 最小size: ${m.rewardsMinSize}\n`;
  }

  return { text };
}

function handleConfig(engine: MmEngine, args: string[]): PluginCommandResult {
  const cfg = engine.getConfig();

  if (args.length === 0) {
    return { text: `⚙️ 当前配置:\n${formatConfig(cfg)}` };
  }

  if (args.length === 1) {
    const key = args[0] as keyof typeof cfg;
    if (key in cfg) {
      return { text: `${key} = ${(cfg as any)[key]}` };
    }
    return { text: `未知配置项: ${key}` };
  }

  // Update config: /mm config key value
  const [key, value] = args;
  try {
    engine.updateConfig(key, value);
    return { text: `✅ ${key} = ${value}` };
  } catch (err: any) {
    return { text: `❌ 配置更新失败: ${err.message}` };
  }
}

async function handleRewards(engine: MmEngine): Promise<PluginCommandResult> {
  const rewardStatus = await engine.getRewardStatus();
  return { text: rewardStatus };
}

function handleTrades(engine: MmEngine, countStr?: string): PluginCommandResult {
  const count = parseInt(countStr || "10", 10) || 10;
  const trades = engine.getRecentFills(count);

  if (trades.length === 0) {
    return { text: "暂无成交记录" };
  }

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

  if (fills.length === 0) {
    return { text: "最近1小时无成交" };
  }

  let totalBuyValue = 0;
  let totalSellValue = 0;

  let text = `📝 最近 ${fills.length} 笔成交（1小时内）:\n`;
  for (const f of fills) {
    const time = new Date(f.timestamp).toLocaleTimeString("zh-CN");
    const value = f.size * f.price;
    const emoji = f.side === "BUY" ? "🟢" : "🔴";
    text += `  ${emoji} ${f.side} ${f.size.toFixed(1)} @ ${f.price.toFixed(3)} ($${value.toFixed(2)}) | ${time}\n`;

    if (f.side === "BUY") totalBuyValue += value;
    else totalSellValue += value;
  }

  text += `\n📊 汇总: 买入 $${totalBuyValue.toFixed(2)} | 卖出 $${totalSellValue.toFixed(2)}`;
  text += ` | 净敞口 $${(totalBuyValue - totalSellValue).toFixed(2)}`;

  return { text };
}

async function handlePause(engine: MmEngine, conditionId?: string): Promise<PluginCommandResult> {
  if (!conditionId) {
    return { text: "用法: /mm pause <condition_id 或市场编号>" };
  }
  try {
    await engine.pauseMarket(conditionId);
    return { text: `⏸️ 已暂停市场 ${conditionId.slice(0, 12)}…` };
  } catch (err: any) {
    return { text: `❌ ${err.message}` };
  }
}

async function handleResume(engine: MmEngine, conditionId?: string): Promise<PluginCommandResult> {
  if (!conditionId) {
    return { text: "用法: /mm resume <condition_id 或市场编号>" };
  }
  try {
    engine.resumeMarket(conditionId);
    return { text: `▶️ 已恢复市场 ${conditionId.slice(0, 12)}…` };
  } catch (err: any) {
    return { text: `❌ ${err.message}` };
  }
}

async function handleScan(engine: MmEngine): Promise<PluginCommandResult> {
  const count = await engine.rescanMarkets();
  return { text: `🔍 扫描完成，发现 ${count} 个奖励市场` };
}

async function handleRedeem(engine: MmEngine, conditionId?: string): Promise<PluginCommandResult> {
  if (!conditionId) {
    // List redeemable positions
    const st = engine.getStatus().state;
    const positions = Object.values(st.positions).filter((p) => p.netShares > 0);
    if (positions.length === 0) {
      return { text: "暂无持仓可赎回" };
    }
    let text = "📦 持仓列表（可尝试赎回已结算市场）:\n";
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
    return {
      text: `✅ 赎回成功!\ntx: ${txHash.slice(0, 16)}...\n新余额: $${bal.toFixed(2)}`,
    };
  } catch (err: any) {
    return { text: `❌ 赎回失败: ${err.message}` };
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
  text += `   📦 持仓价值: $${posValue.toFixed(2)}\n\n`;

  // List positions with detail
  const positions = Object.values(st.positions).filter((p) => p.netShares > 0);
  if (positions.length > 0) {
    text += `📋 持仓明细:\n`;
    for (const p of positions) {
      const val = p.netShares * p.avgEntry;
      text += `  ${p.outcome} ${p.netShares.toFixed(1)} @ $${p.avgEntry.toFixed(3)} = $${val.toFixed(2)}\n`;
      text += `  └ ${p.conditionId.slice(0, 16)}...\n`;
    }
  }

  text += `\n📈 未实现盈亏: ${fmtUsd(status.unrealizedPnl)}`;
  text += `\n📊 总盈亏: ${fmtUsd(st.totalPnl)}`;

  return { text };
}

function handleHelp(): PluginCommandResult {
  return {
    text: [
      "📖 Polymarket MM 命令:",
      "  /mm start       - 启动做市",
      "  /mm stop        - 停止做市（取消订单）",
      "  /mm kill        - 紧急停止",
      "  /mm status      - 查看状态",
      "  /mm portfolio   - 查看资产组合明细",
      "  /mm markets     - 查看活跃市场",
      "  /mm config      - 查看/修改配置",
      "  /mm rewards     - 查看奖励",
      "  /mm trades [n]  - 查看最近成交",
      "  /mm fills [n]   - 查看最近1小时填充记录",
      "  /mm redeem [id] - 赎回已结算持仓",
      "  /mm pause <id>  - 暂停市场",
      "  /mm resume <id> - 恢复市场",
      "  /mm scan        - 重新扫描市场",
      "  /mm help        - 显示帮助",
    ].join("\n"),
  };
}

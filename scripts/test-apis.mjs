#!/usr/bin/env node
// ============================================
// API 连通性测试脚本
// Usage: node scripts/test-apis.mjs
// ============================================

import { config } from "dotenv";
config();

const results = [];

function log(name, ok, detail) {
  const icon = ok ? "\x1b[32m✅\x1b[0m" : "\x1b[31m❌\x1b[0m";
  console.log(`${icon} ${name}: ${detail}`);
  results.push({ name, ok, detail });
}

// --------------------------------------------
// 1. Twitter/X API - 获取马斯克最新推文
// --------------------------------------------
async function testTwitter() {
  console.log("\n\x1b[1m--- Twitter/X API ---\x1b[0m");
  const { TwitterApi } = await import("twitter-api-v2");
  const bearer = process.env.TWITTER_BEARER_TOKEN;
  if (!bearer) {
    return log("Twitter", false, "TWITTER_BEARER_TOKEN 未设置");
  }

  try {
    const client = new TwitterApi(bearer);
    const ro = client.readOnly;

    // 获取 @elonmusk 用户信息
    const user = await ro.v2.userByUsername("elonmusk", {
      "user.fields": "public_metrics,description",
    });

    if (!user.data) {
      log("Twitter", false, `用户查询失败: ${JSON.stringify(user.errors || user)}`);
      return;
    }

    console.log(`  用户: @${user.data.username} (${user.data.name})`);
    console.log(`  粉丝: ${user.data.public_metrics?.followers_count?.toLocaleString()}`);

    // 获取最新一条推文
    const tweets = await ro.v2.userTimeline(user.data.id, {
      max_results: 5,
      "tweet.fields": "created_at,public_metrics,text",
      exclude: ["retweets", "replies"],
    });

    if (tweets.data?.data?.length) {
      const t = tweets.data.data[0];
      console.log(`  最新推文 (${t.created_at}):`);
      console.log(`  "${t.text.slice(0, 200)}${t.text.length > 200 ? "..." : ""}"`);
      if (t.public_metrics) {
        console.log(
          `  ❤️ ${t.public_metrics.like_count}  🔁 ${t.public_metrics.retweet_count}  💬 ${t.public_metrics.reply_count}`,
        );
      }
      log("Twitter", true, `获取 @elonmusk 最新推文成功`);
    } else {
      log("Twitter", false, `用户找到但无法获取推文 (Free tier 限制?)`);
    }
  } catch (e) {
    const code = e.code || e.data?.status || e.statusCode || "";
    const msg = e.data?.detail || e.data?.title || e.message || String(e);
    log("Twitter", false, `[${code}] ${msg}`);
  }
}

// --------------------------------------------
// 2. Yahoo Finance
// --------------------------------------------
async function testYahooFinance() {
  console.log("\n\x1b[1m--- Yahoo Finance ---\x1b[0m");
  try {
    const { default: YahooFinance } = await import("yahoo-finance2");
    const yf = new YahooFinance();
    const quote = await yf.quote("AAPL");
    console.log(
      `  AAPL: $${quote.regularMarketPrice} (${quote.regularMarketChangePercent > 0 ? "+" : ""}${quote.regularMarketChangePercent?.toFixed(2)}%)`,
    );
    console.log(`  市值: $${(quote.marketCap / 1e9).toFixed(1)}B`);
    log("Yahoo Finance", true, `AAPL $${quote.regularMarketPrice}`);
  } catch (e) {
    log("Yahoo Finance", false, e.message);
  }
}

// --------------------------------------------
// 3. Polymarket
// --------------------------------------------
async function testPolymarket() {
  console.log("\n\x1b[1m--- Polymarket ---\x1b[0m");
  try {
    const res = await fetch("https://clob.polymarket.com/markets?limit=1&active=true");
    const data = await res.json();
    if (data?.length || data?.data?.length) {
      const market = data[0] || data.data[0];
      console.log(
        `  热门市场: ${market.question?.slice(0, 80) || market.condition_id?.slice(0, 20)}`,
      );
      log("Polymarket", true, "CLOB API 可达");
    } else {
      log("Polymarket", true, `API 可达, 返回: ${JSON.stringify(data).slice(0, 100)}`);
    }
  } catch (e) {
    log("Polymarket", false, e.message);
  }
}

// --------------------------------------------
// 4. FRED (Federal Reserve Economic Data)
// --------------------------------------------
async function testFred() {
  console.log("\n\x1b[1m--- FRED ---\x1b[0m");
  const key = process.env.FRED_API_KEY;
  if (!key) {
    return log("FRED", false, "FRED_API_KEY 未设置");
  }

  try {
    const url = `https://api.stlouisfed.org/fred/series?series_id=GDP&api_key=${key}&file_type=json`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.seriess?.[0]) {
      const s = data.seriess[0];
      console.log(`  ${s.title} (${s.frequency})`);
      console.log(`  最近观测: ${s.observation_end}`);
      log("FRED", true, s.title);
    } else {
      log("FRED", false, `意外响应: ${JSON.stringify(data).slice(0, 100)}`);
    }
  } catch (e) {
    log("FRED", false, e.message);
  }
}

// --------------------------------------------
// 5. NewsAPI
// --------------------------------------------
async function testNewsApi() {
  console.log("\n\x1b[1m--- NewsAPI ---\x1b[0m");
  const key = process.env.NEWS_API_KEY || process.env.NEWSAPI_ORG_KEY;
  if (!key) {
    return log("NewsAPI", false, "NEWS_API_KEY 未设置");
  }

  try {
    const url = `https://newsapi.org/v2/top-headlines?country=us&pageSize=1&apiKey=${key}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === "ok" && data.articles?.length) {
      const a = data.articles[0];
      console.log(`  ${a.source?.name}: ${a.title?.slice(0, 80)}`);
      log("NewsAPI", true, `${data.totalResults} 条头条`);
    } else {
      log(
        "NewsAPI",
        false,
        `${data.status}: ${data.message || JSON.stringify(data).slice(0, 100)}`,
      );
    }
  } catch (e) {
    log("NewsAPI", false, e.message);
  }
}

// --------------------------------------------
// 6. The Guardian
// --------------------------------------------
async function testGuardian() {
  console.log("\n\x1b[1m--- The Guardian ---\x1b[0m");
  const key = process.env.GUARDIAN_API_KEY;
  if (!key) {
    return log("Guardian", false, "GUARDIAN_API_KEY 未设置");
  }

  try {
    const url = `https://content.guardianapis.com/search?page-size=1&api-key=${key}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.response?.status === "ok") {
      const a = data.response.results?.[0];
      console.log(`  ${a?.sectionName}: ${a?.webTitle?.slice(0, 80)}`);
      log("Guardian", true, `${data.response.total} 条结果`);
    } else {
      log("Guardian", false, JSON.stringify(data).slice(0, 100));
    }
  } catch (e) {
    log("Guardian", false, e.message);
  }
}

// --------------------------------------------
// 7. Reddit
// --------------------------------------------
async function testReddit() {
  console.log("\n\x1b[1m--- Reddit ---\x1b[0m");
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) {
    return log("Reddit", false, "REDDIT_CLIENT_ID/SECRET 未设置");
  }

  try {
    // 获取 OAuth token (application-only)
    const auth = Buffer.from(`${id}:${secret}`).toString("base64");
    const tokenRes = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "clawdbot/1.0",
      },
      body: "grant_type=client_credentials",
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      log("Reddit", false, `OAuth 失败: ${tokenData.error || JSON.stringify(tokenData)}`);
      return;
    }

    // 获取热门帖子
    const postRes = await fetch("https://oauth.reddit.com/r/technology/hot?limit=1", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "User-Agent": "clawdbot/1.0",
      },
    });
    const posts = await postRes.json();
    const post = posts.data?.children?.[0]?.data;
    if (post) {
      console.log(`  r/${post.subreddit}: ${post.title?.slice(0, 80)}`);
      console.log(`  ⬆️ ${post.score}  💬 ${post.num_comments}`);
      log("Reddit", true, "OAuth + 数据获取成功");
    } else {
      log("Reddit", false, "Token 获取成功但无法读取帖子");
    }
  } catch (e) {
    log("Reddit", false, e.message);
  }
}

// --------------------------------------------
// 8. Brave Search
// --------------------------------------------
async function testBraveSearch() {
  console.log("\n\x1b[1m--- Brave Search ---\x1b[0m");
  const key = process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY;
  if (!key) {
    return log("Brave Search", false, "BRAVE_API_KEY 未设置");
  }

  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=OpenAI&count=1`;
    const res = await fetch(url, {
      headers: { "X-Subscription-Token": key, Accept: "application/json" },
    });
    const data = await res.json();
    if (data.web?.results?.length) {
      const r = data.web.results[0];
      console.log(`  ${r.title?.slice(0, 80)}`);
      log("Brave Search", true, "搜索 API 正常");
    } else {
      log("Brave Search", false, `${data.type || ""}: ${JSON.stringify(data).slice(0, 100)}`);
    }
  } catch (e) {
    log("Brave Search", false, e.message);
  }
}

// --------------------------------------------
// 9. Finnhub
// --------------------------------------------
async function testFinnhub() {
  console.log("\n\x1b[1m--- Finnhub ---\x1b[0m");
  const key = process.env.FINNHUB_API_KEY;
  if (!key) {
    return log("Finnhub", false, "FINNHUB_API_KEY 未设置");
  }

  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=AAPL&token=${key}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.c) {
      console.log(`  AAPL: $${data.c} (高 $${data.h} / 低 $${data.l})`);
      log("Finnhub", true, `AAPL $${data.c}`);
    } else {
      log("Finnhub", false, JSON.stringify(data).slice(0, 100));
    }
  } catch (e) {
    log("Finnhub", false, e.message);
  }
}

// --------------------------------------------
// 10. Alpha Vantage
// --------------------------------------------
async function testAlphaVantage() {
  console.log("\n\x1b[1m--- Alpha Vantage ---\x1b[0m");
  const key = process.env.ALPHA_VANTAGE_KEY;
  if (!key) {
    return log("Alpha Vantage", false, "ALPHA_VANTAGE_KEY 未设置");
  }

  try {
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=MSFT&apikey=${key}`;
    const res = await fetch(url);
    const data = await res.json();
    const quote = data["Global Quote"];
    if (quote?.["05. price"]) {
      console.log(`  MSFT: $${quote["05. price"]} (${quote["10. change percent"]})`);
      log("Alpha Vantage", true, `MSFT $${quote["05. price"]}`);
    } else if (data.Note || data.Information) {
      log("Alpha Vantage", false, `限频: ${(data.Note || data.Information).slice(0, 80)}`);
    } else {
      log("Alpha Vantage", false, JSON.stringify(data).slice(0, 100));
    }
  } catch (e) {
    log("Alpha Vantage", false, e.message);
  }
}

// --------------------------------------------
// 11. Tushare (中国A股)
// --------------------------------------------
async function testTushare() {
  console.log("\n\x1b[1m--- Tushare ---\x1b[0m");
  const token = process.env.TUSHARE_TOKEN;
  if (!token) {
    return log("Tushare", false, "TUSHARE_TOKEN 未设置");
  }

  try {
    const res = await fetch("http://api.tushare.pro", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_name: "trade_cal",
        token,
        params: { exchange: "SSE", start_date: "20260101", end_date: "20260213" },
        fields: "exchange,cal_date,is_open",
      }),
    });
    const data = await res.json();
    if (data.data?.items?.length) {
      const total = data.data.items.length;
      const open = data.data.items.filter((r) => r[2] === 1).length;
      console.log(`  上交所 2026 年至今: ${total} 天, 开盘 ${open} 天`);
      log("Tushare", true, `交易日历获取成功`);
    } else if (data.code !== 0) {
      log("Tushare", false, `[${data.code}] ${data.msg}`);
    } else {
      log("Tushare", false, JSON.stringify(data).slice(0, 100));
    }
  } catch (e) {
    log("Tushare", false, e.message);
  }
}

// --------------------------------------------
// 12. Formspree
// --------------------------------------------
async function testFormspree() {
  console.log("\n\x1b[1m--- Formspree ---\x1b[0m");
  const formId = process.env.FORMSPREE_FORM_ID;
  if (!formId) {
    return log("Formspree", false, "FORMSPREE_FORM_ID 未设置");
  }

  try {
    // 用 GET 验证端点存在 (Formspree 返回表单页面)
    const url = `https://formspree.io/f/${formId}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (res.ok) {
      log("Formspree", true, `端点可达 (${res.status})`);
    } else if (res.status === 403 || res.status === 404) {
      log("Formspree", false, `表单不存在或已禁用 (${res.status})`);
    } else {
      // 400 on GET with JSON accept = 端点存在但需要 POST
      log("Formspree", true, `端点存在 (${res.status}, 需 POST 提交)`);
    }
  } catch (e) {
    log("Formspree", false, e.message);
  }
}

// ============================================
// 执行所有测试
// ============================================
console.log("🔌 API 连通性测试");
console.log("=".repeat(50));

await testTwitter();
await testYahooFinance();
await testPolymarket();
await testFred();
await testNewsApi();
await testGuardian();
await testReddit();
await testBraveSearch();
await testFinnhub();
await testAlphaVantage();
await testTushare();
await testFormspree();

// ============================================
// 汇总
// ============================================
console.log("\n" + "=".repeat(50));
console.log("\x1b[1m📊 汇总\x1b[0m\n");
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
results.forEach((r) => {
  const icon = r.ok ? "✅" : "❌";
  console.log(`  ${icon} ${r.name}`);
});
console.log(`\n  通过: ${passed}/${results.length}  失败: ${failed}/${results.length}`);

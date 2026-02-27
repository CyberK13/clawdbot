// ---------------------------------------------------------------------------
// DeepSeek AI summarizer — ported from gmail-digest-all.py
// ---------------------------------------------------------------------------

import type { ParsedEmail } from "./types.js";

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const GEMINI_MODEL = "gemini-3-flash-preview";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/** Fetch article content from a URL (best-effort). */
export async function fetchArticle(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ClawdBot/1.0)",
        Accept: "text/html",
      },
      redirect: "follow",
    });
    if (!resp.ok) return null;
    const ct = resp.headers.get("content-type") ?? "";
    if (!ct.includes("html") && !ct.includes("text")) return null;
    const html = await resp.text();
    const text = html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    return text.length > 50 ? text.slice(0, 2000) : null;
  } catch {
    return null;
  }
}

/** Build the AI prompt from parsed emails. */
function buildPrompt(emails: ParsedEmail[]): string {
  let prompt = `你是一个邮件助手。请用中文对以下 ${emails.length} 封未读邮件进行全面汇总。\n\n`;
  prompt += "要求：\n";
  prompt += "1. 先给出一段总体概述（2-3句话）\n";
  prompt += "2. 然后逐封邮件详细解读，每封包括：\n";
  prompt += "   - 发件人和主题\n";
  prompt += "   - 核心内容摘要\n";
  prompt += "   - 如果有文章链接，提取关键观点\n";
  prompt += "   - 是否需要用户采取行动（用 [需要行动] 标注）\n";
  prompt += '3. 最后列出所有"需要关注"的事项\n\n';

  for (let i = 0; i < emails.length; i++) {
    const em = emails[i]!;
    prompt += `\n${"=".repeat(40)}\n`;
    prompt += `邮件 ${i + 1}/${emails.length}\n`;
    prompt += `发件人: ${em.from}\n`;
    prompt += `主题: ${em.subject}\n`;
    prompt += `日期: ${em.date}\n`;
    prompt += `正文:\n${em.body.slice(0, 2500)}\n`;
    if (em.articles.length > 0) {
      prompt += "\n链接文章:\n";
      for (let j = 0; j < em.articles.length; j++) {
        const a = em.articles[j]!;
        if (a.content) {
          prompt += `[文章${j + 1}] ${a.url.slice(0, 80)}\n${a.content.slice(0, 1000)}\n`;
        }
      }
    }
  }
  return prompt;
}

/** Call Gemini 3 Flash API. */
async function callGemini(prompt: string): Promise<string | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  try {
    const resp = await fetch(`${GEMINI_URL}?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 3000 },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as any;
    return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  } catch {
    return null;
  }
}

/** Call DeepSeek API (fallback). */
async function callDeepSeek(prompt: string): Promise<string | null> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return null;
  try {
    const resp = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 3000,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as any;
    return data?.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

/** Generate AI summary: Gemini first, DeepSeek fallback. */
export async function summarizeEmails(emails: ParsedEmail[]): Promise<string | null> {
  // Fetch article content for all emails first
  for (const em of emails) {
    for (const article of em.articles) {
      if (!article.content) {
        article.content = (await fetchArticle(article.url)) ?? "";
      }
    }
  }

  const prompt = buildPrompt(emails);

  // Try Gemini first
  const geminiResult = await callGemini(prompt);
  if (geminiResult) return geminiResult;

  // Fallback to DeepSeek
  return callDeepSeek(prompt);
}

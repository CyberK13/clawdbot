#!/usr/bin/env python3
"""
Gmail Digest — 完整邮件处理管道
1. 轮询新邮件 (gog gmail search)
2. 读取邮件全文 (gog gmail thread)
3. 提取并抓取文章链接
4. 调用 Gemini API 生成中文摘要
5. 通过 TG Bot 发送摘要
"""

import json, os, sys, re, subprocess, time, logging, base64
from urllib.parse import urlparse
import requests
import html2text

# ── 配置 ────────────────────────────────────────────
ACCOUNT      = os.environ.get('GMAIL_ACCOUNT', 'klchen0113@gmail.com')
STATE_FILE   = os.environ.get('STATE_FILE', '/var/lib/clawdbot/gmail-poll-state.txt')
BOT_TOKEN    = os.environ.get('BOT_TOKEN', '')
CHAT_ID      = os.environ.get('CHAT_ID', '6309937609')
GEMINI_KEY   = os.environ.get('GOOGLE_API_KEY', '')
DEEPSEEK_KEY = os.environ.get('DEEPSEEK_API_KEY', '')
MAX_URLS     = 3           # 每封邮件最多抓取 3 个链接
URL_TIMEOUT  = 10          # 抓取链接超时 (秒)
MAX_ARTICLE  = 3000        # 每篇文章最多保留字符数
MAX_BODY     = 5000        # 邮件正文最多保留字符数
SEARCH_QUERY = 'is:unread newer_than:10m'

# AI API 配置
GEMINI_MODEL = 'gemini-2.0-flash'
GEMINI_URL   = f'https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent'
DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions'

# ── 日志 ────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [gmail-digest] %(levelname)s %(message)s',
    datefmt='%H:%M:%S'
)
log = logging.getLogger('gmail-digest')

# ── 跳过的域名 (广告/追踪/退订) ─────────────────────
SKIP_DOMAINS = {
    'list-manage.com', 'mailchimp.com', 'sendgrid.net',
    'manage.kmail-lists.com', 'google.com/maps',
    'play.google.com', 'itunes.apple.com',
    'facebook.com', 'twitter.com', 'instagram.com',
    'linkedin.com', 'youtube.com',
    'doubleclick.net', 'googlesyndication.com',
}

SKIP_URL_PATTERNS = [
    'unsubscribe', 'optout', 'opt-out', 'preference',
    'click.', 'tracking.', 'trk.', 'opens.',
    'beacon', 'pixel', '1x1',
]

h2t = html2text.HTML2Text()
h2t.ignore_links = False
h2t.ignore_images = True
h2t.body_width = 0
h2t.ignore_emphasis = True


def run_gog(args, timeout=30):
    """执行 gog 命令并返回 stdout"""
    env = os.environ.copy()
    env['GOG_KEYRING_BACKEND'] = 'file'
    env['GOG_KEYRING_PASSWORD'] = os.environ.get('GOG_KEYRING_PASSWORD', 'gogpass')
    result = subprocess.run(
        ['gog'] + args,
        capture_output=True, text=True, timeout=timeout, env=env
    )
    if result.returncode != 0:
        log.warning('gog error: %s', result.stderr[:200])
    return result.stdout


def mark_as_read(thread_id):
    """标记邮件为已读 (移除 UNREAD 标签)"""
    out = run_gog([
        'gmail', 'thread', 'modify', thread_id,
        '--remove', 'UNREAD',
        '--account', ACCOUNT,
        '--force',
    ])
    if out is not None:
        log.info('Marked as read: %s', thread_id[:20])
    return True


def load_seen_ids():
    """加载已处理的邮件 ID"""
    if not os.path.exists(STATE_FILE):
        return set()
    with open(STATE_FILE) as f:
        return {line.strip() for line in f if line.strip()}


def save_seen_ids(ids):
    """保存已处理的邮件 ID (保留最近 500 个)"""
    recent = sorted(ids)[-500:]
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, 'w') as f:
        f.write('\n'.join(recent) + '\n')


def search_new_emails():
    """搜索新未读邮件"""
    raw = run_gog([
        'gmail', 'search', SEARCH_QUERY,
        '--account', ACCOUNT,
        '--json', '--results-only'
    ])
    try:
        return json.loads(raw) if raw.strip() else []
    except json.JSONDecodeError:
        log.error('Failed to parse search results: %s', raw[:200])
        return []


def get_email_body(thread_id):
    """读取邮件全文，返回 {from, subject, date, body, snippet}"""
    raw = run_gog([
        'gmail', 'thread', thread_id,
        '--account', ACCOUNT,
        '--json', '--results-only'
    ])
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        log.error('Failed to parse thread %s', thread_id)
        return {}

    thread = data.get('thread', {})
    messages = thread.get('messages', [])
    if not messages:
        return {}

    msg = messages[0]
    payload = msg.get('payload', {})
    snippet = msg.get('snippet', '')

    # 提取 headers
    headers = {}
    for h in payload.get('headers', []):
        name = h.get('name', '').lower()
        if name in ('from', 'to', 'subject', 'date'):
            headers[name] = h.get('value', '')

    # 提取 body
    body_text = ''
    body_html = ''

    def extract_parts(parts):
        nonlocal body_text, body_html
        for part in parts:
            mime = part.get('mimeType', '')
            body_data = part.get('body', {}).get('data', '')
            if body_data:
                decoded = base64.urlsafe_b64decode(body_data).decode('utf-8', errors='replace')
                if mime == 'text/plain' and not body_text:
                    body_text = decoded
                elif mime == 'text/html' and not body_html:
                    body_html = decoded
            if 'parts' in part:
                extract_parts(part['parts'])

    if 'parts' in payload:
        extract_parts(payload['parts'])
    else:
        body_data = payload.get('body', {}).get('data', '')
        if body_data:
            decoded = base64.urlsafe_b64decode(body_data).decode('utf-8', errors='replace')
            mime = payload.get('mimeType', '')
            if mime == 'text/plain':
                body_text = decoded
            elif mime == 'text/html':
                body_html = decoded

    # 如果只有 HTML，转换为文本
    if not body_text and body_html:
        body_text = h2t.handle(body_html)

    return {
        'from': headers.get('from', ''),
        'subject': headers.get('subject', ''),
        'date': headers.get('date', ''),
        'body': body_text[:MAX_BODY],
        'snippet': snippet,
    }


def is_tracking_url(url):
    """判断是否为追踪/广告链接"""
    url_lower = url.lower()
    for pat in SKIP_URL_PATTERNS:
        if pat in url_lower:
            return True
    parsed = urlparse(url_lower)
    domain = parsed.netloc
    for sd in SKIP_DOMAINS:
        if sd in domain:
            return True
    return False


def extract_article_urls(body_text):
    """从邮件正文提取有价值的文章链接"""
    urls = re.findall(r'https?://[^\s<>"\')\]]+', body_text)

    seen = set()
    good_urls = []
    for url in urls:
        url = url.rstrip('.,;:!?)>]')
        if len(url) < 20:
            continue
        if is_tracking_url(url):
            continue

        # 跳过图片/媒体
        path_lower = urlparse(url).path.lower()
        if any(path_lower.endswith(ext) for ext in
               ('.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.css', '.js', '.woff')):
            continue

        # 去重
        parsed = urlparse(url)
        key = parsed.netloc + parsed.path
        if key in seen:
            continue
        seen.add(key)
        good_urls.append(url)

    return good_urls[:MAX_URLS]


def fetch_medium_article(url):
    """用 Playwright session 抓取 Medium 付费文章"""
    try:
        result = subprocess.run(
            ['python3', '/opt/clawdbot/medium-fetch.py', url],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode == 0 and len(result.stdout.strip()) > 50:
            return result.stdout.strip()[:MAX_ARTICLE]
    except Exception as e:
        log.warning('Medium fetch failed: %s', e)
    return None


def fetch_article(url):
    """抓取文章内容，返回纯文本 (Medium 用 Playwright，其他用 requests)"""
    if 'medium.com' in url:
        content = fetch_medium_article(url)
        if content:
            return content

    try:
        resp = requests.get(url, timeout=URL_TIMEOUT, headers={
            'User-Agent': 'Mozilla/5.0 (compatible; ClawdBot/1.0)',
            'Accept': 'text/html,application/xhtml+xml',
        }, allow_redirects=True)
        resp.raise_for_status()

        content_type = resp.headers.get('Content-Type', '')
        if 'html' not in content_type and 'text' not in content_type:
            return None

        text = h2t.handle(resp.text)
        text = re.sub(r'\n{3,}', '\n\n', text)
        text = text.strip()

        if len(text) < 50:
            return None

        return text[:MAX_ARTICLE]
    except Exception as e:
        log.warning('Failed to fetch %s: %s', url[:60], e)
        return None


def call_deepseek(prompt):
    """调用 DeepSeek API 生成摘要"""
    if not DEEPSEEK_KEY:
        return None
    try:
        resp = requests.post(
            DEEPSEEK_URL,
            headers={'Authorization': f'Bearer {DEEPSEEK_KEY}', 'Content-Type': 'application/json'},
            json={
                'model': 'deepseek-chat',
                'messages': [{'role': 'user', 'content': prompt}],
                'temperature': 0.3,
                'max_tokens': 1024,
            },
            timeout=60,
        )
        resp.raise_for_status()
        data = resp.json()
        choices = data.get('choices', [])
        if choices:
            return choices[0].get('message', {}).get('content', '')
        log.warning('DeepSeek returned empty')
        return None
    except Exception as e:
        log.error('DeepSeek API error: %s', e)
        return None


def call_gemini(prompt):
    """调用 Gemini API 生成摘要"""
    if not GEMINI_KEY:
        return None
    try:
        resp = requests.post(
            GEMINI_URL,
            params={'key': GEMINI_KEY},
            json={
                'contents': [{'parts': [{'text': prompt}]}],
                'generationConfig': {
                    'temperature': 0.3,
                    'maxOutputTokens': 1024,
                }
            },
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        candidates = data.get('candidates', [])
        if candidates:
            parts = candidates[0].get('content', {}).get('parts', [])
            if parts:
                return parts[0].get('text', '')
        log.warning('Gemini returned empty: %s', json.dumps(data)[:200])
        return None
    except Exception as e:
        log.error('Gemini API error: %s', e)
        return None


def call_ai(prompt):
    """调用 AI API (优先 Gemini，失败则回退 DeepSeek)"""
    result = call_gemini(prompt)
    if result:
        log.info('AI summary via Gemini')
        return result
    result = call_deepseek(prompt)
    if result:
        log.info('AI summary via DeepSeek')
        return result
    log.warning('All AI APIs failed')
    return None


def build_summary_prompt(email_data, articles):
    """构建 AI 摘要提示"""
    prompt = f"""请用中文总结以下邮件，要求：
1. 一句话概括邮件主旨
2. 列出关键信息要点 (3-5条)
3. 如果有文章链接内容，提取核心观点
4. 如果需要采取行动，明确标注

📧 邮件信息
发件人: {email_data.get('from', '?')}
主题: {email_data.get('subject', '?')}
日期: {email_data.get('date', '?')}

📝 邮件正文:
{email_data.get('body', '')[:3000]}"""

    if articles:
        prompt += '\n\n📎 链接文章内容:'
        for i, a in enumerate(articles, 1):
            prompt += f'\n\n[文章{i}] {a["url"][:80]}\n{a["content"][:1500]}'

    return prompt


def send_tg(text):
    """发送消息到 TG"""
    if not BOT_TOKEN:
        log.warning('BOT_TOKEN not set')
        return False

    if len(text) > 4000:
        text = text[:3997] + '...'

    try:
        resp = requests.post(
            f'https://api.telegram.org/bot{BOT_TOKEN}/sendMessage',
            json={'chat_id': CHAT_ID, 'text': text, 'parse_mode': 'HTML',
                  'disable_web_page_preview': True},
            timeout=10
        )
        if resp.status_code == 200:
            return True
        # 如果 HTML 解析失败，回退到纯文本
        resp2 = requests.post(
            f'https://api.telegram.org/bot{BOT_TOKEN}/sendMessage',
            json={'chat_id': CHAT_ID, 'text': text,
                  'disable_web_page_preview': True},
            timeout=10
        )
        return resp2.status_code == 200
    except Exception as e:
        log.error('TG send failed: %s', e)
        return False


def process_email(email_meta, seen_ids):
    """处理单封邮件: 读取 → 提取链接 → 抓取文章 → AI总结 → TG发送"""
    msg_id = email_meta.get('id', '')
    if msg_id in seen_ids:
        return False

    subject = email_meta.get('subject', '(无主题)')
    log.info('Processing: %s', subject[:60])

    # 1. 读取邮件全文
    email_data = get_email_body(msg_id)
    if not email_data:
        log.warning('Could not read email %s', msg_id)
        seen_ids.add(msg_id)
        return False

    email_data['id'] = msg_id

    # 2. 提取文章链接
    body = email_data.get('body', '')
    urls = extract_article_urls(body)
    log.info('Found %d article URLs', len(urls))

    # 3. 抓取文章内容
    articles = []
    for url in urls:
        content = fetch_article(url)
        if content:
            articles.append({'url': url, 'content': content})
            log.info('Fetched: %s (%d chars)', url[:60], len(content))

    # 4. 调用 AI 生成深度摘要
    prompt = build_summary_prompt(email_data, articles)
    summary = call_ai(prompt)

    # 5. 发送到 TG
    if summary:
        tg_text = f"📧 <b>{email_data.get('subject', '?')}</b>\n"
        tg_text += f"👤 {email_data.get('from', '?')}\n\n"
        tg_text += summary
        log.info('AI summary generated (%d chars)', len(summary))
    else:
        # Gemini 不可用时，发送原文摘要
        tg_text = f"📧 新邮件\n发件人: {email_data.get('from', '?')}\n"
        tg_text += f"主题: {email_data.get('subject', '?')}\n\n"
        tg_text += email_data.get('snippet', '')[:500]
        log.info('Using raw snippet (no AI)')

    ok = send_tg(tg_text)
    if ok:
        log.info('Sent to TG: %s', subject[:40])
        # 6. 标记为已读
        mark_as_read(msg_id)
    else:
        log.error('Failed to send to TG: %s', subject[:40])

    seen_ids.add(msg_id)
    return True


def main():
    log.info('Starting gmail-digest for %s', ACCOUNT)

    if not GEMINI_KEY and not DEEPSEEK_KEY:
        log.warning('No AI API key set, summaries disabled')
    if not BOT_TOKEN:
        log.error('BOT_TOKEN not set, cannot send to TG')
        sys.exit(1)

    seen_ids = load_seen_ids()
    log.info('Loaded %d seen IDs', len(seen_ids))

    emails = search_new_emails()
    log.info('Found %d recent emails', len(emails))

    new_count = 0
    for email_meta in emails:
        if process_email(email_meta, seen_ids):
            new_count += 1
            time.sleep(1)

    save_seen_ids(seen_ids)
    log.info('Done: %d new emails processed', new_count)


if __name__ == '__main__':
    main()

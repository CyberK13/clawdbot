#!/usr/bin/env python3
"""一次性读取所有未读邮件，汇总成一条消息发送到 TG
AI: Gemini 3 Flash (primary) → DeepSeek (fallback)
"""
import json, os, sys, re, subprocess, time, logging, base64
from urllib.parse import urlparse
import requests
import html2text

ACCOUNT = os.environ.get('GMAIL_ACCOUNT', 'klchen0113@gmail.com')
BOT_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN', '') or os.environ.get('BOT_TOKEN', '')
CHAT_ID = os.environ.get('CHAT_ID', '6309937609')
GEMINI_KEY = os.environ.get('GEMINI_API_KEY', '')
DEEPSEEK_KEY = os.environ.get('DEEPSEEK_API_KEY', '')

logging.basicConfig(level=logging.INFO, format='%(asctime)s [digest-all] %(levelname)s %(message)s', datefmt='%H:%M:%S')
log = logging.getLogger('digest-all')

h2t = html2text.HTML2Text()
h2t.ignore_links = False
h2t.ignore_images = True
h2t.body_width = 0
h2t.ignore_emphasis = True

SKIP_DOMAINS = {
    'list-manage.com','mailchimp.com','sendgrid.net','manage.kmail-lists.com',
    'google.com/maps','play.google.com','itunes.apple.com',
    'facebook.com','twitter.com','instagram.com','linkedin.com','youtube.com',
    'doubleclick.net','googlesyndication.com',
}
SKIP_URL_PATTERNS = ['unsubscribe','optout','opt-out','preference','click.','tracking.','trk.','opens.','beacon','pixel','1x1']

# AI API config
GEMINI_MODEL = 'gemini-3-flash-preview'
GEMINI_URL = f'https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent'

def run_gog(args, timeout=30):
    env = os.environ.copy()
    env['GOG_KEYRING_BACKEND'] = 'file'
    env['GOG_KEYRING_PASSWORD'] = os.environ.get('GOG_KEYRING_PASSWORD', 'gogpass')
    result = subprocess.run(['gog'] + args, capture_output=True, text=True, timeout=timeout, env=env)
    if result.returncode != 0:
        log.warning('gog error: %s', result.stderr[:200])
    return result.stdout

def get_email_body(thread_id):
    raw = run_gog(['gmail','thread','get', thread_id,'--account',ACCOUNT,'--json','--results-only'])
    try:
        data = json.loads(raw)
    except Exception:
        return {}
    thread = data.get('thread', {})
    messages = thread.get('messages', [])
    if not messages:
        return {}
    msg = messages[0]
    payload = msg.get('payload', {})
    snippet = msg.get('snippet', '')
    headers = {}
    for h in payload.get('headers', []):
        name = h.get('name', '').lower()
        if name in ('from','to','subject','date'):
            headers[name] = h.get('value', '')
    body_text = ''
    body_html = ''
    def extract_parts(parts):
        nonlocal body_text, body_html
        for part in parts:
            mime = part.get('mimeType', '')
            bd = part.get('body', {}).get('data', '')
            if bd:
                decoded = base64.urlsafe_b64decode(bd).decode('utf-8', errors='replace')
                if mime == 'text/plain' and not body_text:
                    body_text = decoded
                elif mime == 'text/html' and not body_html:
                    body_html = decoded
            if 'parts' in part:
                extract_parts(part['parts'])
    if 'parts' in payload:
        extract_parts(payload['parts'])
    else:
        bd = payload.get('body', {}).get('data', '')
        if bd:
            decoded = base64.urlsafe_b64decode(bd).decode('utf-8', errors='replace')
            mime = payload.get('mimeType', '')
            if mime == 'text/plain':
                body_text = decoded
            elif mime == 'text/html':
                body_html = decoded
    if not body_text and body_html:
        body_text = h2t.handle(body_html)
    return {
        'from': headers.get('from',''), 'subject': headers.get('subject',''),
        'date': headers.get('date',''), 'body': body_text[:4000], 'snippet': snippet,
    }

def is_tracking_url(url):
    url_lower = url.lower()
    for pat in SKIP_URL_PATTERNS:
        if pat in url_lower:
            return True
    parsed = urlparse(url_lower)
    for sd in SKIP_DOMAINS:
        if sd in parsed.netloc:
            return True
    return False

def extract_article_urls(body_text):
    urls = re.findall(r'https?://[^\s<>"\')\]]+', body_text)
    seen = set()
    good = []
    for url in urls:
        url = url.rstrip('.,;:!?)>]')
        if len(url) < 20 or is_tracking_url(url):
            continue
        p = urlparse(url).path.lower()
        if any(p.endswith(e) for e in ('.png','.jpg','.jpeg','.gif','.svg','.ico','.css','.js','.woff')):
            continue
        key = urlparse(url).netloc + urlparse(url).path
        if key in seen:
            continue
        seen.add(key)
        good.append(url)
    return good[:2]

def fetch_medium_article(url):
    try:
        result = subprocess.run(
            ['python3', '/opt/clawdbot/medium-fetch.py', url],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode == 0 and len(result.stdout.strip()) > 50:
            return result.stdout.strip()[:2000]
    except Exception as e:
        log.warning('Medium fetch failed: %s', e)
    return None

def fetch_article(url):
    if 'medium.com' in url:
        content = fetch_medium_article(url)
        if content:
            return content
    try:
        resp = requests.get(url, timeout=10, headers={
            'User-Agent': 'Mozilla/5.0 (compatible; ClawdBot/1.0)',
            'Accept': 'text/html',
        }, allow_redirects=True)
        resp.raise_for_status()
        ct = resp.headers.get('Content-Type', '')
        if 'html' not in ct and 'text' not in ct:
            return None
        text = h2t.handle(resp.text)
        text = re.sub(r'\n{3,}', '\n\n', text).strip()
        return text[:2000] if len(text) > 50 else None
    except Exception:
        return None

def mark_as_read(thread_id):
    run_gog(['gmail','thread','modify', thread_id,'--remove','UNREAD','--account',ACCOUNT,'--force'])
    log.info('Marked read: %s', thread_id[:16])

def call_gemini(prompt):
    """Call Gemini 3 Flash API"""
    if not GEMINI_KEY:
        log.warning('No GEMINI_API_KEY, skipping Gemini')
        return None
    try:
        resp = requests.post(
            f'{GEMINI_URL}?key={GEMINI_KEY}',
            headers={'Content-Type': 'application/json'},
            json={
                'contents': [{'parts': [{'text': prompt}]}],
                'generationConfig': {'temperature': 0.3, 'maxOutputTokens': 3000},
            },
            timeout=120,
        )
        resp.raise_for_status()
        data = resp.json()
        return data['candidates'][0]['content']['parts'][0]['text']
    except Exception as e:
        log.error('Gemini error: %s', e)
        return None

def call_deepseek(prompt):
    """Fallback: DeepSeek API"""
    if not DEEPSEEK_KEY:
        log.warning('No DEEPSEEK_API_KEY, skipping DeepSeek')
        return None
    try:
        resp = requests.post(
            'https://api.deepseek.com/v1/chat/completions',
            headers={'Authorization': f'Bearer {DEEPSEEK_KEY}', 'Content-Type': 'application/json'},
            json={
                'model': 'deepseek-chat',
                'messages': [{'role': 'user', 'content': prompt}],
                'temperature': 0.3,
                'max_tokens': 3000,
            },
            timeout=120,
        )
        resp.raise_for_status()
        return resp.json()['choices'][0]['message']['content']
    except Exception as e:
        log.error('DeepSeek error: %s', e)
        return None

def call_ai(prompt):
    """Try Gemini 3 Flash first, fallback to DeepSeek"""
    log.info('Calling Gemini 3 Flash...')
    result = call_gemini(prompt)
    if result:
        return result
    log.info('Gemini failed, falling back to DeepSeek...')
    return call_deepseek(prompt)

def send_tg(text):
    if len(text) > 4000:
        parts = []
        while text:
            if len(text) <= 4000:
                parts.append(text)
                break
            cut = text[:4000].rfind('\n')
            if cut < 2000:
                cut = 4000
            parts.append(text[:cut])
            text = text[cut:].lstrip('\n')
        for i, part in enumerate(parts):
            requests.post(
                f'https://api.telegram.org/bot{BOT_TOKEN}/sendMessage',
                json={'chat_id': CHAT_ID, 'text': part, 'disable_web_page_preview': True},
                timeout=10,
            )
            if i < len(parts) - 1:
                time.sleep(0.5)
        return True
    resp = requests.post(
        f'https://api.telegram.org/bot{BOT_TOKEN}/sendMessage',
        json={'chat_id': CHAT_ID, 'text': text, 'disable_web_page_preview': True},
        timeout=10,
    )
    return resp.status_code == 200

# ── MAIN ──
log.info('Searching all unread emails...')
raw = run_gog(['gmail', 'search', 'is:unread', '--account', ACCOUNT, '--json', '--results-only'])
try:
    emails = json.loads(raw) if raw.strip() else []
except Exception:
    emails = []
log.info('Found %d unread emails', len(emails))

if not emails:
    send_tg('📭 没有未读邮件')
    log.info('No unread emails')
    sys.exit(0)

# 读取所有邮件
all_emails = []
for em in emails:
    tid = em.get('id', '')
    subj = em.get('subject', '(no subject)')
    log.info('Reading: %s', subj[:50])
    data = get_email_body(tid)
    if not data:
        log.warning('Skip unreadable: %s', tid)
        continue
    data['id'] = tid
    urls = extract_article_urls(data.get('body', ''))
    articles = []
    for url in urls:
        content = fetch_article(url)
        if content:
            articles.append({'url': url, 'content': content})
    data['articles'] = articles
    all_emails.append(data)
    time.sleep(0.3)

log.info('Read %d emails, generating summary...', len(all_emails))

# 构建汇总 prompt
prompt = f"你是一个邮件助手。请用中文对以下 {len(all_emails)} 封未读邮件进行全面汇总。\n\n"
prompt += "要求：\n"
prompt += "1. 先给出一段总体概述（2-3句话）\n"
prompt += "2. 然后逐封邮件详细解读，每封包括：\n"
prompt += "   - 发件人和主题\n"
prompt += "   - 核心内容摘要\n"
prompt += "   - 如果有文章链接，提取关键观点\n"
prompt += "   - 是否需要用户采取行动（用 [需要行动] 标注）\n"
prompt += "3. 最后列出所有\"需要关注\"的事项\n\n"

for i, em in enumerate(all_emails, 1):
    prompt += f"\n{'='*40}\n"
    prompt += f"邮件 {i}/{len(all_emails)}\n"
    prompt += f"发件人: {em.get('from', '?')}\n"
    prompt += f"主题: {em.get('subject', '?')}\n"
    prompt += f"日期: {em.get('date', '?')}\n"
    prompt += f"正文:\n{em.get('body', '')[:2500]}\n"
    if em.get('articles'):
        prompt += "\n链接文章:\n"
        for j, a in enumerate(em['articles'], 1):
            prompt += f"[文章{j}] {a['url'][:80]}\n{a['content'][:1000]}\n"

log.info('Prompt size: %d chars, calling AI...', len(prompt))
summary = call_ai(prompt)

if summary:
    header = f"📬 未读邮件汇总 ({len(all_emails)} 封)\n{'─'*30}\n\n"
    full_text = header + summary
    log.info('Summary: %d chars, sending to TG...', len(full_text))
    ok = send_tg(full_text)
    if ok:
        log.info('Sent to TG! Marking all as read...')
        for em in all_emails:
            mark_as_read(em['id'])
            time.sleep(0.2)
        log.info('Done! %d emails marked as read', len(all_emails))
    else:
        log.error('TG send failed, NOT marking as read')
else:
    send_tg('❌ AI 摘要生成失败，请稍后重试')
    log.error('AI summary failed')

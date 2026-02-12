# Clawdbot 部署指南

> 域名: `clawdbot.cyberoracle.net`
> 服务器: `139.180.180.38`

## 📁 文件清单

| 文件                  | 用途               | 放置位置                      |
| --------------------- | ------------------ | ----------------------------- |
| `.env.template`       | 环境变量模板       | 复制为 `.env` 并填写          |
| `openclaw.json`       | 主配置文件 (JSON5) | `~/.openclaw/openclaw.json`   |
| `nginx-clawdbot.conf` | Nginx 配置         | `/etc/nginx/sites-available/` |
| `clawdbot.service`    | Systemd 服务       | `/etc/systemd/system/`        |
| `install.sh`          | 一键安装脚本       | 运行一次                      |

## 🚀 快速部署

### 方式一：一键脚本（推荐）

```bash
# SSH 登录服务器
ssh root@139.180.180.38

# 下载并运行安装脚本
curl -fsSL https://raw.githubusercontent.com/你的仓库/deploy/install.sh | sudo bash
```

### 方式二：手动部署

```bash
# 1. 安装 Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# 2. 安装 pnpm
sudo npm install -g pnpm

# 3. 创建用户和目录
sudo useradd -m -s /bin/bash clawdbot
sudo -u clawdbot git clone https://github.com/anthropics/clawdbot.git /home/clawdbot/clawdbot

# 4. 构建
cd /home/clawdbot/clawdbot
sudo -u clawdbot pnpm install
sudo -u clawdbot pnpm build

# 5. 配置
sudo -u clawdbot mkdir -p ~/.openclaw
sudo -u clawdbot cp deploy/openclaw.json ~/.openclaw/openclaw.json
sudo -u clawdbot cp deploy/.env.template .env
sudo -u clawdbot nano .env  # 填写 API Keys

# 6. 安装服务
sudo cp deploy/clawdbot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable clawdbot
sudo systemctl start clawdbot
```

## 🔑 需要填写的 API Keys

| Key                  | 申请地址                           | 说明     |
| -------------------- | ---------------------------------- | -------- |
| `TELEGRAM_BOT_TOKEN` | @BotFather                         | 必填     |
| `MINIMAX_API_KEY`    | https://platform.minimax.io/       | 主力模型 |
| `GOOGLE_API_KEY`     | https://aistudio.google.com/apikey | Gemini   |
| `DEEPSEEK_API_KEY`   | https://platform.deepseek.com/     | 备选     |

## 📱 Telegram Bot 创建

1. 打开 Telegram，搜索 `@BotFather`
2. 发送 `/newbot`
3. 输入 Bot 名称: `CyberOracle Assistant`
4. 输入 Bot 用户名: `cyberoracle_ai_bot`（必须以 `bot` 结尾）
5. 复制返回的 Token

## 👥 添加授权用户

获取 Telegram User ID 的方法：

1. **方法一**: DM `@userinfobot`，它会返回你的 ID
2. **方法二**: DM 你的 bot，查看服务器日志中的 `from.id`
   ```bash
   journalctl -u clawdbot -f | grep "from.id"
   ```

然后编辑 `~/.openclaw/openclaw.json`：

```json5
"channels": {
  "telegram": {
    "allowFrom": [
      "123456789",    // 你的 ID
      "987654321"     // 朋友 1
    ]
  }
}
```

## 🔄 模型切换命令

在 Telegram 中发送：

```
/model              # 查看可用模型
/model minimax      # 切换到 MiniMax
/model gemini       # 切换到 Gemini
/model gemini-pro   # 切换到 Gemini Pro
/model deepseek     # 切换到 DeepSeek
/status             # 查看当前状态
/help               # 查看帮助
```

## 🛠️ 常用管理命令

```bash
# 服务管理
sudo systemctl start clawdbot     # 启动
sudo systemctl stop clawdbot      # 停止
sudo systemctl restart clawdbot   # 重启
sudo systemctl status clawdbot    # 状态

# 查看日志
journalctl -u clawdbot -f         # 实时日志
journalctl -u clawdbot --since "1 hour ago"  # 最近1小时

# Nginx
sudo nginx -t                     # 测试配置
sudo systemctl reload nginx       # 重载配置

# SSL 证书
sudo certbot renew --dry-run      # 测试续期
```

## 📊 资源监控

```bash
# 内存使用
free -h

# 服务资源
systemctl status clawdbot

# 实时监控
htop
```

## ❓ 故障排查

### Bot 不响应

1. 检查服务状态: `systemctl status clawdbot`
2. 查看日志: `journalctl -u clawdbot -f`
3. 确认 Bot Token 正确
4. 确认用户 ID 在 allowFrom 列表中

### 网页无法访问

1. 检查 Nginx: `nginx -t`
2. 检查 DNS 解析: `dig clawdbot.cyberoracle.net`
3. 检查防火墙: `ufw status`

### 模型调用失败

1. 检查 API Key 是否正确
2. 检查余额/配额
3. 查看日志中的错误信息

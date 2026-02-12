#!/bin/bash
# ============================================
# Clawdbot 一键部署脚本
# 域名: clawdbot.cyberoracle.net
# 服务器: 139.180.180.38
# ============================================

set -e  # 遇到错误立即退出

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 打印函数
info() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# 检查 root 权限
if [ "$EUID" -ne 0 ]; then
    error "请使用 sudo 运行此脚本"
fi

echo ""
echo "============================================"
echo "  Clawdbot 部署脚本"
echo "  域名: clawdbot.cyberoracle.net"
echo "============================================"
echo ""

# ============================================
# Step 1: 系统更新
# ============================================
info "Step 1: 更新系统包..."
apt update && apt upgrade -y
success "系统更新完成"

# ============================================
# Step 2: 安装依赖
# ============================================
info "Step 2: 安装必要依赖..."
apt install -y curl git build-essential nginx certbot python3-certbot-nginx

# 安装 Node.js 22 (使用 NodeSource)
if ! command -v node &> /dev/null || [[ $(node -v | cut -d'.' -f1 | tr -d 'v') -lt 22 ]]; then
    info "安装 Node.js 22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt install -y nodejs
fi
success "Node.js $(node -v) 已安装"

# 安装 pnpm
if ! command -v pnpm &> /dev/null; then
    info "安装 pnpm..."
    npm install -g pnpm
fi
success "pnpm $(pnpm -v) 已安装"

# ============================================
# Step 3: 创建专用用户
# ============================================
info "Step 3: 创建 clawdbot 用户..."
if ! id "clawdbot" &>/dev/null; then
    useradd -m -s /bin/bash clawdbot
    success "用户 clawdbot 已创建"
else
    info "用户 clawdbot 已存在"
fi

# ============================================
# Step 4: 克隆/更新代码
# ============================================
info "Step 4: 获取 Clawdbot 代码..."
INSTALL_DIR="/home/clawdbot/clawdbot"

if [ -d "$INSTALL_DIR" ]; then
    info "更新现有代码..."
    cd "$INSTALL_DIR"
    sudo -u clawdbot git pull
else
    info "克隆代码仓库..."
    sudo -u clawdbot git clone https://github.com/anthropics/clawdbot.git "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# ============================================
# Step 5: 安装依赖并构建
# ============================================
info "Step 5: 安装依赖并构建..."
cd "$INSTALL_DIR"
sudo -u clawdbot pnpm install --frozen-lockfile
sudo -u clawdbot pnpm build
sudo -u clawdbot pnpm ui:build || true  # UI 构建可选
success "构建完成"

# ============================================
# Step 6: 创建数据目录
# ============================================
info "Step 6: 创建数据目录..."
sudo -u clawdbot mkdir -p "$INSTALL_DIR/data/config"
sudo -u clawdbot mkdir -p "$INSTALL_DIR/data/workspace"
success "数据目录已创建"

# ============================================
# Step 7: 配置文件
# ============================================
info "Step 7: 检查配置文件..."

if [ ! -f "$INSTALL_DIR/.env" ]; then
    warn ".env 文件不存在，请手动创建并填写 API Keys"
    echo ""
    echo "  cp deploy/.env.template .env"
    echo "  nano .env  # 编辑填写你的 API Keys"
    echo ""
fi

OPENCLAW_DIR="/home/clawdbot/.openclaw"
OPENCLAW_CFG="$OPENCLAW_DIR/openclaw.json"
sudo -u clawdbot mkdir -p "$OPENCLAW_DIR"

if [ ! -f "$OPENCLAW_CFG" ]; then
    if [ -f "$INSTALL_DIR/deploy/openclaw.json" ]; then
        cp "$INSTALL_DIR/deploy/openclaw.json" "$OPENCLAW_CFG"
        chown clawdbot:clawdbot "$OPENCLAW_CFG"
        success "openclaw.json 已复制到 $OPENCLAW_CFG"
    fi
fi

# ============================================
# Step 8: 配置 systemd 服务
# ============================================
info "Step 8: 配置 systemd 服务..."
cp "$INSTALL_DIR/deploy/clawdbot.service" /etc/systemd/system/clawdbot.service
systemctl daemon-reload
systemctl enable clawdbot
success "systemd 服务已配置"

# ============================================
# Step 9: 配置 Nginx
# ============================================
info "Step 9: 配置 Nginx..."

# 复制 Nginx 配置
cp "$INSTALL_DIR/deploy/nginx-clawdbot.conf" /etc/nginx/sites-available/clawdbot

# 启用站点
if [ ! -L /etc/nginx/sites-enabled/clawdbot ]; then
    ln -s /etc/nginx/sites-available/clawdbot /etc/nginx/sites-enabled/clawdbot
fi

# 测试 Nginx 配置
nginx -t
success "Nginx 配置完成"

# ============================================
# Step 10: 配置 DNS 提醒
# ============================================
echo ""
warn "请确保 DNS 已配置:"
echo "  clawdbot.cyberoracle.net -> 139.180.180.38"
echo ""

# ============================================
# Step 11: SSL 证书
# ============================================
read -p "是否现在申请 SSL 证书? (y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    info "申请 Let's Encrypt SSL 证书..."
    certbot --nginx -d clawdbot.cyberoracle.net --non-interactive --agree-tos --email admin@cyberoracle.net
    success "SSL 证书已配置"
else
    warn "跳过 SSL 配置，稍后运行: certbot --nginx -d clawdbot.cyberoracle.net"
fi

# ============================================
# 完成
# ============================================
echo ""
echo "============================================"
success "Clawdbot 安装完成!"
echo "============================================"
echo ""
echo "下一步操作:"
echo ""
echo "1. 编辑环境配置:"
echo "   cd /home/clawdbot/clawdbot"
echo "   cp deploy/.env.template .env"
echo "   nano .env  # 填写所有 API Keys"
echo ""
echo "2. 编辑 openclaw.json，添加授权用户 Telegram ID:"
echo "   nano ~/.openclaw/openclaw.json"
echo ""
echo "3. 启动服务:"
echo "   systemctl start clawdbot"
echo "   systemctl status clawdbot"
echo ""
echo "4. 查看日志:"
echo "   journalctl -u clawdbot -f"
echo ""
echo "5. 在 Telegram 中测试:"
echo "   - 搜索你的 Bot 用户名"
echo "   - 发送消息开始使用"
echo ""
echo "管理命令:"
echo "  systemctl start clawdbot    # 启动"
echo "  systemctl stop clawdbot     # 停止"
echo "  systemctl restart clawdbot  # 重启"
echo "  systemctl status clawdbot   # 状态"
echo ""

#!/bin/bash
# ============================================
# Chrome 自动启动脚本 (直接 CDP 连接)
# 无需手动点击扩展 - Clawdbot 直接连接
# ============================================

set -e

# 配置
CHROME_DEBUG_PORT=9222
CHROME_PROFILE="Profile 1"
# 使用独立的用户数据目录 (远程调试需要非默认目录)
CHROME_USER_DATA="/home/linuxuser/.chrome-clawdbot"
DISPLAY_NUM=${DISPLAY:-:1}

# 颜色
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

export DISPLAY=$DISPLAY_NUM

# 检查是否已有 Chrome 在运行
if pgrep -f "google-chrome.*--remote-debugging-port=$CHROME_DEBUG_PORT" > /dev/null; then
    warn "Chrome 已在调试端口 $CHROME_DEBUG_PORT 上运行"
    # 检查端口是否可用
    if curl -s "http://127.0.0.1:$CHROME_DEBUG_PORT/json/version" > /dev/null 2>&1; then
        success "Chrome CDP 连接正常"
        curl -s "http://127.0.0.1:$CHROME_DEBUG_PORT/json/version" | head -5
        exit 0
    fi
fi

# 关闭现有 Chrome 实例
info "关闭现有 Chrome 实例..."
pkill -f google-chrome 2>/dev/null || true
sleep 2

# 清理可能残留的锁文件
rm -f "$CHROME_USER_DATA/SingletonLock" "$CHROME_USER_DATA/SingletonSocket" "$CHROME_USER_DATA/SingletonCookie" 2>/dev/null || true

# 启动 Chrome
info "启动 Chrome..."
info "  调试端口: $CHROME_DEBUG_PORT"
info "  Profile: $CHROME_PROFILE"
info "  Display: $DISPLAY_NUM"

google-chrome \
    --remote-debugging-port=$CHROME_DEBUG_PORT \
    --user-data-dir="$CHROME_USER_DATA" \
    --profile-directory="$CHROME_PROFILE" \
    --no-first-run \
    --no-sandbox \
    --disable-setuid-sandbox \
    --disable-dev-shm-usage \
    --disable-session-crashed-bubble \
    --disable-infobars \
    --start-maximized \
    "https://mail.google.com" &

# 等待 Chrome 启动
info "等待 Chrome 启动..."
for i in {1..30}; do
    if curl -s "http://127.0.0.1:$CHROME_DEBUG_PORT/json/version" > /dev/null 2>&1; then
        success "Chrome 启动成功!"
        echo ""
        echo "============================================"
        echo "  Chrome CDP 信息"
        echo "============================================"
        curl -s "http://127.0.0.1:$CHROME_DEBUG_PORT/json/version" | grep -E "(Browser|webSocketDebuggerUrl)"
        echo ""
        echo "============================================"
        echo "  Clawdbot 可以直接连接到:"
        echo "  http://127.0.0.1:$CHROME_DEBUG_PORT"
        echo ""
        echo "  无需手动点击 Chrome 扩展!"
        echo "============================================"
        exit 0
    fi
    sleep 1
done

warn "Chrome 启动超时，请检查日志"
exit 1

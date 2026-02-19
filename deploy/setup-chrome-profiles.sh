#!/bin/bash
# ============================================
# Chrome Profile 设置脚本
# 用于在 VPS 上创建和管理浏览器 Profile
# ============================================

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Chrome 用户数据目录
CHROME_USER_DATA="${HOME}/.config/google-chrome"

echo ""
echo "============================================"
echo "  Chrome Profile 管理工具"
echo "============================================"
echo ""

# 检查 Chrome 是否安装
check_chrome() {
    if command -v google-chrome &> /dev/null; then
        success "Google Chrome 已安装: $(google-chrome --version)"
    elif command -v chromium-browser &> /dev/null; then
        success "Chromium 已安装: $(chromium-browser --version)"
        CHROME_CMD="chromium-browser"
    else
        warn "Chrome 未安装，正在安装..."
        install_chrome
    fi
}

# 安装 Chrome
install_chrome() {
    info "下载 Google Chrome..."
    wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
    sudo apt install -y /tmp/chrome.deb
    rm /tmp/chrome.deb
    success "Google Chrome 安装完成"
}

# 列出现有 Profile
list_profiles() {
    info "现有 Chrome Profiles:"
    echo ""

    if [ -d "$CHROME_USER_DATA" ]; then
        # 默认 Profile
        if [ -d "$CHROME_USER_DATA/Default" ]; then
            echo "  - Default (默认)"
        fi

        # 其他 Profile
        for dir in "$CHROME_USER_DATA"/Profile\ *; do
            if [ -d "$dir" ]; then
                profile_name=$(basename "$dir")
                echo "  - $profile_name"
            fi
        done
    else
        warn "Chrome 用户数据目录不存在: $CHROME_USER_DATA"
        warn "首次运行 Chrome 会自动创建"
    fi
    echo ""
}

# 创建新 Profile
create_profile() {
    local profile_name=$1

    if [ -z "$profile_name" ]; then
        read -p "请输入 Profile 名称 (如 Profile 1): " profile_name
    fi

    local profile_dir="$CHROME_USER_DATA/$profile_name"

    if [ -d "$profile_dir" ]; then
        warn "Profile 已存在: $profile_name"
    else
        mkdir -p "$profile_dir"
        success "Profile 创建成功: $profile_name"
    fi

    echo ""
    echo "下一步: 启动 Chrome 并登录账号"
    echo "  ./setup-chrome-profiles.sh login \"$profile_name\""
    echo ""
}

# 启动 Chrome 登录（需要 GUI 或 VNC）
launch_for_login() {
    local profile_name=${1:-"Default"}

    info "启动 Chrome Profile: $profile_name"
    warn "注意: 需要 GUI 环境或 VNC 连接"
    echo ""

    # 检查是否有显示器
    if [ -z "$DISPLAY" ]; then
        warn "未检测到 DISPLAY 环境变量"
        echo ""
        echo "选项 1: 使用 VNC"
        echo "  1. 安装 VNC: sudo apt install tigervnc-standalone-server"
        echo "  2. 启动 VNC: vncserver :1"
        echo "  3. 设置 DISPLAY: export DISPLAY=:1"
        echo "  4. 重新运行此脚本"
        echo ""
        echo "选项 2: 使用 X11 转发 (本地有 X Server)"
        echo "  ssh -X user@server"
        echo ""
        echo "选项 3: 在本地登录后复制 Profile"
        echo "  1. 本地 Chrome 登录账号"
        echo "  2. 复制 Profile 目录到服务器"
        echo ""
        return 1
    fi

    google-chrome \
        --user-data-dir="$CHROME_USER_DATA" \
        --profile-directory="$profile_name" \
        --no-first-run \
        --start-maximized &

    success "Chrome 已启动，请登录你的账号"
    echo ""
    echo "登录完成后:"
    echo "1. 关闭 Chrome"
    echo "2. Profile 会保存登录状态"
    echo "3. Clawdbot 可以使用此 Profile"
}

# 测试 Profile（无头模式）
test_profile() {
    local profile_name=${1:-"Default"}

    info "测试 Profile (无头模式): $profile_name"

    # 使用 Node.js 测试
    node << EOF
const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launchPersistentContext(
        '$CHROME_USER_DATA/$profile_name',
        {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    );

    const page = await browser.newPage();
    await page.goto('https://x.com');

    // 检查是否已登录
    const isLoggedIn = await page.evaluate(() => {
        return document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]') !== null;
    });

    if (isLoggedIn) {
        console.log('✅ X (Twitter) 已登录');
    } else {
        console.log('❌ X (Twitter) 未登录');
    }

    await browser.close();
})();
EOF
}

# 显示帮助
show_help() {
    echo "用法: $0 <命令> [参数]"
    echo ""
    echo "命令:"
    echo "  check           检查 Chrome 安装"
    echo "  list            列出所有 Profile"
    echo "  create <name>   创建新 Profile"
    echo "  login <name>    启动 Chrome 登录账号"
    echo "  test <name>     测试 Profile 登录状态"
    echo ""
    echo "示例:"
    echo "  $0 check"
    echo "  $0 list"
    echo "  $0 create \"Profile 1\""
    echo "  $0 login \"Profile 1\""
    echo ""
}

# 主逻辑
case "${1:-help}" in
    check)
        check_chrome
        ;;
    list)
        list_profiles
        ;;
    create)
        create_profile "$2"
        ;;
    login)
        launch_for_login "$2"
        ;;
    test)
        test_profile "$2"
        ;;
    *)
        show_help
        ;;
esac

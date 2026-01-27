#!/usr/bin/env python3
"""
Mac 应用启动器 - 快速打开常用的股票交易软件
用法: python scripts/open-apps.py [command]
"""

import subprocess
import sys

# 应用配置
APPS = {
    "ths": {"name": "同花顺", "app": "同花顺.app"},
    "tiger": {"name": "Tiger Trade", "app": "Tiger Trade.app"},
}


def open_app(app_path: str) -> bool:
    """打开指定的 Mac 应用"""
    try:
        subprocess.run(["open", "-a", app_path], check=True)
        return True
    except subprocess.CalledProcessError:
        return False


def list_apps():
    """列出所有可用的应用"""
    print("可用的应用:")
    for key, info in APPS.items():
        print(f"  {key:10} - {info['name']}")


def main():
    if len(sys.argv) < 2:
        print("用法: python open-apps.py <command>")
        print()
        list_apps()
        print()
        print("命令:")
        print("  all       - 打开所有应用")
        print("  list      - 列出所有可用应用")
        return

    cmd = sys.argv[1].lower()

    if cmd == "list":
        list_apps()
    elif cmd == "all":
        for key, info in APPS.items():
            print(f"正在打开 {info['name']}...")
            if open_app(info["app"]):
                print(f"  ✓ {info['name']} 已打开")
            else:
                print(f"  ✗ 无法打开 {info['name']}")
    elif cmd in APPS:
        info = APPS[cmd]
        print(f"正在打开 {info['name']}...")
        if open_app(info["app"]):
            print(f"✓ {info['name']} 已打开")
        else:
            print(f"✗ 无法打开 {info['name']}")
    else:
        print(f"未知命令: {cmd}")
        print()
        list_apps()


if __name__ == "__main__":
    main()

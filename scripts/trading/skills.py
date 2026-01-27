#!/usr/bin/env python3
"""
交易技能系统 - Mac 应用控制与屏幕分析
用于 Clawdbot 自动化交易场景
"""

import subprocess
import os
import sys
from pathlib import Path
from datetime import datetime
from typing import Optional

# 脚本目录
SCRIPT_DIR = Path(__file__).parent

# 应用配置：名称、默认窗口位置和大小
APPS = {
    "tiger": {
        "name": "Tiger Trade",
        "bounds": {"x": 100, "y": 100, "width": 1280, "height": 800},
    },
    "ths": {
        "name": "同花顺",
        "bounds": {"x": 100, "y": 100, "width": 1280, "height": 800},
    },
}

# 截图保存目录
SCREENSHOT_DIR = Path.home() / ".clawdbot" / "screenshots"


class TradingSkills:
    """交易技能集合"""

    def __init__(self):
        SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

    # ========== UI 导航技能 ==========

    def activate_app(self, app_key: str) -> str:
        """
        激活指定应用（置顶并聚焦）
        app_key: tiger, ths
        """
        if app_key not in APPS:
            return f"未知应用: {app_key}，可用: {list(APPS.keys())}"

        app_name = APPS[app_key]["name"]
        try:
            subprocess.run(
                ["osascript", "-e", f'tell application "{app_name}" to activate'],
                check=True,
                capture_output=True,
            )
            return f"✓ {app_name} 已激活"
        except subprocess.CalledProcessError as e:
            return f"✗ 激活失败: {e.stderr.decode()}"

    def reset_window(
        self,
        app_key: str,
        x: Optional[int] = None,
        y: Optional[int] = None,
        width: Optional[int] = None,
        height: Optional[int] = None,
    ) -> str:
        """
        重置应用窗口位置和大小（归位技能）
        app_key: tiger, ths
        x, y, width, height: 可选，不传则使用默认值
        """
        if app_key not in APPS:
            return f"未知应用: {app_key}"

        config = APPS[app_key]
        app_name = config["name"]
        bounds = config["bounds"]

        x = x or bounds["x"]
        y = y or bounds["y"]
        width = width or bounds["width"]
        height = height or bounds["height"]

        script_path = SCRIPT_DIR / "window_control.scpt"
        try:
            subprocess.run(
                ["osascript", str(script_path), app_name, str(x), str(y), str(width), str(height)],
                check=True,
                capture_output=True,
            )
            return f"✓ {app_name} 已归位到 ({x}, {y}) 大小 {width}x{height}"
        except subprocess.CalledProcessError as e:
            return f"✗ 归位失败: {e.stderr.decode()}"

    def close_app(self, app_key: str) -> str:
        """关闭指定应用"""
        if app_key not in APPS:
            return f"未知应用: {app_key}"

        app_name = APPS[app_key]["name"]
        try:
            subprocess.run(
                ["osascript", "-e", f'tell application "{app_name}" to quit'],
                check=True,
                capture_output=True,
            )
            return f"✓ {app_name} 已关闭"
        except subprocess.CalledProcessError as e:
            return f"✗ 关闭失败: {e.stderr.decode()}"

    def open_all(self) -> str:
        """打开所有交易应用"""
        results = []
        for key in APPS:
            results.append(self.activate_app(key))
        return "\n".join(results)

    def close_all(self) -> str:
        """关闭所有交易应用"""
        results = []
        for key in APPS:
            results.append(self.close_app(key))
        return "\n".join(results)

    def reset_all_windows(self) -> str:
        """重置所有交易应用窗口位置"""
        results = []
        for key in APPS:
            results.append(self.reset_window(key))
        return "\n".join(results)

    # ========== 截图技能 ==========

    def capture_screen(self, filename: Optional[str] = None) -> str:
        """
        全屏截图
        返回截图路径
        """
        if not filename:
            filename = f"screen_{datetime.now().strftime('%Y%m%d_%H%M%S')}.png"
        filepath = SCREENSHOT_DIR / filename

        try:
            subprocess.run(["screencapture", "-x", str(filepath)], check=True)
            return f"✓ 截图已保存: {filepath}"
        except subprocess.CalledProcessError as e:
            return f"✗ 截图失败: {e}"

    def capture_region(
        self, x: int, y: int, width: int, height: int, filename: Optional[str] = None
    ) -> str:
        """
        局部截图（指定区域）
        x, y: 左上角坐标
        width, height: 宽高
        返回截图路径
        """
        if not filename:
            filename = f"region_{datetime.now().strftime('%Y%m%d_%H%M%S')}.png"
        filepath = SCREENSHOT_DIR / filename

        # screencapture -R 格式: x,y,width,height
        region = f"{x},{y},{width},{height}"
        try:
            subprocess.run(["screencapture", "-x", "-R", region, str(filepath)], check=True)
            return f"✓ 区域截图已保存: {filepath}"
        except subprocess.CalledProcessError as e:
            return f"✗ 截图失败: {e}"

    def capture_window(self, app_key: str, filename: Optional[str] = None) -> str:
        """
        截取指定应用窗口
        """
        if app_key not in APPS:
            return f"未知应用: {app_key}"

        if not filename:
            filename = f"{app_key}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.png"
        filepath = SCREENSHOT_DIR / filename

        app_name = APPS[app_key]["name"]

        # 先激活窗口
        self.activate_app(app_key)

        # 使用 screencapture -l 截取指定窗口
        # 需要获取窗口 ID
        try:
            # 获取窗口列表
            result = subprocess.run(
                [
                    "osascript",
                    "-e",
                    f'tell application "System Events" to get id of first window of process "{app_name}"',
                ],
                capture_output=True,
                text=True,
            )
            if result.returncode == 0:
                # 使用交互式窗口选择（-w）带延迟
                subprocess.run(["screencapture", "-x", "-o", "-w", "-T0", str(filepath)], check=True)
                return f"✓ 窗口截图已保存: {filepath}"
            else:
                # 回退到全屏
                return self.capture_screen(filename)
        except Exception as e:
            return f"✗ 窗口截图失败: {e}"

    # ========== 紧急控制 ==========

    def emergency_stop(self) -> str:
        """
        紧急停止：关闭所有交易应用
        当检测到异常时调用
        """
        results = ["⚠️ 紧急停止已触发"]
        results.append(self.close_all())
        # 可以在这里添加通知逻辑
        return "\n".join(results)


# ========== CLI 入口 ==========


def main():
    """命令行入口"""
    skills = TradingSkills()

    if len(sys.argv) < 2:
        print("交易技能系统")
        print()
        print("用法: python skills.py <command> [args...]")
        print()
        print("窗口控制:")
        print("  activate <app>        激活应用 (tiger, ths)")
        print("  reset <app>           重置窗口位置")
        print("  close <app>           关闭应用")
        print("  open-all              打开所有应用")
        print("  close-all             关闭所有应用")
        print("  reset-all             重置所有窗口")
        print()
        print("截图:")
        print("  screen                全屏截图")
        print("  region x y w h        区域截图")
        print("  window <app>          窗口截图")
        print()
        print("紧急:")
        print("  stop                  紧急停止")
        return

    cmd = sys.argv[1]

    if cmd == "activate" and len(sys.argv) > 2:
        print(skills.activate_app(sys.argv[2]))
    elif cmd == "reset" and len(sys.argv) > 2:
        print(skills.reset_window(sys.argv[2]))
    elif cmd == "close" and len(sys.argv) > 2:
        print(skills.close_app(sys.argv[2]))
    elif cmd == "open-all":
        print(skills.open_all())
    elif cmd == "close-all":
        print(skills.close_all())
    elif cmd == "reset-all":
        print(skills.reset_all_windows())
    elif cmd == "screen":
        print(skills.capture_screen())
    elif cmd == "region" and len(sys.argv) >= 6:
        x, y, w, h = map(int, sys.argv[2:6])
        print(skills.capture_region(x, y, w, h))
    elif cmd == "window" and len(sys.argv) > 2:
        print(skills.capture_window(sys.argv[2]))
    elif cmd == "stop":
        print(skills.emergency_stop())
    else:
        print(f"未知命令: {cmd}")


if __name__ == "__main__":
    main()

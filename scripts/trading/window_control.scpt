-- 窗口控制脚本：激活并重置交易软件窗口位置
-- 用法: osascript window_control.scpt "appName" x y width height

on run argv
    set appName to item 1 of argv
    set xPos to (item 2 of argv) as integer
    set yPos to (item 3 of argv) as integer
    set winWidth to (item 4 of argv) as integer
    set winHeight to (item 5 of argv) as integer

    tell application appName
        activate
        reopen
        delay 0.3
        try
            set bounds of window 1 to {xPos, yPos, xPos + winWidth, yPos + winHeight}
        end try
    end tell

    return "OK"
end run

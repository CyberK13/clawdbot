---
name: email
description: Gmail OAuth 授权管理 - 通过聊天完成 Gmail 账号绑定
user-invocable: true
metadata: { "clawdbot": { "emoji": "📧", "requires": { "bins": ["gog"] } } }
---

# Gmail 授权技能 (/email)

此技能帮助用户通过聊天完成 Gmail OAuth 授权。

## 使用方法

用户发送 `/email` 时，按以下流程操作：

### 1. 检查授权状态

首先检查用户是否已授权：

```bash
gog auth list --json 2>/dev/null || echo "[]"
```

### 2. 如果未授权，生成授权链接

为用户生成 OAuth 授权链接：

```bash
# 启动授权流程（会输出授权 URL）
gog auth add USER_EMAIL --services gmail --no-browser 2>&1
```

将输出的授权链接发送给用户，提示用户：

1. 点击链接在浏览器中打开
2. 登录 Google 账号并授权
3. 复制授权成功后显示的授权码
4. 将授权码发送回来

### 3. 用户发送授权码后

当用户发送授权码时，完成授权：

```bash
# 授权码通常是类似 4/0AY0e-g7... 的格式
# gog 会自动处理授权码
echo "CODE_FROM_USER" | gog auth add USER_EMAIL --services gmail --no-browser
```

### 4. 验证授权成功

```bash
gog auth list --account USER_EMAIL
```

## 命令变体

- `/email` 或 `/email status` - 检查当前授权状态
- `/email auth` 或 `/email 授权` - 开始授权流程
- `/email CODE` - 提交授权码（CODE 是用户从 Google 页面复制的）

## 用户交互示例

**用户**: `/email`

**回复**:

```
📧 Gmail 授权状态

当前账号: jtao8816@gmail.com
状态: ❌ 未授权

发送 `/email auth` 开始授权流程
```

**用户**: `/email auth`

**回复**:

```
🔐 Gmail 授权流程

请点击以下链接完成授权：
https://accounts.google.com/o/oauth2/v2/auth?...

步骤：
1. 点击上方链接
2. 登录你的 Google 账号 (jtao8816@gmail.com)
3. 点击"允许"授权
4. 复制页面显示的授权码
5. 将授权码发送给我，格式：/email 授权码

⏳ 等待你的授权码...
```

**用户**: `/email 4/0AY0e-g7xxxxx`

**回复**:

```
✅ Gmail 授权成功！

账号: jtao8816@gmail.com
服务: Gmail
状态: 已连接

现在可以使用邮件相关功能了。
```

## 错误处理

- 如果授权码无效，提示用户重新获取
- 如果 gog 未安装，提示安装方法
- 如果网络问题，提示检查网络连接

## 注意事项

- 授权码有效期约 10 分钟，过期需重新获取
- 每个 Gmail 账号只需授权一次
- 授权信息存储在本地，重启后仍有效

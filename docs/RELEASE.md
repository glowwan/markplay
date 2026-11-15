# 发布、签名与二进制管理

> 现状：安装包**未签名**，首次运行会被 Windows SmartScreen 拦成"未知发布者"。
> 这不是 bug，是缺一张代码签名证书 —— 需要花钱 + 实名认证，只能由你办。
>
> 本文给出：证书怎么选、拿到之后怎么签、怎么验证、以及**在没有证书时已把流程验证到什么程度**。

## 1. 先分清三件事

| 概念 | 作用 | 没有它会怎样 |
|---|---|---|
| **Authenticode 代码签名** | 证明 exe/安装包来自你、且未被篡改 | SmartScreen 警告、企业环境可能直接拦截 |
| **SmartScreen 信誉** | 微软根据签名证书 + 下载量累积的声誉 | 新证书/新包仍可能提示，需要时间累积 |
| **SHA256 校验和** | 让用户能验证下载完整 | 无法区分"官方包"和"被替换的包" |

**签名 ≠ 立刻没有提示。** OV 证书通常要一段下载量积累；EV 证书历史上更容易快速建立信誉；
新证书 + 新包的前几次下载仍可能提示。这是微软的声誉机制，不是你的配置问题。

## 2. 证书方案对比

价格随 CA 促销浮动，签约前以官网为准。

| 方案 | 大概成本 | 适合 | 注意 |
|---|---|---|---|
| **OV 代码签名证书** | 约 $200–400/年 | 个人/小团队 | 需实名材料；私钥不能进 CI，要云签名或 HSM |
| **EV 代码签名证书** | 约 $300–600/年 + 硬件令牌 | 想尽快减少提示 | 必须用硬件令牌，CI 里要接 USB/云 HSM |
| **Azure Trusted Signing** | 按签名次数计费（约 $10/月起） | 没有硬件令牌、想走 CI | 需 Azure 订阅 + 身份验证；用 `signtool` 的 dlib 模式接入 |
| **SignPath / 开源签名计划** | 对符合条件的开源项目免费或低价 | 纯开源 | 审核周期长，需公开仓库与可复现构建 |
| **自签名证书** | 免费 | **仅本机验证流程** | 对外发布**没有任何意义**，SmartScreen 照拦 |

对个人项目，**OV 或 Azure Trusted Signing** 是性价比最高的两个选择。
只有在意"第一次下载就没有警告"才值得上 EV。

## 3. 已经验证过的部分（不需要证书）

在没有真实证书的情况下，以下环节已用**自签名测试证书实测通过**：

| 环节 | 结果 |
|---|---|
| `signtool.exe` 可用性 | ✅ 走 electron-builder 缓存的 `winCodeSign`，**不用装 Windows SDK** |
| PFX 导入签名 | ✅ `signtool sign /f x.pfx /p *** /fd SHA256` 成功 |
| 证书存储按指纹签名 | ✅ `signtool sign /sha1 <thumbprint>` 成功 |
| RFC3161 时间戳 | ✅ 拿到 DigiCert 时间戳（`CN=DigiCert SHA256 RSA4096 Timestamp Responder`） |
| 摘要算法 | ✅ `sha256RSA` |
| 签名结果可被读取 | ✅ `SignerCertificate.Subject` = 证书主体，`TimeStamperCertificate` 非空 |
| 唯一失败项 | 证书链根不受信任 —— 自签名证书的**预期行为** |

也就是说：**拿到真实证书后，只需换证书路径，命令一行不用改。**

## 4. 拿到证书之后

### 4.1 先自检环境

```powershell
npm run sign:check
```

会打印 signtool 路径和本机所有代码签名证书。若显示"（无）"，说明证书没导入。

### 4.2 方式 A：构建时自动签名（推荐）

electron-builder 直接读 `CSC_LINK` / `CSC_KEY_PASSWORD`：

```powershell
$env:CSC_LINK = "C:\keys\mycert.pfx"
$env:CSC_KEY_PASSWORD = "你的证书密码"
npm run dist
```

`package.json` 里已经配好：

```json
"signingHashAlgorithms": ["sha256"],
"rfc3161TimeStampServer": "http://timestamp.digicert.com"
```

**时间戳服务器必须配置**，否则证书过期后旧安装包签名失效。

> `CSC_LINK` 也可以是 base64 编码的 PFX（CI 里常用）：
> `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx"))`

### 4.3 方式 B：对已有产物补签

```powershell
# PFX
npm run sign -- -File "dist\MarkPlay Setup 1.6.0.exe" -Pfx "C:\keys\mycert.pfx" -Password "***"

# 证书已在存储里（EV 硬件令牌 / 已导入）
npm run sign -- -File "dist\MarkPlay Setup 1.6.0.exe" -Thumbprint "ABCD1234..."

# 靠环境变量
$env:CSC_LINK = "C:\keys\mycert.pfx"; $env:CSC_KEY_PASSWORD = "***"
npm run sign -- -File "dist\MarkPlay Setup 1.6.0.exe"
```

脚本会自动找 signtool、签名、然后**立刻校验并打印结论**，包括对"根不受信任"这种情况给出具体排查方向
（EKU 不对 / 中间证书缺失 / 买成了 SSL 证书）。

### 4.4 手动验证（不依赖脚本）

```powershell
signtool verify /pa /v "dist\MarkPlay Setup 1.6.0.exe"

Get-AuthenticodeSignature "dist\MarkPlay Setup 1.6.0.exe" |
  Format-List Status, StatusMessage, SignerCertificate, TimeStamperCertificate
```

**验收标准**：

- `Status = Valid`
- `SignerCertificate.Subject` 是期望主体
- `TimeStamperCertificate` **非空**（没时间戳的签名过期即失效）

### 4.5 别忘了未打包的 exe

`dist\win-unpacked\MarkPlay.exe` 也要签（有些用户直接跑免安装版）。
electron-builder 会自动签 `win-unpacked` 里的主程序和 `mpv.exe`、`ffmpeg.exe`，
但如果你手工替换过这些文件，需要重新 `npm run dist` 或逐个补签。

## 5. 构建前检查（每次发版）

```powershell
npm ci                 # 不要用 npm install，锁版本
npm test               # 132 个单元测试必须全过
npm run check:dom      # DOM id 与脚本引用
npm run fetch-bin      # 或确认 resources/bin 已是固定版本
npm run dist
```

## 6. 二进制固定与校验（建议改造 `tools/fetch-binaries.js`）

现在脚本拉的是 "latest"，mpv/ffmpeg 升级可能改变行为。建议：

1. 固定版本号（如 `mpv-0.42.0`、`ffmpeg-9.0`）与下载 URL；
2. 脚本内置期望 SHA256，下载后校验，不匹配直接失败；
3. 版本表放 `docs/BINARIES.md`：

```markdown
| 文件 | 版本 | SHA256 |
|------|------|--------|
| mpv.exe | 0.42.0-3-g902818753 | <hash> |
| ffmpeg.exe | 9.0.2-essentials | <hash> |
```

示意代码：

```js
const crypto = require('crypto');
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
if (sha256(target) !== expected[name]) throw new Error(`${name} 校验失败`);
```

## 7. 发布流程

1. 改版本号（三处：`package.json`、README 徽章、CHANGELOG —— PR 模板里有这条检查项）
2. `npm ci && npm test`
3. 设好 `CSC_LINK` / `CSC_KEY_PASSWORD`，`npm run dist`
4. `npm run sign:check` 确认证书被识别；`Get-AuthenticodeSignature` 确认 `Status = Valid`
5. 真机冒烟（见下）
6. 生成校验和：`Get-FileHash dist\*.exe -Algorithm SHA256 > dist\SHA256SUMS.txt`
7. 写 Release Notes（新增/修复/已知问题/校验和）
8. 打 tag、上传安装包 + SHA256SUMS
9. 若是自动更新，先发灰度包再全量

## 8. 真机冒烟矩阵

| 场景 | 检查点 |
|------|--------|
| 1080p H.264 / HEVC | 打开、播放、暂停、seek、scrub |
| 4K 长 GOP | scrub 是否积压、松手是否精确落点 |
| 无音轨 / 纯音频 | 不崩、时间轴正常、音量无报错 |
| 中文字幕 `.srt` / `.ass` | 自动加载、拖入加载、样式正常 |
| 双显示器不同缩放（100% + 150%） | 视频区不错位、全屏正常 |
| 全屏 + ESC / 快捷键 | 焦点不丢 |
| 剪辑 `-c copy` 与重编码 | 时长正确、体积接近源文件、失败能提示 |
| 批量剪辑 3+ 区间 / 合并 | 逐段完成、命名正确 |
| 转场识别 | 长片能出结果，灵敏度滑块即时生效 |
| 双开 | 第二实例把文件交给已开窗口 |
| 缺 mpv.exe | 有明确弹窗与指引 |

## 9. 回滚

- 安装包层面：保留上一个版本的安装包与 SHA256，Release 里注明"回滚请装上一版"；
- 自动更新：保留 `latest.yml` 的历史版本，必要时指回旧版本；
- 配置层面：`settings.json` 与 sidecar 都是向后兼容的（v1 → v2），回滚不会丢标记。

## 10. 日志与隐私

- `logs/markplay.log` 会包含本地文件路径、mpv/ffmpeg 参数，**不要自动上传**；
- 让用户手动提供日志时，提醒先删掉个人路径；
- 如果以后加崩溃上报，必须显式征得同意并提供关闭开关。

## 11. 附：本机测试证书

想在买证书前自己再验证一遍流程：

```powershell
.\tools\make-test-cert.ps1                      # 创建并导出 PFX 到 %TEMP%\mpsign
.\tools\sign.ps1 -File "dist\MarkPlay Setup 1.6.0.exe" `
  -Pfx "$env:TEMP\mpsign\test-signing.pfx" -Password "MarkPlayTest#2026"
.\tools\make-test-cert.ps1 -Remove              # 用完删掉
```

会出现 `Status: UnknownError` + "根不受信任"，**这是自签名证书的正常结果**。
如果换成买的证书后仍看到这句，按第 4.3 节末尾列的三条排查。
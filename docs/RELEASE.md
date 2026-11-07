# 发布、签名与二进制管理清单

> 现状：安装包**未签名**，首次运行会被 Windows SmartScreen 拦成"未知发布者"。这不是 bug，是缺一张代码签名证书。
> 本文给出可执行的签名方案、构建/发布流程、二进制固定与校验建议，以及回滚办法。

## 1. 先分清三件事

| 概念 | 作用 | 没有它会怎样 |
|------|------|--------------|
| **Authenticode 代码签名** | 证明 exe/安装包来自你、且未被篡改 | SmartScreen 警告、企业环境可能直接拦截 |
| **SmartScreen 信誉** | 微软根据签名证书 + 下载量累积的声誉 | 新证书/新包仍可能提示，需要时间累积 |
| **SHA256 校验和** | 让用户能验证下载完整 | 无法区分"官方包"和"被替换的包" |

签名不等于立刻没有提示：OV 证书通常需要一段下载量积累；EV 证书（硬件令牌/云签名）历史上更容易快速建立信誉，但成本更高。

## 2. 证书方案对比

| 方案 | 大概成本 | 适合 | 注意 |
|------|----------|------|------|
| **OV 代码签名证书** | 约 $200–400/年 | 个人/小团队 | 需要企业/个人实名材料；私钥不能进 CI，需云签名或 HSM |
| **EV 代码签名证书** | 约 $300–600/年 + 硬件令牌 | 想尽快减少 SmartScreen 提示 | 必须用硬件令牌，CI 里要接 USB/云 HSM |
| **Azure Trusted Signing** | 按签名次数计费（约 $10/月起，以官网为准） | 没有硬件令牌、想走 CI | 需要 Azure 订阅 + 身份验证；electron-builder 通过自定义 sign 钩子接入 |
| **SignPath / 开源签名计划** | 对符合条件的开源项目免费或低价 | 纯开源项目 | 审核周期长，需要公开仓库与构建流程 |
| **自签名证书** | 免费 | 仅内网测试 | 对外发布**没有意义**，SmartScreen 照样拦 |

> 价格与政策会变，签约前以 CA/Azure 官网为准。

## 3. electron-builder 配置（先留空，拿到证书再启用）

`package.json` 的 `build.win` 里预留：

```json
"win": {
  "target": [{ "target": "nsis", "arch": ["x64"] }],
  "signingHashAlgorithms": ["sha256"],
  "rfc3161TimeStampServer": "http://timestamp.digicert.com",
  "certificateFile": "build/cert.pfx",
  "certificatePassword": "${env.CSC_KEY_PASSWORD}"
}
```

要点：

1. **不要把 `.pfx` 提交到仓库**。`build/cert.pfx` 加进 `.gitignore`，CI 用 secret 注入；
2. `rfc3161TimeStampServer` 必须配置，否则证书过期后旧安装包签名失效；
3. 本地构建前设置环境变量：

```powershell
$env:CSC_KEY_PASSWORD = '你的证书密码'
npm run dist
```

4. Azure Trusted Signing 走自定义签名钩子（electron-builder 版本不同字段略有差异，以所用版本文档为准），思路是：`win.sign` 指向一个调用 `signtool` / Trusted Signing Client 的 JS 函数，把 `%1` 文件路径传进去。

## 4. 签名后必须验证

```powershell
# 1) 安装包与主程序都要验
signtool verify /pa /v "dist\MarkPlay Setup 1.0.0.exe"
signtool verify /pa /v "dist\win-unpacked\MarkPlay.exe"

# 2) PowerShell 里看签名主体与时间戳
Get-AuthenticodeSignature "dist\MarkPlay Setup 1.0.0.exe" |
  Format-List Status, StatusMessage, SignerCertificate, TimeStamperCertificate
```

验收标准：`Status = Valid`，`SignerCertificate.Subject` 是期望主体，`TimeStamperCertificate` 非空。

## 5. 构建前检查（每次发版）

```powershell
npm ci                 # 不要用 npm install，锁版本
npm test               # 44 个单元测试必须全过
npm run fetch-bin      # 或确认 resources/bin 已是固定版本
npm run dist
```

发布前把 `resources/bin/mpv.exe`、`ffmpeg.exe` 的 SHA256 记进 `docs/BINARIES.md`（下节）。

## 6. 二进制固定与校验（建议改造 `tools/fetch-binaries.js`）

现在脚本拉的是 "latest"，mpv/ffmpeg 升级可能改变行为。建议：

1. 固定版本号（如 `mpv-0.40.0`、`ffmpeg-7.1`）与下载 URL；
2. 在脚本里内置期望的 SHA256，下载后校验，不匹配直接失败；
3. 把校验结果写进构建日志；
4. 版本表放 `docs/BINARIES.md`：

```markdown
| 文件 | 版本 | SHA256 |
|------|------|--------|
| mpv.exe | 0.40.0-x86_64 | <hash> |
| ffmpeg.exe | 7.1-essentials | <hash> |
```

示意代码：

```js
const crypto = require('crypto');
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
const expected = { 'mpv.exe': '…', 'ffmpeg.exe': '…' };
if (sha256(target) !== expected[name]) throw new Error(`${name} 校验失败`);
```

## 7. 发布流程

1. 改版本号（`package.json`、README 标题、安装包名示例）；
2. `npm ci && npm test`；
3. 确认 `resources/bin` 是固定版本并通过校验；
4. `npm run dist`；
5. 签名并 `signtool verify`；
6. 真机冒烟（见下）；
7. 生成 SHA256 文件：`Get-FileHash dist\*.exe -Algorithm SHA256 > dist\SHA256SUMS.txt`；
8. 写 Release Notes（新增/修复/已知问题/校验和）；
9. 打 tag、上传安装包 + SHA256SUMS；
10. 若是自动更新，先发灰度包再全量。

## 8. 真机冒烟矩阵（至少这些）

| 场景 | 检查点 |
|------|--------|
| 1080p H.264 / HEVC | 打开、播放、暂停、seek、scrub |
| 4K 长 GOP | scrub 是否积压、松手是否精确落点 |
| 无音轨 / 纯音频 | 不崩、时间轴正常、音量无报错 |
| 中文字幕 `.srt` / `.ass` | 自动加载、拖入加载、样式正常 |
| 双显示器不同缩放（100% + 150%） | 视频区不错位、全屏正常 |
| 全屏 + ESC / 快捷键 | 焦点不丢 |
| 剪辑 `-c copy` 与重编码 | 时长正确、失败能提示 |
| 批量剪辑 3+ 区间 | 逐段完成、命名正确 |
| 双开 | 第二实例把文件交给已开窗口 |
| 缺 mpv.exe | 有明确弹窗与指引 |

## 9. 回滚

- 安装包层面：保留上一个版本的安装包与 SHA256，Release 里注明"回滚请装上一版"；
- 自动更新：保留 `latest.yml` 的历史版本，必要时把 `latest.yml` 指回旧版本；
- 配置层面：`settings.json` 与 sidecar 都是向后兼容的（v1 → v2），回滚不会丢标记。

## 10. 日志与隐私

- `logs/markplay.log` 会包含本地文件路径、mpv/ffmpeg 参数，**不要自动上传**；
- 让用户手动提供日志时，提醒先删掉个人路径；
- 如果以后加崩溃上报，必须显式征得同意并提供关闭开关。

# MarkPlay 安装包签名 + 校验
#
# 用法（三选一，按你拿到的证书形态）：
#
#   1) PFX 文件
#      .\tools\sign.ps1 -File "dist\MarkPlay Setup 1.6.0.exe" -Pfx "C:\keys\mycert.pfx" -Password "***"
#
#   2) 从 Windows 证书存储里按指纹取（EV 硬件令牌 / 已导入的证书）
#      .\tools\sign.ps1 -File "dist\MarkPlay Setup 1.6.0.exe" -Thumbprint "ABCD1234..."
#
#   3) 用环境变量（electron-builder 也是读这两个，保持一致）
#      $env:CSC_LINK = "C:\keys\mycert.pfx"; $env:CSC_KEY_PASSWORD = "***"
#      .\tools\sign.ps1 -File "dist\MarkPlay Setup 1.6.0.exe"
#
# 不带参数时只做"检查环境 + 列出现有证书"，不改任何文件：
#      .\tools\sign.ps1 -CheckOnly

param(
  [string]$File,
  [string]$Pfx,
  [string]$Password,
  [string]$Thumbprint,
  [string]$TimestampUrl = 'http://timestamp.digicert.com',
  [switch]$CheckOnly,
  [switch]$NoTimestamp
)

$ErrorActionPreference = 'Stop'

# ---------- 找 signtool ----------
# 优先用 electron-builder 缓存里的（随 electron-builder 一起下载，不需要装 Windows SDK）
function Find-SignTool {
  $found = @()

  $cache = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\winCodeSign'
  if (Test-Path $cache) {
    $found += Get-ChildItem $cache -Recurse -Filter 'signtool.exe' -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match '\\x64\\' } |
      Sort-Object FullName -Descending |
      Select-Object -ExpandProperty FullName
  }

  $kits = 'C:\Program Files (x86)\Windows Kits\10\bin'
  if (Test-Path $kits) {
    $found += Get-ChildItem $kits -Directory -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending |
      ForEach-Object {
        $p = Join-Path $_.FullName 'x64\signtool.exe'
        if (Test-Path $p) { $p }
      }
  }

  $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($cmd) { $found += $cmd.Source }

  return $found | Where-Object { $_ } | Select-Object -First 1
}

$signtool = Find-SignTool

Write-Host '=== 环境检查 ===' -ForegroundColor Cyan
if ($signtool) {
  Write-Host ('  signtool : ' + $signtool)
} else {
  Write-Host '  signtool : 未找到' -ForegroundColor Red
  Write-Host ''
  Write-Host '  解决方式（任选其一）：'
  Write-Host '    - 跑一次 npm run dist（electron-builder 会自动下载 winCodeSign，其中带 signtool）'
  Write-Host '    - 安装 Windows SDK'
  if (-not $CheckOnly) { exit 1 }
}

# ---------- 列出现有代码签名证书 ----------
Write-Host ''
Write-Host '=== 本机代码签名证书 ===' -ForegroundColor Cyan
$certs = @()
foreach ($store in @('Cert:\CurrentUser\My', 'Cert:\LocalMachine\My')) {
  $certs += Get-ChildItem $store -CodeSigningCert -ErrorAction SilentlyContinue |
    ForEach-Object { [pscustomobject]@{ Store = $store; Subject = $_.Subject; NotAfter = $_.NotAfter; Thumbprint = $_.Thumbprint } }
}
if ($certs.Count -eq 0) {
  Write-Host '  （无）—— 需要先买证书，见 docs\RELEASE.md' -ForegroundColor Yellow
} else {
  $certs | Format-Table -AutoSize
}

if ($CheckOnly) {
  Write-Host ''
  Write-Host '仅检查，未改动任何文件。' -ForegroundColor Green
  exit 0
}

if (-not $File) {
  Write-Host '[错误] 需要 -File 指定要签名的文件' -ForegroundColor Red
  exit 1
}
if (-not (Test-Path $File)) {
  Write-Host ("[错误] 文件不存在: " + $File) -ForegroundColor Red
  exit 1
}
if (-not $signtool) {
  Write-Host '[错误] 没有 signtool，无法签名' -ForegroundColor Red
  exit 1
}

# ---------- 决定用哪个证书 ----------
$certArgs = @()

if ($Pfx) {
  if (-not (Test-Path $Pfx)) {
    Write-Host ("[错误] PFX 不存在: " + $Pfx) -ForegroundColor Red
    exit 1
  }
  $pw = if ($Password) { $Password } elseif ($env:CSC_KEY_PASSWORD) { $env:CSC_KEY_PASSWORD } else { $null }
  if (-not $pw) {
    Write-Host '[错误] PFX 需要密码：用 -Password 或设置 $env:CSC_KEY_PASSWORD' -ForegroundColor Red
    exit 1
  }
  $certArgs += @('/f', $Pfx, '/p', $pw)
  Write-Host ''
  Write-Host ('使用 PFX: ' + $Pfx)
}
elseif ($Thumbprint) {
  $certArgs += @('/sha1', $Thumbprint)
  Write-Host ''
  Write-Host ('使用证书指纹: ' + $Thumbprint)
}
elseif ($env:CSC_LINK) {
  $link = $env:CSC_LINK
  if (Test-Path $link) {
    if (-not $env:CSC_KEY_PASSWORD) {
      Write-Host '[错误] 设置了 CSC_LINK 但没有 CSC_KEY_PASSWORD' -ForegroundColor Red
      exit 1
    }
    $certArgs += @('/f', $link, '/p', $env:CSC_KEY_PASSWORD)
    Write-Host ''
    Write-Host ('使用 CSC_LINK: ' + $link)
  } else {
    Write-Host '[提示] CSC_LINK 不是本地路径，可能被 electron-builder 当作 base64；本脚本只处理路径。' -ForegroundColor Yellow
    Write-Host '       请改用 -Pfx 或 -Thumbprint。' -ForegroundColor Yellow
    exit 1
  }
}
else {
  Write-Host ''
  Write-Host '[错误] 没指定证书：用 -Pfx / -Thumbprint，或设置 $env:CSC_LINK + $env:CSC_KEY_PASSWORD' -ForegroundColor Red
  exit 1
}

# ---------- 签名 ----------
Write-Host ''
Write-Host '=== 签名 ===' -ForegroundColor Cyan
Write-Host ('  文件: ' + $File)
Write-Host ('  大小: ' + [math]::Round((Get-Item $File).Length / 1MB, 1) + ' MB')

$signArgs = @('sign') + $certArgs + @('/fd', 'SHA256')

if ($NoTimestamp) {
  Write-Host '  时间戳: 跳过（-NoTimestamp）' -ForegroundColor Yellow
  Write-Host '  ⚠ 不打时间戳的签名在证书过期后即失效，正式发布不要这么做。' -ForegroundColor Yellow
} else {
  $signArgs += @('/td', 'SHA256', '/tr', $TimestampUrl)
  Write-Host ('  时间戳: ' + $TimestampUrl)
}

$signArgs += $File

& $signtool @signArgs
$code = $LASTEXITCODE
if ($code -ne 0) {
  Write-Host ("[错误] 签名失败，signtool 退出码 " + $code) -ForegroundColor Red
  exit $code
}

# ---------- 校验 ----------
Write-Host ''
Write-Host '=== 校验 ===' -ForegroundColor Cyan
$sig = Get-AuthenticodeSignature $File

Write-Host ('  Status   : ' + $sig.Status)
Write-Host ('  StatusMsg: ' + $sig.StatusMessage)
if ($sig.SignerCertificate) {
  Write-Host ('  签署主体 : ' + $sig.SignerCertificate.Subject)
  Write-Host ('  摘要算法 : ' + $sig.SignerCertificate.SignatureAlgorithm.FriendlyName)
}
if ($sig.TimeStamperCertificate) {
  Write-Host ('  时间戳   : ' + $sig.TimeStamperCertificate.Subject)
} else {
  Write-Host '  时间戳   : 无' -ForegroundColor Yellow
}

Write-Host ''
switch ($sig.Status) {
  'Valid' {
    Write-Host '✓ 签名有效。可以用 dist\SHA256SUMS.txt 一起发布。' -ForegroundColor Green
    $hash = (Get-FileHash $File -Algorithm SHA256).Hash
    Write-Host ('  SHA256: ' + $hash)
  }
  'UnknownError' {
    if ($sig.StatusMessage -match '不受信任|not trusted') {
      Write-Host '△ 签名已写入，但证书链的根不受本机信任。' -ForegroundColor Yellow
      Write-Host '  如果这是自签名测试证书，属预期；如果买了正式证书却看到这句，说明：'
      Write-Host '    - 证书不是代码签名用途（缺 Code Signing EKU），或'
      Write-Host '    - 中间证书没一起导入，或'
      Write-Host '    - 买的是"个人/SSL"证书而不是"代码签名"证书'
    } else {
      Write-Host ('△ 签名有问题：' + $sig.StatusMessage) -ForegroundColor Yellow
    }
  }
  'NotSigned' {
    Write-Host '✗ 文件仍未签名（签名步骤没有生效）' -ForegroundColor Red
    exit 1
  }
  default {
    Write-Host ('△ 状态 ' + $sig.Status + '：' + $sig.StatusMessage) -ForegroundColor Yellow
  }
}

Write-Host ''
Write-Host '提醒：签名 ≠ 立刻没有 SmartScreen 警告。' -ForegroundColor Cyan
Write-Host '  - OV 证书：需要一定下载量积累声誉后警告才会消失'
Write-Host '  - EV 证书：历史上更容易快速建立声誉'
Write-Host '  - 新证书 + 新包，前几次下载仍可能提示，属正常'
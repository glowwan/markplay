# 创建一张"仅本机测试用"的自签名代码签名证书
#
# 用途：在买正式证书之前，验证签名流程是否通。
#   自签名证书不会让 SmartScreen 不再警告——它只是证明"配置和命令都对了"。
#
# 用法：
#   .\tools\make-test-cert.ps1                 # 创建并导出 PFX 到 %TEMP%
#   .\tools\make-test-cert.ps1 -Remove         # 删掉测试证书
#
# 生成的 PFX 默认在 $env:TEMP\mpsign\test-signing.pfx，密码 MarkPlayTest#2026
# 这个文件不要提交、不要用于正式发布。

param(
  [string]$Subject = 'CN=MarkPlay Test Signing, O=glowwan, C=CN',
  [string]$Password = 'MarkPlayTest#2026',
  [string]$OutDir = (Join-Path $env:TEMP 'mpsign'),
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

if ($Remove) {
  $found = Get-ChildItem 'Cert:\CurrentUser\My' -CodeSigningCert -ErrorAction SilentlyContinue |
    Where-Object { $_.Subject -like '*MarkPlay Test Signing*' }
  if (-not $found) {
    Write-Host '没有找到测试证书，无需删除。'
    exit 0
  }
  foreach ($c in $found) {
    Remove-Item ("Cert:\CurrentUser\My\" + $c.Thumbprint) -Force
    Write-Host ('已删除: ' + $c.Thumbprint)
  }
  $pfx = Join-Path $OutDir 'test-signing.pfx'
  if (Test-Path $pfx) { Remove-Item $pfx -Force; Write-Host ('已删除: ' + $pfx) }
  exit 0
}

# 已存在就复用，避免证书越堆越多
$existing = Get-ChildItem 'Cert:\CurrentUser\My' -CodeSigningCert -ErrorAction SilentlyContinue |
  Where-Object { $_.Subject -eq $Subject -and $_.NotAfter -gt (Get-Date).AddDays(30) } |
  Select-Object -First 1

if ($existing) {
  $cert = $existing
  Write-Host '复用已有测试证书。'
} else {
  Write-Host '创建测试证书…'
  $cert = New-SelfSignedCertificate `
    -Subject $Subject `
    -Type CodeSigningCert `
    -KeyUsage DigitalSignature `
    -KeyAlgorithm RSA -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -NotAfter (Get-Date).AddYears(1) `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3')
}

Write-Host ('  主题: ' + $cert.Subject)
Write-Host ('  指纹: ' + $cert.Thumbprint)
Write-Host ('  有效期至: ' + $cert.NotAfter)

New-Item -ItemType Directory -Force $OutDir | Out-Null
$pfx = Join-Path $OutDir 'test-signing.pfx'
$sec = ConvertTo-SecureString -String $Password -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $sec | Out-Null

Write-Host ''
Write-Host ('PFX 已导出: ' + $pfx)
Write-Host ('密码: ' + $Password + '  (仅测试用)')
Write-Host ''
Write-Host '接下来可以验证签名流程：'
Write-Host ('  .\tools\sign.ps1 -File "dist\MarkPlay Setup 1.6.0.exe" -Pfx "' + $pfx + '"')
Write-Host ''
Write-Host '用完删掉：'
Write-Host '  .\tools\make-test-cert.ps1 -Remove'
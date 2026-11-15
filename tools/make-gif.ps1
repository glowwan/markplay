# 把屏幕录制转成 README 用的 GIF
#
# 用法:
#   .\tools\make-gif.ps1 -Video rec.mp4 -Name scrub
#   .\tools\make-gif.ps1 -Video rec.mp4 -Name scrub -Width 800 -Fps 12
#
# 输出: docs\images\<Name>.gif (已做调色板优化, 体积远小于直接转)

param(
  [Parameter(Mandatory = $true)][string]$Video,
  [Parameter(Mandatory = $true)][string]$Name,
  [int]$Width = 960,
  [int]$Fps = 15,
  [int]$MaxMB = 5
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

# 找 ffmpeg: 优先项目自带的, 其次 PATH
$ffmpeg = $null
$bundled = Join-Path $root 'resources\bin\ffmpeg.exe'
if (Test-Path $bundled) {
  $ffmpeg = $bundled
} else {
  $cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if ($cmd) { $ffmpeg = $cmd.Source }
}
if (-not $ffmpeg) {
  Write-Host '[错误] 找不到 ffmpeg.exe' -ForegroundColor Red
  Write-Host '先跑一次: node tools\fetch-binaries.js'
  exit 1
}

if (-not (Test-Path $Video)) {
  Write-Host "[错误] 输入文件不存在: $Video" -ForegroundColor Red
  exit 1
}

$outDir = Join-Path $root 'docs\images'
New-Item -ItemType Directory -Force $outDir | Out-Null
$out = Join-Path $outDir ($Name + '.gif')

Write-Host "ffmpeg : $ffmpeg"
Write-Host "输入   : $Video"
Write-Host "输出   : $out"
Write-Host "参数   : 宽 $Width / $Fps fps"
Write-Host ''

# 两遍法调色板: 先按素材统计颜色, 再套用. bayer 抖动压缩率高、色带少.
$scale = 'scale=' + $Width + ':-1:flags=lanczos'
$chain = 'fps=' + $Fps + ',' + $scale + ',split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3'

& $ffmpeg -hide_banner -loglevel error -y -i $Video -vf $chain -loop 0 $out

if ($LASTEXITCODE -ne 0) {
  Write-Host '[错误] 转换失败, 见上面的 ffmpeg 报错' -ForegroundColor Red
  exit 1
}

$sizeMB = (Get-Item $out).Length / 1MB
Write-Host ''
Write-Host ('生成成功: ' + $out + '  (' + [math]::Round($sizeMB, 2) + ' MB)') -ForegroundColor Green

if ($sizeMB -gt $MaxMB) {
  Write-Host ''
  Write-Host ('[提示] 超过 ' + $MaxMB + ' MB, 访客加载会明显变慢. 可以:') -ForegroundColor Yellow
  Write-Host '  - 缩短录制, 只留最能说明问题的几秒'
  Write-Host '  - 降宽度: -Width 800'
  Write-Host '  - 降帧率: -Fps 12'
}

Write-Host ''
Write-Host '下一步: 在 README.md 的「界面」小节加一行'
Write-Host ('  ![说明文字](docs/images/' + $Name + '.gif)')

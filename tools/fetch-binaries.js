#!/usr/bin/env node
/**
 * MarkPlay 二进制下载脚本
 * --------------------------------
 * 在 Windows 上运行，一次性把 mpv.exe 与 ffmpeg.exe 下载到 resources/bin/。
 * 只使用 Node.js 内置模块：https / fs / path / child_process / crypto。
 *
 * 用法：node tools/fetch-binaries.js
 *
 * 特性：
 *  - 幂等：目标文件已存在且大于 1MB 时直接跳过；
 *  - 打印下载进度与 SHA256；
 *  - GitHub API 被限流/被墙（403）时，自动改从 releases 页面解析 mpv 资源链接；
 *  - ffmpeg 优先 gyan.dev，失败时回退到 BtbN 的 latest zip（用 Windows 自带 tar 解压）；
 *  - 任一步失败：打印中文错误 + 手动下载备选说明 + 直链，并以非零 exit code 退出。
 */
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN_DIR = path.join(ROOT, 'resources', 'bin');
const TMP_DIR = path.join(ROOT, 'resources', '.tmp-fetch');

const SEVEN_ZR_URL = 'https://www.7-zip.org/a/7zr.exe';
const FFMPEG_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.7z';
const FFMPEG_FALLBACK_URL =
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';
const GITHUB_LATEST_API = 'https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest';
const GITHUB_LATEST_HTML = 'https://github.com/shinchiro/mpv-winbuild-cmake/releases/latest';

// 大于此体积视为“已下载好”，跳过（mpv/ffmpeg 正常都在几十 MB）
const MIN_SIZE = 1 * 1024 * 1024;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) markplay-fetch-binaries';

function log(msg) {
  console.log(msg);
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function existsAndBigEnough(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size > MIN_SIZE;
  } catch (e) {
    return false;
  }
}

function manualFallback() {
  console.error('');
  console.error('手动备选方案（下载好后放到 <项目目录>\\resources\\bin\\ 下）：');
  console.error('');
  console.error('  1. mpv.exe：');
  console.error('     打开 https://github.com/shinchiro/mpv-winbuild-cmake/releases/latest');
  console.error('     在 Assets 里下载 mpv-x86_64-*.7z（例如 mpv-x86_64-20261107-git-9028187538.7z），');
  console.error('     用 7-Zip 解压，把 mpv.exe 和同目录的 d3dcompiler_*.dll、libshaderc*.dll 等 dll');
  console.error('     一起复制到 resources\\bin\\。');
  console.error('');
  console.error('  2. ffmpeg.exe：');
  console.error('     打开 https://www.gyan.dev/ffmpeg/builds/#release-builds');
  console.error('     找到 release builds 区的 ffmpeg-release-essentials.7z（约 34MB），');
  console.error('     用 7-Zip 解压，把 bin\\ffmpeg.exe 复制到 resources\\bin\\。');
  console.error('');
  console.error('  两个文件放好后，重新双击 build.bat 即可（脚本检测到已存在会跳过下载）。');
  console.error('');
  console.error('  直链（2026-11 有效，版本更新后可能变化）：');
  console.error('    https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.7z');
  console.error('    https://github.com/shinchiro/mpv-winbuild-cmake/releases/latest');
}

/** GET 一个 JSON 接口（GitHub API 用），自动跟随重定向 */
function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': UA,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          getJson(next).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error('GitHub API 请求失败，HTTP ' + res.statusCode));
          return;
        }
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(text));
          } catch (e) {
            reject(new Error('GitHub API 返回的内容不是合法 JSON：' + e.message));
          }
        });
      }
    );
    req.on('error', (err) => reject(new Error('GitHub API 请求出错：' + err.message)));
    req.setTimeout(30000, () => req.destroy(new Error('请求超时（30 秒）')));
  });
}

/** GET 一段文本（HTML），自动跟随重定向 */
function getText(url, redirects) {
  const depth = redirects || 0;
  return new Promise((resolve, reject) => {
    if (depth > 10) {
      reject(new Error('重定向次数过多'));
      return;
    }
    const req = https.get(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        getText(new URL(res.headers.location, url).toString(), depth + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        text += c;
        if (text.length > 5 * 1024 * 1024) {
          req.destroy(new Error('页面过大'));
        }
      });
      res.on('end', () => resolve(text));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('请求超时（30 秒）')));
  });
}

/** 下载文件到 dest，自动跟随重定向，打印进度 */
function download(url, dest, label) {
  return new Promise((resolve, reject) => {
    let redirects = 0;
    function attempt(u) {
      const req = https.get(u, { headers: { 'User-Agent': UA } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          redirects += 1;
          if (redirects > 10) {
            res.resume();
            reject(new Error(label + '：重定向次数过多'));
            return;
          }
          res.resume();
          attempt(new URL(res.headers.location, u).toString());
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(label + ' 下载失败，HTTP ' + res.statusCode));
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let done = 0;
        const file = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          done += chunk.length;
          if (total > 0) {
            process.stdout.write(
              '\r  ' + label + '：' + ((done / total) * 100).toFixed(1) + '% (' + fmtBytes(done) + ' / ' + fmtBytes(total) + ')'
            );
          } else {
            process.stdout.write('\r  ' + label + '：已下载 ' + fmtBytes(done));
          }
        });
        res.on('error', (err) => {
          file.close();
          reject(new Error(label + ' 下载中断：' + err.message));
        });
        file.on('error', (err) => reject(new Error(label + ' 写入文件失败：' + err.message)));
        file.on('finish', () => {
          process.stdout.write('\n');
          resolve();
        });
        res.pipe(file);
      });
      req.on('error', (err) => reject(new Error(label + ' 下载出错：' + err.message)));
      req.setTimeout(120000, () => req.destroy(new Error('下载超时（120 秒无数据）')));
    }
    attempt(url);
  });
}

/** 用 7zr.exe 解压 archive 到 outDir */
function extractWith7zr(sevenZr, archive, outDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(outDir, { recursive: true });
    log('  正在解压 ' + path.basename(archive) + ' …');
    const child = spawn(sevenZr, ['x', '-y', archive, '-o' + outDir], { stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('error', (err) => reject(new Error('无法启动 7zr.exe：' + err.message)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('7zr 解压失败，退出码 ' + code));
    });
  });
}

/** 用 Windows 自带的 bsdtar 解压 zip（7zr 只支持 7z，不支持 zip） */
function extractWithTar(archive, outDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(outDir, { recursive: true });
    log('  正在解压 ' + path.basename(archive) + '（tar）…');
    const child = spawn('tar', ['-xf', archive, '-C', outDir], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    if (child.stderr) child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (err) => reject(new Error('无法启动 tar：' + err.message)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('tar 解压失败，退出码 ' + code + (stderr ? '：' + stderr.slice(-300) : '')));
    });
  });
}

/** 按扩展名选择解压方式 */
function extractArchive(sevenZr, archive, outDir) {
  if (/\.zip$/i.test(archive)) return extractWithTar(archive, outDir);
  return extractWith7zr(sevenZr, archive, outDir);
}

/** 递归查找满足 predicate(fileName) 的文件，返回完整路径数组 */
function findFilesRecursive(dir, predicate) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return results;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      results.push.apply(results, findFilesRecursive(full, predicate));
    } else if (predicate(e.name)) {
      results.push(full);
    }
  }
  return results;
}

async function ensureSevenZr() {
  const sevenZr = path.join(TMP_DIR, '7zr.exe');
  if (existsAndBigEnough(sevenZr)) {
    log('7zr.exe 已存在，跳过下载。');
    return sevenZr;
  }
  log('正在下载 7zr.exe（7-Zip 官方精简命令行解压工具，用于解压 .7z）…');
  await download(SEVEN_ZR_URL, sevenZr, '7zr.exe');
  return sevenZr;
}

/**
 * 解析 mpv 最新资源链接。
 * 优先 GitHub API；遇到 403（限流/被墙）时改解析 releases 页面。
 * @returns {Promise<{url: string, name: string, tag: string}>}
 */
async function resolveMpvAsset() {
  if (process.env.MARKPLAY_MPV_URL) {
    const url = process.env.MARKPLAY_MPV_URL;
    return { url, name: path.basename(new URL(url).pathname), tag: 'env' };
  }

  // 调试/排障：MARKPLAY_FORCE_HTML=1 可强制走网页解析，跳过 API
  if (process.env.MARKPLAY_FORCE_HTML !== '1') {
    try {
      const data = await getJson(GITHUB_LATEST_API);
      const assets = Array.isArray(data.assets) ? data.assets : [];
      const asset = assets.find((a) => a.name.startsWith('mpv-x86_64-') && a.name.endsWith('.7z'));
      if (asset && asset.browser_download_url) {
        return { url: asset.browser_download_url, name: asset.name, tag: data.tag_name || 'latest' };
      }
      throw new Error('releases 里找不到 mpv-x86_64-*.7z');
    } catch (err) {
      log('  GitHub API 不可用（' + err.message + '），改从 releases 页面解析…');
    }
  }

  // 新版 GitHub 的 release 页面把资产放在 expanded_assets 片段里
  const findHref = (html) => {
    const direct = /href="([^"]*\/releases\/download\/[^"]*\/(mpv-x86_64-[^"/]+\.7z))"/.exec(html);
    return direct ? direct[1] : null;
  };
  const findFragment = (html) => {
    const m = /src="([^"]*\/releases\/expanded_assets\/[^"]+)"/.exec(html);
    return m ? m[1] : null;
  };

  const html = await getText(GITHUB_LATEST_HTML);
  let href = findHref(html);
  if (!href) {
    const fragment = findFragment(html);
    if (fragment) {
      const fragmentHtml = await getText(new URL(fragment, 'https://github.com').toString());
      href = findHref(fragmentHtml);
    }
  }
  if (!href) {
    throw new Error('无法从 releases 页面解析 mpv 资源链接（页面结构可能又变了）');
  }
  const absolute = new URL(href, 'https://github.com').toString();
  return {
    url: absolute,
    name: decodeURIComponent(path.basename(new URL(absolute).pathname)),
    tag: 'latest',
  };
}

async function fetchMpv(sevenZr) {
  const target = path.join(BIN_DIR, 'mpv.exe');
  if (existsAndBigEnough(target)) {
    log('mpv.exe 已存在（' + fmtBytes(fs.statSync(target).size) + '），跳过下载。');
    return;
  }
  log('');
  log('=== [1/2] 下载 mpv ===');
  const asset = await resolveMpvAsset();
  log('找到版本 ' + asset.tag + '，文件：' + asset.name);
  const archive = path.join(TMP_DIR, asset.name);
  await download(asset.url, archive, asset.name);

  const outDir = path.join(TMP_DIR, 'mpv');
  await extractArchive(sevenZr, archive, outDir);

  const found = findFilesRecursive(outDir, (f) => f.toLowerCase() === 'mpv.exe');
  if (found.length === 0) throw new Error('解压后找不到 mpv.exe');
  fs.copyFileSync(found[0], target);
  log('已复制 mpv.exe -> resources\\bin\\mpv.exe  (SHA256 ' + sha256(target).slice(0, 16) + '…)');

  // 把同目录的 d3dcompiler / shader 相关 dll 也拷过去（部分版本需要）
  const srcDir = path.dirname(found[0]);
  const dlls = findFilesRecursive(outDir, (f) =>
    /^(d3dcompiler_|libshaderc|dxgi|vulkan-)/i.test(f) && f.toLowerCase().endsWith('.dll')
  );
  let dllCount = 0;
  for (const d of dlls) {
    if (path.dirname(d) === srcDir) {
      fs.copyFileSync(d, path.join(BIN_DIR, path.basename(d)));
      dllCount += 1;
    }
  }
  if (dllCount > 0) log('一并复制了 ' + dllCount + ' 个相关 dll。');
}

async function fetchFfmpeg(sevenZr) {
  const target = path.join(BIN_DIR, 'ffmpeg.exe');
  if (existsAndBigEnough(target)) {
    log('ffmpeg.exe 已存在（' + fmtBytes(fs.statSync(target).size) + '），跳过下载。');
    return;
  }
  log('');
  log('=== [2/2] 下载 ffmpeg ===');

  const sources = [
    { url: FFMPEG_URL, name: 'ffmpeg-release-essentials.7z', from: 'gyan.dev' },
    { url: FFMPEG_FALLBACK_URL, name: 'ffmpeg-master-latest-win64-gpl.zip', from: 'BtbN/FFmpeg-Builds' },
  ];

  let lastError = null;
  for (const source of sources) {
    try {
      log('下载源：' + source.from + '（' + source.name + '）');
      const archive = path.join(TMP_DIR, source.name);
      await download(source.url, archive, source.name);

      const outDir = path.join(TMP_DIR, 'ffmpeg');
      await extractArchive(sevenZr, archive, outDir);

      const found = findFilesRecursive(outDir, (f) => f.toLowerCase() === 'ffmpeg.exe');
      if (found.length === 0) throw new Error('解压后找不到 ffmpeg.exe');
      // 优先取 bin 目录下的那个
      found.sort((a, b) => {
        const aBin = path.dirname(a).toLowerCase().endsWith('bin') ? 0 : 1;
        const bBin = path.dirname(b).toLowerCase().endsWith('bin') ? 0 : 1;
        return aBin - bBin;
      });
      fs.copyFileSync(found[0], target);
      log('已复制 ffmpeg.exe -> resources\\bin\\ffmpeg.exe  (SHA256 ' + sha256(target).slice(0, 16) + '…)');
      return;
    } catch (err) {
      lastError = err;
      log('  该来源失败：' + err.message);
    }
  }
  throw lastError || new Error('ffmpeg 下载失败');
}

async function main() {
  if (process.platform !== 'win32') {
    console.warn('[提示] 本脚本面向 Windows 编写，当前平台为 ' + process.platform + '，将继续尝试运行。');
  }

  // 只解析、不下载：用于排查 GitHub 限流/页面结构变化
  if (process.env.MARKPLAY_RESOLVE_ONLY === '1') {
    log('MarkPlay 二进制解析自检（不下载）');
    const asset = await resolveMpvAsset();
    log('mpv 版本：' + asset.tag);
    log('mpv 文件：' + asset.name);
    log('mpv 链接：' + asset.url);
    return;
  }

  log('MarkPlay 二进制下载工具');
  log('目标目录：' + BIN_DIR);
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });

  const sevenZr = await ensureSevenZr();
  await fetchMpv(sevenZr);
  await fetchFfmpeg(sevenZr);

  // 成功后清理临时下载文件
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch (e) { /* 忽略清理失败 */ }

  log('');
  log('全部完成！resources\\bin\\ 下现在应包含 mpv.exe 与 ffmpeg.exe。');
}

main().catch((err) => {
  console.error('');
  console.error('[失败] ' + (err && err.message ? err.message : err));
  manualFallback();
  process.exit(1);
});

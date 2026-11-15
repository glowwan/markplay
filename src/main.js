'use strict';

/**
 * MarkPlay 主进程。
 *
 * 职责：
 * 1. 创建主窗口（播放器 UI）与 frameless 透明视频子窗口（mpv 画面的原生容器）。
 * 2. 懒启动 mpv.exe（--wid 嵌入子窗口 HWND），通过命名管道 JSON IPC 控制。
 * 3. 把 mpv 的属性/事件节流转发给渲染进程（player-event）。
 * 4. 处理渲染进程的对话框、文件读写、ffmpeg 剪辑请求。
 * 5. 应用退出时清理 mpv / ffmpeg 子进程。
 */
const { app, BrowserWindow, ipcMain, dialog, screen, Menu, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const config = require('./config');
const { MpvClient } = require('./mpv');
const { SettingsStore } = require('./settings');
const { Logger } = require('./logger');
const {
  MEDIA_EXTENSIONS,
  SCENE_SCORE_FLOOR,
  SUBTITLE_EXTENSIONS,
  estimateVideoBitrate,
  findMediaArg,
  isSubtitlePath,
  parseSceneScores,
  reencodeArgs,
  toConcatLine,
} = require('./media-utils');
const { backupPathFor, isBackupOf, pickBackupsToDelete } = require('./sidecar-backup');
const { SUPPORTED, createTranslator, normalize, setActiveLanguage } = require('./i18n');
const dictZh = require('./locales/zh-CN');
const dictEn = require('./locales/en-US');

/** 当前界面语言（zh-CN / en-US），启动时由设置或系统语言决定 */
let currentLang = 'zh-CN';
/** 主进程侧的翻译函数；切换语言时重建 */
let t = createTranslator('zh-CN', dictZh, dictZh);

/** 语言字典表 */
const DICTS = { 'zh-CN': dictZh, 'en-US': dictEn };

/**
 * 设置当前语言并重建翻译函数。
 * @param {'zh-CN'|'en-US'} lang
 */
function setLanguage(lang) {
  currentLang = normalize(lang);
  t = createTranslator(currentLang, DICTS[currentLang], dictZh);
  // 同步给 mpv.js 等低层模块，让它们抛出的错误也跟着翻译
  setActiveLanguage(currentLang, DICTS[currentLang], dictZh);
}

// ---------- 常量 ----------

/** mpv IPC 连接重试次数（mpv 启动后管道需要一点时间才能创建） */
const MPV_CONNECT_ATTEMPTS = 60;
/** mpv IPC 连接重试间隔（毫秒） */
const MPV_CONNECT_INTERVAL_MS = 100;

// ---------- 全局状态 ----------

/** @type {BrowserWindow|null} */
let mainWindow = null;
/** @type {BrowserWindow|null} */
let surfaceWindow = null;
/** 视频子窗口的 HWND（十进制字符串），供 --wid 使用 */
let surfaceHwnd = '';
/** mpv 子进程 */
let mpvProcess = null;
/** ffmpeg 子进程（剪辑时） */
let ffmpegProcess = null;
/** 合并剪辑进行中（整条链路，包含分段与拼接，防止 run-clip 插进来） */
let mergeInProgress = false;
/** 转场识别子进程（同一时间只允许一个） */
let sceneProcess = null;
/** 已识别出的转场（按视频路径缓存，换片即失效） */
let sceneCache = { path: '', scores: [] };
/** @type {MpvClient|null} */
let mpvClient = null;
/** mpv 是否已就绪（进程已启动且 IPC 已连接） */
let mpvReady = false;
/** mpv 启动中的 Promise（防并发重复启动） */
let mpvStarting = null;
/** 当前文件的 duration（秒），用于拼 mpv-time 事件 */
let currentDuration = 0;
/** 上次转发的 time-pos（节流用） */
let lastTime = 0;
/** 上次转发 time-pos 的时间戳（节流用） */
let lastTimeSentAt = 0;
/** 上次转发的剪辑进度百分比 */
let lastClipPercent = -1;
/** 应用是否正在退出（退出时不重复发 mpv-error） */
let quitting = false;
/** @type {SettingsStore|null} 用户设置（音量 / 最近文件 / 窗口位置） */
let settings = null;
/** 上一次应用到视频子窗口的矩形键，避免 500ms 轮询时无意义地反复 setBounds */
let surfaceRectKey = '';
/** 启动参数里带的视频路径（双击关联文件 / 拖到 exe 上） */
let startupFile = '';
/** 当前视频路径（菜单"在文件夹中显示"用） */
let currentVideoPath = '';
/** mpv.exe 缺失的提示只弹一次，避免反复骚扰 */
let warnedMpvMissing = false;
/** @type {Logger|null} 运行日志（userData/logs/markplay.log） */
let logger = null;

/** 早期异常也要有地方落盘（logger 还没建好时退化为 console） */
function logError(scope, err) {
  if (logger) logger.error(scope, err);
  else console.error(scope, err);
}
function logWarn(...args) {
  if (logger) logger.warn(...args);
  else console.warn(...args);
}
function logInfo(...args) {
  if (logger) logger.info(...args);
}

process.on('uncaughtException', (err) => logError('uncaughtException', err));
process.on('unhandledRejection', (reason) => logError('unhandledRejection', reason));

// ---------- 2x 播放 / 全屏状态 ----------

/** 速度模式：'normal' | 'fwd2x'（2x 正放） | 'rev2x'（2x 倒放，定时回退模拟） */
let speedMode = 'normal';
/** 进入 2x 前的暂停状态：退出 2x 时恢复 */
let resumePaused = false;
/** 倒放模拟定时器（暂停 + 每 100ms 精确回退 0.2s） */
let revTimer = null;
/** 倒放链条代号：重启/停止时递增，旧链自检后退出 */
let revSeq = 0;
/** 视频画面点击去重：mpv input.conf 与 surface-preload 双路径，300ms 内只算一次 */
let lastSurfaceClickAt = 0;
/** 视频子窗口是否全屏 */
let isSurfaceFullscreen = false;
/** 进入全屏前视频子窗口的位置（退出时恢复） */
let savedSurfaceBounds = null;
/** 渲染进程上报的视频矩形（CSS 像素，相对主窗口左上）：退出全屏后重排用 */
let lastVideoRect = null;

/**
 * mpv 自定义按键绑定（写入 userData/mpv-input.conf）。
 * 注意 mpv 原生不支持负速度倒放（官方 wontfix），右键的 2x 倒放由主进程定时回退模拟。
 */
const MPV_INPUT_CONF_TEXT = [
    '# MarkPlay generated: mouse bindings on the video surface',
  'MBTN_LEFT script-message markplay-click left',
  'MBTN_RIGHT script-message markplay-click right',
  'MBTN_MID script-message markplay-click mid',
].join('\n') + '\n';

/**
 * 确保 mpv-input.conf 存在（每次启动重写，保证与版本一致）。
 * @returns {string|null} conf 文件路径；写失败返回 null（mpv 照常启动，只是画面点击无效）
 */
function ensureMpvInputConf() {
  try {
    const p = path.join(app.getPath('userData'), 'mpv-input.conf');
    fs.writeFileSync(p, MPV_INPUT_CONF_TEXT, 'utf8');
    return p;
  } catch (err) {
    console.warn('[main] 写 mpv-input.conf 失败:', err.message);
    return null;
  }
}

// ---------- 工具函数 ----------

/**
 * 休眠指定毫秒。
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 向主窗口渲染进程发送播放器事件。
 * @param {object} payload
 */
function emitPlayerEvent(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('player-event', payload);
  }
}

/**
 * 解析可执行文件的实际路径（mpv.exe / ffmpeg.exe）。
 * 优先级：打包后 resources/bin/ → 开发目录 resources/bin/ → 系统 PATH。
 * @param {string} exeName - 如 'mpv.exe'
 * @returns {string} 可直接用于 spawn 的路径或命令名
 */
function resolveBin(exeName) {
  // 1) 打包后：<resourcesPath>/bin/mpv.exe
  const packaged = path.join(process.resourcesPath, 'bin', exeName);
  if (fs.existsSync(packaged)) return packaged;
  // 2) 开发环境：<项目根>/resources/bin/mpv.exe
  const dev = path.join(__dirname, '..', 'resources', 'bin', exeName);
  if (fs.existsSync(dev)) return dev;
  // 3) 回退：依赖系统 PATH（Windows 会自动解析 .exe）
  return exeName;
}

/**
 * 安全地杀掉一个子进程（忽略已退出/不存在的情况）。
 * @param {import('child_process').ChildProcess|null} proc
 */
function killChild(proc) {
  if (!proc || proc.killed || proc.exitCode !== null) return;
  try {
    proc.kill();
  } catch {
    // 进程可能已经退出，忽略
  }
}

/**
 * 恢复上次的主窗口位置/大小。显示器拔掉后旧坐标可能落在屏幕外，
 * 这里只接受中心点仍在某个显示器工作区内的记录，否则用默认值。
 */
function applySavedWindowBounds(win) {
  const saved = settings ? settings.get('window') : null;
  if (!saved) return;
  const displays = screen.getAllDisplays();
  const cx = saved.x + Math.min(saved.width, 200) / 2;
  const cy = saved.y + Math.min(saved.height, 200) / 2;
  const visible = displays.some((d) => {
    const b = d.workArea;
    return cx >= b.x && cx < b.x + b.width && cy >= b.y && cy < b.y + b.height;
  });
  if (!visible) return;
  try {
    win.setBounds({ x: saved.x, y: saved.y, width: saved.width, height: saved.height });
    if (saved.maximized) win.maximize();
  } catch (err) {
    console.warn('[main] 恢复窗口位置失败:', err.message);
  }
}

/** 窗口移动/缩放防抖落盘（拖动过程中不写磁盘） */
let windowSaveTimer = null;
function scheduleWindowSave() {
  if (!settings) return;
  if (windowSaveTimer) clearTimeout(windowSaveTimer);
  windowSaveTimer = setTimeout(() => {
    windowSaveTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const maximized = mainWindow.isMaximized();
    const bounds = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    settings.set('window', {
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, maximized,
    });
  }, 500);
}

// ---------- 窗口创建 ----------

/**
 * 创建主窗口：1280x800，最小 960x600，加载渲染进程 UI。
 */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#111111',
    title: 'MarkPlay',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 显式关闭沙盒：保证 preload 里 require('./config') 等在各 Electron 版本下都可用。
      // 若开启沙盒，preload 可能加载失败导致 window.markplay 缺失（表现为：界面正常但所有按钮无反应）。
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  applySavedWindowBounds(mainWindow);

  // 把渲染进程的 warning/error 也收进日志：用户报"界面报错"时能直接看到原文。
  // Electron 新旧版本的 console-message 参数形态不同（旧：level,message,line,sourceId；
  // 新：details 对象），这里两种都兼容。
  mainWindow.webContents.on('console-message', (...args) => {
    const details = args[1];
    let level;
    let message;
    let line;
    let sourceId;
    if (details && typeof details === 'object') {
      level = details.level;
      message = details.message;
      line = details.lineNumber;
      sourceId = details.sourceId;
    } else {
      level = args[1];
      message = args[2];
      line = args[3];
      sourceId = args[4];
    }
    const isBad = (typeof level === 'string')
      ? (level === 'warning' || level === 'error')
      : (typeof level === 'number' ? level >= 2 : true);
    if (!isBad) return;
    logWarn('[renderer]', message, `(${sourceId || 'unknown'}:${line || 0})`);
  });

  // 位置/大小记忆：移动、缩放、最大化都记录（防抖 500ms）
  mainWindow.on('resize', scheduleWindowSave);
  mainWindow.on('move', scheduleWindowSave);
  mainWindow.on('maximize', scheduleWindowSave);
  mainWindow.on('unmaximize', scheduleWindowSave);

  mainWindow.on('closed', () => {
    mainWindow = null;
    surfaceWindow = null;
  });

  // 窗口移动/缩放时，渲染进程的 getBoundingClientRect 不变（相对视口），
  // 500ms 轮询的去重会因此不再发 set-video-rect，视频子窗口就会停在旧位置。
  // 这里在每次 move/resize 时用上一份 CSS 矩形重新算屏幕坐标，拖动时才能跟手。
  const repositionSurface = () => {
    if (!lastVideoRect || !surfaceWindow || surfaceWindow.isDestroyed() || isSurfaceFullscreen) return;
    applyVideoRect(lastVideoRect);
  };
  mainWindow.on('move', repositionSurface);
  mainWindow.on('resize', repositionSurface);

  // 键盘缩放在 webContents 层先截获：即使焦点在 <select> 或 mpv 画面上也能生效，
  // 且 preventDefault 后不会再触发页面里的 keydown，不会双倍缩放。
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control) return;
    let action = '';
    if (input.key === '0') action = 'fit';
    else if (input.key === '=' || input.key === '+') action = 'in';
    else if (input.key === '-') action = 'out';
    if (!action) return;
    event.preventDefault();
    mainWindow.webContents.send('player-event', { type: 'zoom', action });
  });
}

/**
 * 创建视频子窗口：frameless + 透明，作为 mpv --wid 的嵌入容器。
 * 仅承载原生画面，不显示任何网页内容（about:blank）。
 * 创建后记录其 HWND。
 */
function createSurfaceWindow() {
  surfaceWindow = new BrowserWindow({
    parent: mainWindow,
    frame: false,
    transparent: true,
    show: false,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'surface-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // HWND：原生窗口句柄，mpv 用它把画面嵌入本窗口。
  // 64 位下 HWND 是 8 字节，不能只读低 32 位（虽然实际值通常很小，但取全更稳）。
  const handle = surfaceWindow.getNativeWindowHandle();
  surfaceHwnd = (handle.length >= 8
    ? handle.readBigUInt64LE(0)
    : BigInt(handle.readUInt32LE(0))).toString();
  console.log('[main] surface HWND =', surfaceHwnd);

  surfaceWindow.loadURL('about:blank');
}

// ---------- mpv 生命周期 ----------

/**
 * 轮询连接 mpv 的 IPC 管道（mpv 启动后需要时间创建管道）。
 * @param {string} pipePath - 形如 `\\.\pipe\markplay-1234`
 * @returns {Promise<MpvClient>} 连接成功的客户端
 */
async function waitForMpvPipe(pipePath) {
  let lastErr = null;
  for (let i = 0; i < MPV_CONNECT_ATTEMPTS; i++) {
    const client = new MpvClient();
    try {
      await client.connect(pipePath);
      return client;
    } catch (err) {
      lastErr = err;
      await sleep(MPV_CONNECT_INTERVAL_MS);
    }
  }
  throw new Error(t('errors.pipeTimeout', { msg: lastErr ? lastErr.message : t('common.unknown') }));
}

/**
 * 实际启动 mpv 进程并建立 IPC 连接、订阅属性。
 * @returns {Promise<void>}
 */
async function startMpv() {
  const mpvExe = resolveBin('mpv.exe');
  const pipeName = config.PIPE_NAME(process.pid);
  const pipePath = `\\\\.\\pipe\\${pipeName}`;

  const args = [
    `--wid=${surfaceHwnd}`,
    `--input-ipc-server=${pipePath}`,
    '--idle=yes',
    '--force-window',
    '--no-terminal',
    '--no-osc',
    '--osd-level=0',
    '--hwdec=auto',
    '--input-default-bindings=no',
    // 画面上的键盘交给主窗口处理：否则点过视频后 Space/A/B/Ctrl+0 会被 mpv 吃掉
    // （mpv 0.42 的 --list-options 里确认存在此选项）
    '--input-vo-keyboard=no',
    '--keep-open=no',
    '--hr-seek-framedrop=yes', // exact seek 时丢帧加速（scrub 松手补 exact 用）
    // 自动加载同名字幕 / 音轨（把 srt 放在视频旁边就能直接用）
    '--sub-auto=fuzzy',
    '--audio-file-auto=fuzzy',
  ];
  // 画面鼠标点击绑定（左键 2x 正放 / 右键 2x 倒放 / 中键 2x 正放）
  const inputConf = ensureMpvInputConf();
  if (inputConf) args.push(`--input-conf=${inputConf}`);

  console.log('[main] 启动 mpv:', mpvExe, args.join(' '));

  mpvProcess = spawn(mpvExe, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });

  // 必须消费 stderr：否则 mpv 日志写满管道缓冲区后会阻塞播放；顺带把内容记进日志
  if (mpvProcess.stderr) {
    mpvProcess.stderr.setEncoding('utf8');
    mpvProcess.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) logInfo('[mpv]', text);
    });
  }

  // spawn 级别的失败（如文件不存在）：立即通知渲染进程
  mpvProcess.once('error', (err) => {
    const missing = err.code === 'ENOENT';
    const message = missing
      ? t('errors.mpvNotFound', { exe: mpvExe })
      : t('errors.mpvStart', { msg: `${err.message} (${mpvExe})` });
    console.error('[main]', message);
    mpvProcess = null;
    if (!quitting) {
      emitPlayerEvent({ type: 'mpv-error', message });
      if (missing && !warnedMpvMissing) {
        warnedMpvMissing = true;
        const box = {
          type: 'error',
          title: t('dialog.mpvMissingTitle'),
          message: t('dialog.mpvMissingMessage'),
          detail: t('errors.mpvMissingDetail'),
          buttons: [t('common.ok')],
        };
        const p = mainWindow && !mainWindow.isDestroyed()
          ? dialog.showMessageBox(mainWindow, box)
          : dialog.showMessageBox(box);
        p.catch(() => {});
      }
    }
  });

  mpvProcess.on('exit', (code, signal) => {
    console.log('[main] mpv 进程退出:', code, signal);
    mpvProcess = null;
    mpvReady = false;
    stopRevTimer();
    speedMode = 'normal';
    resumePaused = false;
    if (mpvClient) {
      mpvClient.close();
      mpvClient = null;
    }
    currentDuration = 0;
    lastTime = 0;
    // 非正常退出且不是应用退出时：通知渲染进程
    if (!quitting && code !== 0) {
      emitPlayerEvent({ type: 'mpv-error', message: t('errors.mpvExited', { code }) });
    }
  });

  // 等待 mpv 创建好 IPC 管道并连接
  const client = await waitForMpvPipe(pipePath);
  mpvClient = client;
  attachMpvHandlers(client);

  // 订阅关键属性：1=time-pos, 2=duration, 3=pause, 4=container-fps
  try {
    await Promise.all([
      client.observe(1, 'time-pos'),
      client.observe(2, 'duration'),
      client.observe(3, 'pause'),
      client.observe(4, 'container-fps'),
    ]);
  } catch (err) {
    emitPlayerEvent({ type: 'mpv-error', message: t('errors.observeFailed', { msg: err.message }) });
  }
}

/**
 * 给已连接的 MpvClient 挂上属性/事件转发逻辑。
 * @param {MpvClient} client
 */
function attachMpvHandlers(client) {
  client.on('property-change', ({ id, name, data }) => {
    if (id === 1) {
      // time-pos：节流转发（变化 > 0.05s，或每 250ms 最多一次）
      if (typeof data !== 'number' || Number.isNaN(data)) return;
      const now = Date.now();
      if (Math.abs(data - lastTime) > 0.05 || now - lastTimeSentAt >= 250) {
        lastTime = data;
        lastTimeSentAt = now;
        emitPlayerEvent({ type: 'mpv-time', t: data, dur: currentDuration });
      }
    } else if (id === 2) {
      // duration：变化才发
      if (typeof data === 'number' && !Number.isNaN(data) && data !== currentDuration) {
        currentDuration = data;
        emitPlayerEvent({ type: 'mpv-duration', dur: data });
      }
    } else if (id === 3) {
      // pause：直接转发
      emitPlayerEvent({ type: 'mpv-paused', paused: data === true });
    } else if (id === 4) {
      // container-fps：素材帧率，EDL/帧号换算要用
      if (typeof data === 'number' && isFinite(data) && data > 0) {
        emitPlayerEvent({ type: 'mpv-fps', fps: data });
      }
    } else {
      console.log('[main] 未处理的属性变化:', name, data);
    }
  });

  client.on('event', (msg) => {
    // 文件真正加载完成：此时 duration 才可靠，通知渲染进程刷新时长
    if (msg.event === 'file-loaded') {
      emitPlayerEvent({ type: 'mpv-file-loaded' });
      client.send(['get_property', 'duration']).then((r) => {
        if (typeof r.data === 'number' && r.data > 0 && r.data !== currentDuration) {
          currentDuration = r.data;
          emitPlayerEvent({ type: 'mpv-duration', dur: r.data });
        }
      }).catch(() => {});
      client.send(['get_property', 'container-fps']).then((r) => {
        if (typeof r.data === 'number' && r.data > 0) {
          emitPlayerEvent({ type: 'mpv-fps', fps: r.data });
        }
      }).catch(() => {});
      return;
    }
    // 播放到文件末尾
    if (msg.event === 'end-file') {
      lastTime = 0;
      if (msg.reason === 'eof') {
        emitPlayerEvent({ type: 'mpv-ended' });
      } else if (msg.reason === 'error') {
        emitPlayerEvent({
          type: 'mpv-error',
          message: t('errors.decodeFailed'),
        });
      }
      return;
    }
    // mpv input.conf 的 script-message：视频画面上的鼠标点击
    if (msg.event === 'client-message' && Array.isArray(msg.args) &&
        msg.args[0] === 'markplay-click') {
      handleSurfaceClick(msg.args[1]);
    }
  });

  client.on('close', () => {
    console.log('[main] mpv IPC 管道断开');
    mpvReady = false;
    mpvClient = null;
    currentDuration = 0;
  });

  client.on('error', (err) => {
    console.error('[main] mpv IPC 错误:', err.message);
  });
}

// ---------- 2x 播放 / 2x 倒放 ----------

/**
 * 视频画面点击（双路径去重后）：左键/中键 ↔ 2x 正放，右键 ↔ 2x 倒放。
 * @param {string} which - 'left' | 'right' | 'mid'
 */
function handleSurfaceClick(which) {
  const now = Date.now();
  if (now - lastSurfaceClickAt < 300) return; // 双路径去重
  lastSurfaceClickAt = now;
  // 点过 mpv 的原生画面后，键盘焦点可能落在 mpv 子窗口上，
  // 导致 Space / A / B / Ctrl+0 等快捷键失效。这里把焦点抢回主窗口。
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.focus();
      mainWindow.webContents.focus();
    } catch { /* 忽略 */ }
  }
  if (which === 'right') {
    setSpeedMode(speedMode === 'rev2x' ? 'normal' : 'rev2x');
  } else {
    setSpeedMode(speedMode === 'fwd2x' ? 'normal' : 'fwd2x');
  }
}

/**
 * 切换速度模式。
 * - fwd2x：mpv 原生 speed=2（真 2x，正放）；
 * - rev2x：mpv 不支持负速度，这里用"暂停 + 每 100ms 精确回退 0.2s"模拟 2x 倒放；
 * - normal：恢复 speed=1，并回到进入 2x 前的暂停/播放状态。
 * @param {'normal'|'fwd2x'|'rev2x'} mode
 */
async function setSpeedMode(mode) {
  if (!mpvClient) return;
  stopRevTimer();
  try {
    if (mode === 'fwd2x') {
      const r = await mpvClient.send(['get_property', 'pause']);
      resumePaused = r.data === true;
      await mpvClient.send(['set_property', 'speed', 2]);
      await mpvClient.send(['set_property', 'pause', false]);
    } else if (mode === 'rev2x') {
      const r = await mpvClient.send(['get_property', 'pause']);
      resumePaused = r.data === true;
      await mpvClient.send(['set_property', 'pause', true]);
      startRevTimer();
    } else {
      await mpvClient.send(['set_property', 'speed', 1]);
      if (!resumePaused) {
        await mpvClient.send(['set_property', 'pause', false]);
      }
      resumePaused = false;
    }
  } catch (err) {
    console.warn('[main] 切换速度模式失败:', err.message);
    return;
  }
  speedMode = mode;
  emitPlayerEvent({ type: 'speed-mode', mode });
}

function stopRevTimer() {
  if (revTimer) {
    clearTimeout(revTimer);
    revTimer = null;
  }
  // 递增代号：正在执行的旧 tick 回来时发现代号变了就自行退出，不会出现两条链
  revSeq += 1;
}

/**
 * 2x 倒放模拟：暂停状态下定时精确回退，到 0 自动停住。
 *
 * 用"await 完一次 seek 再排下一次"的链式 setTimeout，而不是 setInterval：
 * exact seek 在长 GOP 上可能需要几百毫秒，setInterval 会持续堆积命令，
 * 最终触发 5 秒超时、倒放越来越卡。
 */
function startRevTimer() {
  stopRevTimer();
  const seq = revSeq;
  const step = config.REV2X_STEP || 0.2;
  const interval = config.REV2X_INTERVAL_MS || 100;

  const tick = async () => {
    revTimer = null;
    if (seq !== revSeq || !mpvClient) return;
    try {
      const r = await mpvClient.send(['get_property', 'time-pos']);
      const pos = typeof r.data === 'number' ? r.data : 0;
      if (pos <= step + 0.05) {
        // 到头：停在 0，保持暂停
        await mpvClient.send(['set_property', 'time-pos', 0]).catch(() => {});
        await mpvClient.send(['set_property', 'speed', 1]).catch(() => {});
        speedMode = 'normal';
        resumePaused = true;
        emitPlayerEvent({ type: 'speed-mode', mode: 'normal' });
        return;
      }
      await mpvClient.send(['seek', -step, 'relative+exact']);
    } catch {
      /* 单次失败不致命，下一次继续 */
    }
    // 期间可能已被 setSpeedMode('normal') 取消
    if (seq === revSeq && speedMode === 'rev2x') {
      revTimer = setTimeout(tick, interval);
    }
  };

  revTimer = setTimeout(tick, interval);
}

/**
 * 把渲染进程上报的视频矩形应用到视频子窗口。
 *
 * 注意：Electron 的 setBounds / getContentBounds 全部使用 DIP（设备无关像素），
 * 与渲染进程的 CSS 像素一一对应，正常情况下不能再乘 scaleFactor（乘了会在
 * 125% / 150% 缩放的屏幕上整体放大并偏移）。config.SURFACE_APPLY_DPI_SCALE
 * 仅作为特殊 DPI 环境下的排查开关保留。
 */
function applyVideoRect(rect) {
  if (!mainWindow || mainWindow.isDestroyed() || !surfaceWindow || surfaceWindow.isDestroyed()) {
    return;
  }
  const display = screen.getDisplayMatching(mainWindow.getBounds());
  const s = config.SURFACE_APPLY_DPI_SCALE ? display.scaleFactor || 1 : 1;
  // 用客户区原点（屏幕坐标）而非 getPosition() 的外框原点：
  // 自动扣除标题栏/边框高度，避免视频窗口整体下移一个标题栏
  const cb = mainWindow.getContentBounds();

  const x = Math.round(cb.x + rect.x * s);
  const y = Math.round(cb.y + rect.y * s);
  const w = Math.round(rect.w * s);
  const h = Math.round(rect.h * s);
  const key = `${x},${y},${w},${h}`;

  // 500ms 轮询会反复送同一个矩形：没变就只处理"该显示却没显示"的情况
  if (key !== surfaceRectKey) {
    surfaceRectKey = key;
    surfaceWindow.setBounds({ x, y, width: w, height: h }, false);
  }

  // 首次定位后显示容器窗口
  if (mpvReady && !surfaceWindow.isVisible()) {
    surfaceWindow.show();
  }
}

// ---------- 视频子窗口全屏 ----------

/** 切换视频子窗口全屏 */
function toggleFullscreen() {
  if (!surfaceWindow || surfaceWindow.isDestroyed()) return;
  if (isSurfaceFullscreen) {
    exitFullscreen();
    return;
  }
  savedSurfaceBounds = surfaceWindow.getBounds();
  isSurfaceFullscreen = true;
  try {
    surfaceWindow.setFullScreen(true);
  } catch (err) {
    console.warn('[main] setFullScreen 失败，改用铺满:', err.message);
  }
  // 兜底：150ms 后若仍不是全屏，直接把窗口铺满所在显示器
  setTimeout(() => {
    if (isSurfaceFullscreen && surfaceWindow && !surfaceWindow.isDestroyed() &&
        !surfaceWindow.isFullScreen()) {
      const d = screen.getDisplayMatching(surfaceWindow.getBounds());
      surfaceWindow.setBounds(d.bounds);
    }
  }, 150);
  emitPlayerEvent({ type: 'fullscreen', fullscreen: true });
}

/** 退出全屏并恢复视频子窗口位置 */
function exitFullscreen() {
  if (!isSurfaceFullscreen) return;
  isSurfaceFullscreen = false;
  if (surfaceWindow && !surfaceWindow.isDestroyed()) {
    try { surfaceWindow.setFullScreen(false); } catch { /* 忽略 */ }
    if (savedSurfaceBounds) {
      surfaceWindow.setBounds(savedSurfaceBounds);
    } else if (lastVideoRect) {
      applyVideoRect(lastVideoRect);
    }
  }
  savedSurfaceBounds = null;
  emitPlayerEvent({ type: 'fullscreen', fullscreen: false });
}

/**
 * 确保 mpv 已启动并就绪（懒启动入口，并发安全）。
 * @returns {Promise<void>}
 */
async function ensureMpv() {
  if (mpvReady && mpvClient) return;
  if (mpvStarting) {
    await mpvStarting;
    return;
  }
  mpvStarting = (async () => {
    try {
      await startMpv();
      mpvReady = true;
    } catch (err) {
      const message = t('errors.mpvInit', { msg: err.message });
      console.error('[main]', message);
      if (mpvProcess) {
        killChild(mpvProcess);
        mpvProcess = null;
      }
      emitPlayerEvent({ type: 'mpv-error', message });
      throw err;
    } finally {
      mpvStarting = null;
    }
  })();
  await mpvStarting;
}

/**
 * 跑一次 ffmpeg 并等待结束（合并剪辑的分段/拼接复用）。
 * @param {string[]} args
 * @param {string} output 失败时删除这个文件
 * @param {number} totalUs 进度总时长（微秒），0 表示不报进度
 * @param {(percent:number)=>void} onPercent
 * @returns {Promise<void>}
 */
function runFfmpegJob(args, output, totalUs, onPercent) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(resolveBin('ffmpeg.exe'), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new Error(t('errors.ffmpegStart', { msg: err.message })));
      return;
    }
    ffmpegProcess = proc;
    let progressBuffer = '';
    let stderrTail = '';

    proc.once('error', (err) => {
      ffmpegProcess = null;
      reject(new Error(t('errors.ffmpegStart', { msg: err.message })));
    });

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      progressBuffer += chunk;
      let idx;
      while ((idx = progressBuffer.indexOf('\n')) >= 0) {
        const line = progressBuffer.slice(0, idx).trim();
        progressBuffer = progressBuffer.slice(idx + 1);
        const m = /^out_time_ms=(\d+)$/.exec(line);
        if (m && totalUs > 0) {
          onPercent(Math.min(100, Math.floor((Number(m[1]) / totalUs) * 100)));
        }
      }
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      stderrTail += chunk;
      if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000);
    });

    proc.once('close', (code) => {
      ffmpegProcess = null;
      if (code === 0) { resolve(); return; }
      try {
        if (fs.existsSync(output)) fs.unlinkSync(output);
      } catch { /* 文件可能被占用，忽略 */ }
      const detail = stderrTail.trim().split('\n').slice(-3).join(' | ');
      reject(new Error(detail
        ? t('errors.ffmpegCodeDetail', { code, detail })
        : t('errors.ffmpegCode', { code })));
    });
  });
}

/**
 * 读源文件字节数并估算目标视频码率（estimateVideoBitrate 的文件系统包装）。
 * 读不到文件或时长未知时返回 0，调用方会回退到 CRF。
 * @param {string} input
 * @param {number} durationSec
 * @returns {number} 视频码率（bps）
 */
function targetVideoBitrate(input, durationSec) {
  let bytes = 0;
  try {
    const st = fs.statSync(input);
    if (!st.isFile()) return 0;
    bytes = st.size;
  } catch {
    return 0;
  }
  return estimateVideoBitrate(bytes, durationSec);
}

// ---------- IPC：mpv 控制 ----------

/**
 * 注册所有渲染进程可调用的 IPC 通道。
 */
function registerIpc() {
  // 发送一条原始 mpv 命令
  ipcMain.handle('mpv-command', async (event, cmdArray) => {
    if (!mpvClient) throw new Error(t('errors.noMpv'));
    if (!Array.isArray(cmdArray)) throw new Error(t('errors.badCommand'));
    const res = await mpvClient.send(cmdArray);
    return res;
  });

  // 读取一个 mpv 属性
  ipcMain.handle('mpv-get', async (event, prop) => {
    if (!mpvClient) throw new Error(t('errors.noMpv'));
    if (typeof prop !== 'string' || prop.length === 0) throw new Error(t('errors.badProp'));
    const res = await mpvClient.send(['get_property', prop]);
    return res.data;
  });

  // 加载视频：懒启动 mpv → 等待 IPC 就绪 → loadfile
  /**
   * 加载视频的实际逻辑（渲染进程 load-video 与视频窗口拖放共用）。
   * @param {string} filePath
   * @param {boolean} [notifyRenderer] 是否需要额外发 video-loaded 事件。
   *   - 拖放（视频子窗口）时主进程是唯一入口，需要 true；
   *   - 渲染进程自己调的 load-video 会在 Promise 返回后自行刷新 UI，
   *     不能再发事件，否则同一个文件会被 afterVideoOpened 处理两次、sidecar 被追加两遍。
   */
  async function doLoadVideo(filePath, notifyRenderer) {
    if (!filePath || typeof filePath !== 'string') {
      const err = t('errors.invalidPath');
      emitPlayerEvent({ type: 'open-failed', message: err });
      return { ok: false, error: err };
    }
    if (!fs.existsSync(filePath)) {
      const err = t('open.notFound', { path: filePath });
      emitPlayerEvent({ type: 'open-failed', message: err });
      // 顺手把失效的最近记录清掉
      if (settings) settings.removeRecent(filePath);
      buildMenu();
      return { ok: false, error: err };
    }

    // 字幕：挂到当前播放上（sub-add），而不是当成视频打开
    if (isSubtitlePath(filePath)) {
      try {
        await ensureMpv();
        await mpvClient.send(['sub-add', filePath, 'select']);
        logInfo('[subtitle] add', filePath);
        emitPlayerEvent({ type: 'subtitle-added', path: filePath });
        return { ok: true };
      } catch (err) {
        logError('[subtitle] add failed', filePath, err);
        emitPlayerEvent({ type: 'open-failed', message: t('open.subtitleFailed', { msg: err.message }) });
        return { ok: false, error: err.message };
      }
    }

    // 只有媒体扩展名才接受（避免误拖入图片等）
    const ext = path.extname(filePath).slice(1).toLowerCase();
    if (ext && !MEDIA_EXTENSIONS.includes(ext)) {
      const err = t('open.unsupported', { ext });
      logWarn('[video] unsupported', filePath);
      emitPlayerEvent({ type: 'open-failed', message: err });
      return { ok: false, error: err };
    }
    try {
      await ensureMpv();
      await mpvClient.send(['loadfile', filePath, 'replace']);
      logInfo('[video] open', filePath);
      // 换片：作废转场缓存，并停掉可能还在跑的识别
      sceneCache = { path: '', scores: [] };
      if (sceneProcess) {
        killChild(sceneProcess);
        sceneProcess = null;
      }
      currentDuration = 0;
      lastTime = 0;
      surfaceRectKey = ''; // 换片后强制重新定位视频子窗口
      // 退出 2x 状态（换片不保留变速）
      stopRevTimer();
      if (speedMode !== 'normal') {
        speedMode = 'normal';
        resumePaused = false;
        mpvClient.send(['set_property', 'speed', 1]).catch(() => {});
        emitPlayerEvent({ type: 'speed-mode', mode: 'normal' });
      }
      // 确保视频容器窗口可见（实际定位由渲染进程发 set-video-rect）
      if (surfaceWindow && !surfaceWindow.isDestroyed() && !surfaceWindow.isVisible()) {
        surfaceWindow.show();
      }
      // 标题栏显示当前文件名
      currentVideoPath = filePath;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setTitle(`${path.basename(filePath)} — MarkPlay`);
      }
      // 最近打开 + 重建菜单
      if (settings) settings.addRecent(filePath);
      buildMenu();
      // 只有"主进程自己发起"的加载（视频子窗口拖放）才通知渲染进程；
      // 渲染进程调 load-video 时会自己刷新，重复通知会导致标记/区间被加载两次。
      if (notifyRenderer === true) {
        emitPlayerEvent({ type: 'video-loaded', path: filePath });
      }
      return { ok: true };
    } catch (err) {
      logError('[video] open failed', filePath, err);
      emitPlayerEvent({ type: 'open-failed', message: err.message });
      return { ok: false, error: err.message };
    }
  }

  ipcMain.handle('load-video', async (event, filePath) => doLoadVideo(filePath, false));

  // 视频子窗口上的文件拖放（surface-preload 转发）：主进程是唯一入口，需要通知渲染进程
  ipcMain.on('surface-drop-file', (event, filePath) => {
    doLoadVideo(filePath, true);
  });

  // 视频子窗口上的拖放悬停反馈 → 转给主窗口状态栏（HTML 盖不住原生画面，只能文字提示）
  ipcMain.on('surface-dragover', () => {
    emitPlayerEvent({ type: 'surface-dragover' });
  });

  // 渲染进程通知视频画面在主窗口内的 CSS 像素矩形（相对主窗口左上）
  ipcMain.on('set-video-rect', (event, rect) => {
    if (!surfaceWindow || surfaceWindow.isDestroyed() || !mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    if (!rect || [rect.x, rect.y, rect.w, rect.h].some((v) => typeof v !== 'number' || Number.isNaN(v))) {
      console.warn('[main] set-video-rect 参数无效:', rect);
      return;
    }
    if (rect.w <= 0 || rect.h <= 0) return;
    // 全屏时不接受重排（退出全屏后再恢复）
    if (isSurfaceFullscreen) return;

    // 渲染进程给的是 CSS 像素 = DIP，主进程侧不再做 DPI 换算
    // （config.SURFACE_APPLY_DPI_SCALE=true 时才按 scaleFactor 放大，用于特殊环境排查）
    lastVideoRect = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    applyVideoRect(rect);
  });

  // 视频子窗口的 wheel 事件 → 转发给主窗口渲染进程
  ipcMain.on('surface-wheel', (event, data) => {
    emitPlayerEvent({
      type: 'wheel',
      deltaX: data.deltaX,
      deltaY: data.deltaY,
      deltaMode: data.deltaMode,
      ctrlKey: data.ctrlKey === true,
      shiftKey: data.shiftKey === true,
      metaKey: data.metaKey === true,
    });
  });

  // 视频子窗口的鼠标点击（surface-preload 路径；与 mpv input.conf 双路径去重）
  ipcMain.on('surface-mousedown', (event, data) => {
    const b = data && data.button;
    handleSurfaceClick(b === 2 ? 'right' : b === 1 ? 'mid' : 'left');
  });

  // 渲染进程上报的错误/警告，写进同一份日志
  ipcMain.on('log-renderer', (event, level, message) => {
    const text = String(message || '');
    if (level === 'error') logError('[renderer]', text);
    else if (level === 'warn') logWarn('[renderer]', text);
    else logInfo('[renderer]', text);
  });

  // 2x 播放 / 2x 倒放
  ipcMain.handle('set-speed-mode', async (event, mode) => {
    if (mode !== 'normal' && mode !== 'fwd2x' && mode !== 'rev2x') {
      throw new Error(t('errors.badSpeedMode'));
    }
    await setSpeedMode(mode);
    return { ok: true, mode: speedMode };
  });
  ipcMain.handle('toggle-speed-mode', async (event, mode) => {
    if (mode !== 'fwd2x' && mode !== 'rev2x') throw new Error(t('errors.badSpeedMode'));
    await setSpeedMode(speedMode === mode ? 'normal' : mode);
    return { ok: true, mode: speedMode };
  });

  // 视频子窗口全屏
  ipcMain.handle('toggle-fullscreen', () => {
    toggleFullscreen();
    return { ok: true, fullscreen: isSurfaceFullscreen };
  });

  // ---------- IPC：对话框与文件 ----------

  ipcMain.handle('open-file-dialog', async () => {
    const lastDir = settings ? settings.get('lastDir') : '';
    const res = await dialog.showOpenDialog(mainWindow, {
      title: t('dialog.openVideoTitle'),
      defaultPath: lastDir && fs.existsSync(lastDir) ? lastDir : undefined,
      properties: ['openFile'],
      filters: [{ name: t('dialog.mediaFilter'), extensions: MEDIA_EXTENSIONS }],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('save-dialog', async (event, defaultName) => {
    const name = typeof defaultName === 'string' && defaultName ? defaultName : 'markers.csv';
    const lastDir = settings ? settings.get('lastDir') : '';
    const res = await dialog.showSaveDialog(mainWindow, {
      title: t('dialog.exportTitle'),
      defaultPath: lastDir && fs.existsSync(lastDir) ? path.join(lastDir, name) : name,
    });
    if (res.canceled || !res.filePath) return null;
    if (settings) settings.set('lastDir', path.dirname(res.filePath));
    return res.filePath;
  });

  ipcMain.handle('write-text-file', async (event, filePath, content) => {
    if (typeof filePath !== 'string' || typeof content !== 'string') {
      throw new Error(t('errors.badWrite'));
    }
    await fsp.writeFile(filePath, content, 'utf8');
  });

  ipcMain.handle('read-json-file', async (event, filePath) => {
    if (typeof filePath !== 'string') throw new Error(t('errors.badRead'));
    try {
      const text = await fsp.readFile(filePath, 'utf8');
      return JSON.parse(text);
    } catch (err) {
      if (err.code === 'ENOENT') return null; // 文件不存在 → null
      throw err;
    }
  });

  ipcMain.handle('write-json-file', async (event, filePath, obj) => {
    if (typeof filePath !== 'string') throw new Error(t('errors.badWriteJson'));
    await fsp.writeFile(filePath, JSON.stringify(obj, null, 2), 'utf8');
  });

  // ---------- IPC：字幕 / 目录 / 设置 ----------

  // 渲染进程把 srt/ass 拖进窗口时调用（视频子窗口拖放走 doLoadVideo 的字幕分支）
  ipcMain.handle('add-subtitle', async (event, filePath) => {
    if (typeof filePath !== 'string' || !isSubtitlePath(filePath)) {
      throw new Error(t('errors.badSubtitle'));
    }
    if (!fs.existsSync(filePath)) throw new Error(t('errors.subtitleMissing', { path: filePath }));
    await ensureMpv();
    await mpvClient.send(['sub-add', filePath, 'select']);
    return { ok: true };
  });

  ipcMain.handle('pick-directory', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: t('dialog.pickDirTitle'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    if (settings) settings.set('lastDir', res.filePaths[0]);
    return res.filePaths[0];
  });

  ipcMain.handle('show-item-in-folder', (event, filePath) => {
    if (typeof filePath === 'string' && filePath) shell.showItemInFolder(filePath);
  });

  ipcMain.handle('get-app-info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    mpv: resolveBin('mpv.exe'),
    ffmpeg: resolveBin('ffmpeg.exe'),
    userData: app.getPath('userData'),
    mediaExtensions: MEDIA_EXTENSIONS,
    subtitleExtensions: SUBTITLE_EXTENSIONS,
  }));

  ipcMain.handle('settings-get', () => (settings ? settings.get() : {}));
  ipcMain.handle('settings-set', (event, key, value) => (
    settings ? settings.set(key, value) : false
  ));
  ipcMain.handle('recent-list', () => (settings ? settings.get('recentFiles') : []));

  // 语言：preload 在页面脚本之前同步取值，保证首帧就是正确语言
  ipcMain.on('get-language', (event) => {
    event.returnValue = currentLang;
  });

  // 渲染进程主动请求切换语言（目前只由菜单触发，预留给将来的界面内切换按钮）
  ipcMain.handle('set-language', (event, lang) => {
    switchLanguage(lang);
    return { ok: true, language: currentLang };
  });

  // ---------- IPC：标记文件备份 ----------

  /**
   * 把 sidecar 复制一份带时间戳的备份，并清理超出保留数量的旧备份。
   * 渲染进程负责先把内存里的标记写盘，再调用这里。
   */
  ipcMain.handle('backup-sidecar', async (event, sidecarPath) => {
    if (typeof sidecarPath !== 'string' || sidecarPath.length === 0) {
      throw new Error(t('errors.badBackupPath'));
    }
    if (!fs.existsSync(sidecarPath)) {
      return { ok: false, error: t('errors.noSidecar') };
    }

    const dest = backupPathFor(sidecarPath, new Date());
    await fsp.copyFile(sidecarPath, dest);

    // 清理旧备份：只处理同一 sidecar 的备份，别动别的文件
    const dir = path.dirname(sidecarPath);
    let removed = 0;
    try {
      const keep = config.SIDECAR_BACKUP_KEEP || 10;
      const names = fs.readdirSync(dir).filter((n) => isBackupOf(n, sidecarPath));
      for (const name of pickBackupsToDelete(names, keep)) {
        try {
          fs.unlinkSync(path.join(dir, name));
          removed += 1;
        } catch { /* 单个删不掉不影响备份本身 */ }
      }
    } catch (err) {
      logWarn('[backup] 清理旧备份失败:', err.message);
    }

    logInfo('[backup] sidecar', dest, 'removed', removed);
    return { ok: true, path: dest, removed };
  });

  // ---------- IPC：转场识别（只做提示，不写入标记） ----------

  /**
   * 用 ffmpeg 的 select+showinfo 找出画面转场点。
   * 结果只通过事件推给渲染进程画成"浮标"，不落盘、不写标记。
   */
  ipcMain.handle('detect-scenes', async () => {
    if (!currentVideoPath) return { ok: false, error: t('scenes.needVideo') };
    if (sceneProcess) return { ok: false, error: t('scenes.busy') };
    if (!fs.existsSync(currentVideoPath)) {
      return { ok: false, error: t('scenes.videoGone') };
    }

    // 同一部片子扫过一次就直接复用：阈值在渲染进程实时过滤，不需要重扫
    if (sceneCache.path === currentVideoPath && sceneCache.scores.length) {
      emitPlayerEvent({ type: 'scene-detected', scores: sceneCache.scores, cached: true });
      return { ok: true, cached: true };
    }

    // 一次扫描把所有帧的 scene 分数取回来（select 全放行 + 打印 metadata），
    // 阈值调整在渲染进程本地过滤，不用重跑 ffmpeg。
    const filter = "select='gte(scene\\,0)',metadata=print:file=-";
    const args = [
      '-hide_banner',
      '-nostdin',
      '-i', currentVideoPath,
      '-an', '-sn', '-dn',
      '-filter:v', filter,
      '-f', 'null',
      '-',
    ];

    logInfo('[scenes] start', currentVideoPath, 'floor', SCENE_SCORE_FLOOR);
    emitPlayerEvent({ type: 'scene-start', floor: SCENE_SCORE_FLOOR });

    let proc;
    try {
      proc = spawn(resolveBin('ffmpeg.exe'), args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      emitPlayerEvent({ type: 'scene-error', message: t('scenes.spawnFailed', { msg: err.message }) });
      return { ok: false, error: err.message };
    }
    sceneProcess = proc;

    const floor = SCENE_SCORE_FLOOR;
    let scores = [];
    let buffer = '';
    let scannedTo = 0;
    let lastEmit = 0;
    const startedAt = Date.now();

    // 分数走 stdout（metadata=print:file=-），ffmpeg 自身的错误走 stderr
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      const lines = (buffer + chunk).split('\n');
      buffer = lines.pop() || '';

      // 一个分数由两行组成（pts_time 行 + scene_score 行）。
      // 若最后一条完整行是 pts_time 行，它的分数行可能还没到，留到下次再配。
      let carry = '';
      if (lines.length && lines[lines.length - 1].indexOf('pts_time:') !== -1) {
        carry = lines.pop();
      }

      const parsed = parseSceneScores(lines.join('\n'), { floor, max: 100000 - scores.length });
      if (parsed.length) {
        for (const p of parsed) scores.push(p);
        scannedTo = parsed[parsed.length - 1].t;
      }
      if (carry) buffer = carry + '\n' + buffer;

      const now = Date.now();
      if (now - lastEmit > 300) {
        lastEmit = now;
        emitPlayerEvent({
          type: 'scene-progress',
          frames: scores.length,
          scannedTo,
          elapsedSec: Math.round((now - startedAt) / 1000),
        });
      }
    });

    let stderrTail = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });

    proc.once('error', (err) => {
      sceneProcess = null;
      logError('[scenes] spawn failed', err);
      emitPlayerEvent({ type: 'scene-error', message: t('scenes.startFailed', { msg: err.message }) });
    });

    proc.once('close', (code, signal) => {
      sceneProcess = null;
      const cancelled = signal === 'SIGTERM' || signal === 'SIGKILL' || quitting;
      if (cancelled) {
        logInfo('[scenes] cancelled');
        emitPlayerEvent({ type: 'scene-cancelled', frames: scores.length });
        return;
      }
      if (code !== 0) {
        logError('[scenes] ffmpeg exit', code, stderrTail.slice(-400));
        const tail = stderrTail.trim().split('\n').pop() || '';
        emitPlayerEvent({
          type: 'scene-error',
          message: t('scenes.exitFailed', { code }) + (tail ? ' ' + tail : ''),
        });
        return;
      }

      // 末尾残留的半行/半组也尝试收一下
      if (buffer.trim()) {
        const tail = parseSceneScores(buffer, { floor });
        for (const p of tail) scores.push(p);
      }
      scores.sort((a, b) => a.t - b.t);
      sceneCache = { path: currentVideoPath, scores };
      logInfo('[scenes] done', scores.length, 'frames >= floor in',
        Math.round((Date.now() - startedAt) / 1000) + 's');
      emitPlayerEvent({ type: 'scene-detected', scores });
    });

    return { ok: true };
  });

  ipcMain.handle('cancel-scenes', () => {
    if (!sceneProcess) return { ok: true, running: false };
    logInfo('[scenes] cancel requested');
    killChild(sceneProcess);
    sceneProcess = null;
    return { ok: true, running: false };
  });

  // ---------- IPC：ffmpeg 剪辑 ----------

  ipcMain.handle('run-clip', async (event, opts) => {
    // 参数校验
    if (!opts || typeof opts.input !== 'string' || typeof opts.output !== 'string') {
      return { ok: false, error: t('clip.needInputOutput') };
    }
    const ss = Number(opts.ss);
    const to = Number(opts.to);
    if (!fs.existsSync(opts.input)) {
      return { ok: false, error: t('clip.inputMissing', { path: opts.input }) };
    }
    if (!(ss >= 0) || !(to > ss)) {
      return { ok: false, error: t('clip.badRange', { ss: opts.ss, to: opts.to }) };
    }
    if (ffmpegProcess && ffmpegProcess.exitCode === null && !ffmpegProcess.killed) {
      return { ok: false, error: t('clip.busy') };
    }
    if (mergeInProgress) {
      return { ok: false, error: t('clip.mergeBusy') };
    }

    const ffmpegExe = resolveBin('ffmpeg.exe');
    const reencode = opts.reencode === true;
    const isMp4 = /\.(mp4|m4v|mov)$/i.test(opts.output);
    // 用 -t（时长）而不是 -to（绝对时间）：-ss 放在 -i 之前时时间戳会被重置，
    // -to 的语义在"输入 seek + 输出时间轴"组合下有歧义，-t 则明确就是剪多长。
    const durationSec = Math.max(0.001, to - ss);
    // 重新编码时按源文件码率压，避免 CRF 23 把低码率源文件"压大"
    const targetBps = reencode ? targetVideoBitrate(opts.input, Number(opts.duration)) : 0;
    try {
      fs.mkdirSync(path.dirname(opts.output), { recursive: true });
    } catch { /* 目录已存在 / 无权限时让 ffmpeg 报错 */ }
    const args = [
      '-y',
      '-ss', String(ss),
      '-i', opts.input,
      '-t', durationSec.toFixed(3),
      ...(reencode
        ? reencodeArgs(targetBps)
        : ['-c', 'copy', '-avoid_negative_ts', 'make_zero']),
      // mp4 放到手机/剪辑软件里更友好；对 mkv 等容器无意义，只在 mp4/mov 时加
      ...(isMp4 ? ['-movflags', '+faststart'] : []),
      '-progress', 'pipe:1',
      '-nostats',
      opts.output,
    ];

    console.log('[main] 启动 ffmpeg:', ffmpegExe, args.join(' '));
    logInfo('[ffmpeg] start', args.join(' '));

    try {
      ffmpegProcess = spawn(ffmpegExe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      emitPlayerEvent({ type: 'clip-error', message: t('errors.ffmpegStart', { msg: err.message }) });
      return { ok: false, error: err.message };
    }

    const proc = ffmpegProcess;
    const output = opts.output;
    lastClipPercent = -1;
    let progressBuffer = '';
    let stderrTail = '';
    // 目标总时长（微秒），用于算百分比
    const totalUs = durationSec * 1e6;

    proc.once('error', (err) => {
      ffmpegProcess = null;
      emitPlayerEvent({ type: 'clip-error', message: t('errors.ffmpegStart', { msg: err.message }) });
    });

    // -progress pipe:1 输出形如 out_time_ms=123456 的键值对
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      progressBuffer += chunk;
      let idx;
      while ((idx = progressBuffer.indexOf('\n')) >= 0) {
        const line = progressBuffer.slice(0, idx).trim();
        progressBuffer = progressBuffer.slice(idx + 1);
        const m = /^out_time_ms=(\d+)$/.exec(line);
        if (m && totalUs > 0) {
          const percent = Math.min(100, Math.floor((Number(m[1]) / totalUs) * 100));
          if (percent > lastClipPercent) {
            lastClipPercent = percent;
            emitPlayerEvent({ type: 'clip-progress', percent });
          }
        }
      }
    });

    // 保留 stderr 尾部，失败时用于报错信息
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      stderrTail += chunk;
      if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000);
    });

    proc.once('close', (code) => {
      ffmpegProcess = null;
      if (code === 0) {
        logInfo('[ffmpeg] done', output);
        emitPlayerEvent({ type: 'clip-progress', percent: 100 });
        emitPlayerEvent({ type: 'clip-done', output });
      } else {
        // 失败时删掉半截文件，避免用户误以为剪辑成功
        try {
          if (fs.existsSync(output)) fs.unlinkSync(output);
        } catch { /* 文件可能被占用，忽略 */ }
        const detail = stderrTail.trim().split('\n').slice(-3).join(' | ');
        logError('[ffmpeg] exit', code, detail);
        emitPlayerEvent({
          type: 'clip-error',
          message: detail
            ? t('errors.ffmpegCodeDetail', { code, detail })
            : t('errors.ffmpegCode', { code }),
        });
      }
    });

    return { ok: true };
  });

  // 合并剪辑：把多个区间分别切出来，再用 concat demuxer 拼成一个文件
  ipcMain.handle('run-merge-clip', async (event, opts) => {
    if (!opts || typeof opts.input !== 'string' || typeof opts.output !== 'string'
        || !Array.isArray(opts.ranges) || opts.ranges.length === 0) {
      return { ok: false, error: t('clip.mergeBadArgs') };
    }
    if (mergeInProgress || (ffmpegProcess && ffmpegProcess.exitCode === null && !ffmpegProcess.killed)) {
      return { ok: false, error: t('clip.busy') };
    }
    if (!fs.existsSync(opts.input)) {
      return { ok: false, error: t('clip.inputMissing', { path: opts.input }) };
    }
    const ranges = opts.ranges
      .map((r) => ({ ss: Number(r.ss), to: Number(r.to) }))
      .filter((r) => Number.isFinite(r.ss) && Number.isFinite(r.to) && r.to > r.ss);
    if (!ranges.length) {
      return { ok: false, error: t('clip.noValidRange') };
    }

    const isMp4 = /\.(mp4|m4v|mov)$/i.test(opts.output);
    try {
      fs.mkdirSync(path.dirname(opts.output), { recursive: true });
    } catch { /* 目录不可写时让 ffmpeg 报错 */ }

    mergeInProgress = true;
    let tmpDir;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'markplay-merge-'));
    } catch (err) {
      mergeInProgress = false;
      return { ok: false, error: t('clip.tmpDirFailed', { msg: err.message }) };
    }
    const total = ranges.length;
    // 合并也是重新编码：同样按源文件码率压，避免合并后的文件比源文件还大
    const targetBps = targetVideoBitrate(opts.input, Number(opts.duration));
    logInfo('[ffmpeg] merge start', total, opts.output);

    (async () => {
      const parts = [];
      try {
        for (let i = 0; i < total; i++) {
          const range = ranges[i];
          const part = path.join(tmpDir, `part_${String(i + 1).padStart(2, '0')}.mp4`);
          parts.push(part);
          const durationSec = Math.max(0.001, range.to - range.ss);
          // 合并必须重新编码：stream copy 的切点会落在关键帧上，
          // 要么多带前一段内容，要么从一个非关键帧开始导致开头解不出来。
          const args = [
            '-y',
            '-ss', String(range.ss),
            '-i', opts.input,
            '-t', durationSec.toFixed(3),
            ...reencodeArgs(targetBps),
            '-movflags', '+faststart',
            '-progress', 'pipe:1',
            '-nostats',
            part,
          ];
          await runFfmpegJob(args, part, durationSec * 1e6, (percent) => {
            emitPlayerEvent({
              type: 'clip-progress',
              percent: Math.min(89, Math.round(((i + percent / 100) / total) * 90)),
            });
          });
          emitPlayerEvent({ type: 'clip-progress', percent: Math.round(((i + 1) / total) * 90) });
        }

        const listPath = path.join(tmpDir, 'concat.txt');
        fs.writeFileSync(listPath, parts.map(toConcatLine).join('\n'), 'utf8');
        const concatArgs = [
          '-y',
          '-f', 'concat',
          '-safe', '0',
          '-i', listPath,
          '-c', 'copy',
          ...(isMp4 ? ['-movflags', '+faststart'] : []),
          '-progress', 'pipe:1',
          '-nostats',
          opts.output,
        ];
        await runFfmpegJob(concatArgs, opts.output, 0, () => {});
        emitPlayerEvent({ type: 'clip-progress', percent: 100 });
        emitPlayerEvent({ type: 'clip-done', output: opts.output });
        logInfo('[ffmpeg] merge done', opts.output);
      } catch (err) {
        logError('[ffmpeg] merge failed', err);
        emitPlayerEvent({ type: 'clip-error', message: t('clip.mergeFailed', { msg: err.message }) });
      } finally {
        mergeInProgress = false;
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch { /* 忽略清理失败 */ }
      }
    })();

    return { ok: true };
  });
}

// ---------- 应用菜单 ----------

/** 从菜单/快捷键走"打开文件"：选完发 open-file 事件，与工具栏按钮同一入口 */
async function pickAndOpenDialog() {
  const lastDir = settings ? settings.get('lastDir') : '';
  const res = await dialog.showOpenDialog(mainWindow, {
    title: t('dialog.openVideoTitle'),
    defaultPath: lastDir && fs.existsSync(lastDir) ? lastDir : undefined,
    properties: ['openFile'],
    filters: [{ name: t('dialog.mediaFilter'), extensions: MEDIA_EXTENSIONS }],
  });
  if (res.canceled || res.filePaths.length === 0) return;
  if (settings) settings.set('lastDir', path.dirname(res.filePaths[0]));
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('player-event', { type: 'open-file', path: res.filePaths[0] });
  }
}

/** 构建"最近打开"子菜单（空列表时给一个禁用的占位项） */
function buildRecentSubmenu() {
  const recent = settings ? settings.get('recentFiles') : [];
  const items = recent.map((file) => ({
    label: path.basename(file),
    toolTip: file,
    click: () => {
      if (!fs.existsSync(file)) {
        dialog.showMessageBox(mainWindow, {
          type: 'warning', title: t('dialog.fileGoneTitle'), message: t('dialog.fileGoneMessage'), detail: file,
        });
        if (settings) settings.removeRecent(file);
        buildMenu();
        return;
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('player-event', { type: 'open-file', path: file });
      }
    },
  }));
  if (items.length === 0) {
    items.push({ label: t('menu.recentEmpty'), enabled: false });
  } else {
    items.push({ type: 'separator' });
    items.push({
      label: t('menu.clearRecent'),
      click: () => {
        if (!settings) return;
        settings.clearRecent();
        buildMenu();
      },
    });
  }
  return items;
}

/**
 * 构建并设置应用菜单（Windows 上不设置会显示只有"退出"的默认菜单）。
 * 打开视频走 open-file 事件 → 渲染进程 load-video，与工具栏按钮同一入口。
 */
function buildMenu() {
  const template = [
    {
      label: t('menu.file'),
      submenu: [
        { label: t('menu.openVideo'), accelerator: 'CmdOrCtrl+O', click: pickAndOpenDialog },
        { label: t('menu.recent'), submenu: buildRecentSubmenu() },
        { type: 'separator' },
        {
          label: t('menu.backupSidecar'),
          // 放在菜单里而不是渲染进程 keydown：菜单加速键在输入框聚焦时也生效
          accelerator: 'CmdOrCtrl+S',
          enabled: !!currentVideoPath,
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('player-event', { type: 'backup-sidecar' });
            }
          },
        },
        {
          label: t('menu.revealCurrent'),
          enabled: !!currentVideoPath,
          click: () => {
            if (currentVideoPath) shell.showItemInFolder(currentVideoPath);
          },
        },
        { type: 'separator' },
        { label: t('menu.quit'), accelerator: 'Alt+F4', role: 'quit' },
      ],
    },
    {
      // 语言切换：radio 项，勾选态跟着 settings 走
      label: t('menu.language'),
      submenu: [
        {
          label: '中文',
          type: 'radio',
          checked: currentLang === 'zh-CN',
          click: () => switchLanguage('zh-CN'),
        },
        {
          label: 'English',
          type: 'radio',
          checked: currentLang === 'en-US',
          click: () => switchLanguage('en-US'),
        },
      ],
    },
    {
      label: t('menu.help'),
      submenu: [
        {
          label: t('menu.shortcuts'),
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: t('dialog.shortcutsTitle'),
              message: t('dialog.shortcutsMessage'),
              detail: [
                t('shortcuts.playPause'),
                t('shortcuts.seek'),
                t('shortcuts.frame'),
                t('shortcuts.markers'),
                t('shortcuts.speed'),
                t('shortcuts.loop'),
                t('shortcuts.del'),
                t('shortcuts.undo'),
                t('shortcuts.fullscreen'),
                t('shortcuts.open'),
                t('shortcuts.export'),
              ].join('\n'),
            });
          },
        },
        {
          label: t('menu.openLogFolder'),
          click: () => {
            if (!logger) return;
            shell.openPath(path.dirname(logger.getPath())).catch(() => {});
          },
        },
        {
          label: t('menu.openDataFolder'),
          click: () => {
            shell.openPath(app.getPath('userData')).catch(() => {});
          },
        },
        { type: 'separator' },
        {
          label: t('menu.about'),
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: t('dialog.aboutTitle'),
              message: `${t('app.name')} ${t('app.tagline')} v${app.getVersion()}`,
              detail: t('about.detail')
                + (logger ? `\n${logger.getPath()}` : ''),
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * 切换界面语言：落盘 → 重建翻译函数 → 重建菜单 → 通知渲染进程重刷文案。
 * 不重载窗口，所以正在播的视频和标记都不会丢。
 * @param {'zh-CN'|'en-US'} lang
 */
function switchLanguage(lang) {
  const next = normalize(lang);
  if (next === currentLang) return;

  setLanguage(next);
  if (settings) settings.set('language', next);
  logInfo('[i18n] language ->', next);

  buildMenu();

  if (mainWindow && !mainWindow.isDestroyed()) {
    const name = next === 'zh-CN' ? '中文' : 'English';
    mainWindow.webContents.send('player-event', {
      type: 'language-changed',
      language: next,
      name,
    });
  }
  // 悬浮层没有（已回滚），这里无需处理
}

// ---------- 应用生命周期 ----------

// 单实例：第二份进程只负责把文件转交给已运行的窗口，
// 避免两个 mpv、两个 sidecar 写入者互相打架。
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.setAppUserModelId('com.markplay.app');

  app.on('second-instance', (event, argv) => {
    const file = findMediaArg(argv);
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    if (!file) return;
    if (!mainWindow.webContents || mainWindow.webContents.isLoading()) {
      // 窗口/界面还没就绪：记下来，等 did-finish-load 再发
      startupFile = file;
    } else {
      mainWindow.webContents.send('player-event', { type: 'open-file', path: file });
    }
  });

  app.whenReady().then(() => {
    logger = new Logger(path.join(app.getPath('userData'), 'logs'));
    logInfo('MarkPlay start', 'v' + app.getVersion(), process.platform, process.arch,
      'electron', process.versions.electron, 'node', process.versions.node);
    logInfo('paths', {
      userData: app.getPath('userData'),
      mpv: resolveBin('mpv.exe'),
      ffmpeg: resolveBin('ffmpeg.exe'),
    });

    settings = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'));
    settings.load();

    // 语言：用户选过就用用户的，否则跟系统；首次启动把系统语言落盘
    const savedLang = settings.get('language');
    if (savedLang && SUPPORTED.includes(savedLang)) {
      setLanguage(savedLang);
    } else {
      // app.getLocale() 在 Windows 上返回形如 'zh-CN' / 'en-US' 的标签
      const sysLang = normalize(app.getLocale());
      setLanguage(sysLang);
      settings.set('language', sysLang);
    }
    logInfo('[i18n] language', currentLang, '(saved:', savedLang || 'none', ')');

    startupFile = findMediaArg(process.argv);

    createMainWindow();
    createSurfaceWindow();
    registerIpc();
    buildMenu();

    // 渲染进程崩溃（不是 JS 报错，而是进程没了）：记日志，方便定位是 mpv 嵌入还是驱动问题
    app.on('render-process-gone', (event, webContents, details) => {
      logError('render-process-gone', details);
    });

    // 等界面加载完成后再处理命令行/文件关联传入的视频
    mainWindow.webContents.once('did-finish-load', () => {
      if (startupFile && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('player-event', { type: 'open-file', path: startupFile });
        startupFile = '';
      }
    });

    app.on('activate', () => {
      // macOS：dock 点击时重建窗口
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
        createSurfaceWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  // 退出前保存设置、杀掉所有子进程（mpv / ffmpeg）
  app.on('before-quit', () => {
    quitting = true;
    stopRevTimer();
    if (settings) settings.save();
    if (mpvClient) {
      mpvClient.close();
      mpvClient = null;
    }
    killChild(ffmpegProcess);
    ffmpegProcess = null;
    killChild(sceneProcess);
    sceneProcess = null;
    killChild(mpvProcess);
    mpvProcess = null;
  });
}

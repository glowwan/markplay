/* 文件列表窗口的逻辑
 *
 * 只做三件事：渲染列表、上报点击、处理关闭。
 * 数据全部来自主进程（它才是列表的拥有者），这样两个窗口的视图总是一致的。
 */

(function () {
  'use strict';

  var panel = document.getElementById('panel');
  var listEl = document.getElementById('list');
  var countEl = document.getElementById('count');
  var closeBtn = document.getElementById('close');
  var exitFullBtn = document.getElementById('exit-fullscreen');
  var addBtn = document.getElementById('add');
  var footEl = document.getElementById('foot');

  /** 当前数据：{ items: [{path,name,dir}], index } */
  var data = { items: [], index: -1 };

  function t(key, params) {
    return window.markplay && window.markplay.t
      ? window.markplay.t(key, params)
      : key;
  }

  // ---------- 渲染 ----------

  /**
   * 全屏状态变化时：只有全屏才显示"退出全屏"按钮。
   * @param {boolean} fullscreen
   */
  function applyFullscreen(fullscreen) {
    if (!exitFullBtn) return;
    exitFullBtn.hidden = !fullscreen;
    document.body.classList.toggle('fullscreen', !!fullscreen);
  }

  function render() {
    listEl.innerHTML = '';

    if (!data.items.length) {
      var empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = t('playlist.empty');
      listEl.appendChild(empty);
      countEl.textContent = '';
      return;
    }

    countEl.textContent = t('playlist.count', { n: data.items.length });

    data.items.forEach(function (item, i) {
      var li = document.createElement('li');
      li.className = 'item' + (i === data.index ? ' current' : '');
      li.dataset.index = String(i);
      li.title = item.path;

      var idx = document.createElement('span');
      idx.className = 'idx';
      idx.textContent = String(i + 1).padStart(2, '0');
      li.appendChild(idx);

      var meta = document.createElement('span');
      meta.className = 'meta';

      var name = document.createElement('div');
      name.className = 'name';
      name.textContent = item.name;
      meta.appendChild(name);

      if (item.dir) {
        var dir = document.createElement('div');
        dir.className = 'dir';
        dir.textContent = item.dir;
        meta.appendChild(dir);
      }

      li.appendChild(meta);

      var playing = document.createElement('span');
      playing.className = 'playing';
      li.appendChild(playing);

      // 移除按钮：只从列表去掉，不删文件
      var rm = document.createElement('button');
      rm.className = 'remove';
      rm.type = 'button';
      rm.textContent = '✕';
      rm.title = t('playlist.remove');
      rm.addEventListener('click', function (e) {
        e.stopPropagation();
        window.markplay.remove(i);
      });
      rm.addEventListener('dblclick', function (e) {
        e.stopPropagation();   // 别让双击落到条目上触发"打开并关闭"
      });
      li.appendChild(rm);

      /**
       * 事件是否来自"移除按钮"内部。
       * ✕ 自己已经 stopPropagation，这里再按 target 兜一层：
       * 万一某个浏览器/合成事件让冒泡穿过来了，也不会误触发"打开/关闭"。
       */
      function fromRemoveBtn(e) {
        var el = e && e.target;
        while (el && el !== li) {
          if (el.classList && el.classList.contains('remove')) return true;
          el = el.parentNode;
        }
        return false;
      }

      li.addEventListener('click', function (e) {
        if (fromRemoveBtn(e)) return;
        window.markplay.openItem(i);
      });

      // 双击 = 打开并关闭列表，符合"选完就走"的直觉
      li.addEventListener('dblclick', function (e) {
        if (fromRemoveBtn(e)) return;
        window.markplay.openItem(i);
        window.markplay.close();
      });

      listEl.appendChild(li);
    });

    // 当前项滚动到可见区。
    // 这里手算 listEl.scrollTop，而不是用 element.scrollIntoView：
    // 后者会把"最近的可滚动祖先"一路算到文档，可能连带滚动整个文档，
    // 把 fixed 之外的布局整体顶走（这正是"列表突然消失"的一种典型成因）。
    var cur = listEl.querySelector('.item.current');
    if (cur) {
      var curTop = cur.offsetTop;
      var curH = cur.offsetHeight;
      var viewTop = listEl.scrollTop;
      var viewH = listEl.clientHeight;
      if (curTop < viewTop) {
        listEl.scrollTop = curTop;
      } else if (curTop + curH > viewTop + viewH) {
        listEl.scrollTop = curTop + curH - viewH;
      }
    }
  }

  // ---------- 淡入 ----------
  // 主进程负责显示窗口，这里只管内部动画
  requestAnimationFrame(function () {
    panel.classList.add('in');
  });

  // ---------- 事件 ----------

  if (closeBtn) {
    closeBtn.addEventListener('click', function () {
      window.markplay.close();
    });
  }

  if (addBtn) {
    addBtn.addEventListener('click', function () {
      window.markplay.add();
    });
  }

  if (exitFullBtn) {
    exitFullBtn.addEventListener('click', function () {
      window.markplay.exitFullscreen();
    });
  }

  // Esc 关闭串门：列表窗口拿到焦点时也能用 Esc 收起
  window.addEventListener('keydown', function (e) {
    if (e.code === 'Escape' || e.key === 'Escape') {
      window.markplay.close();
    }
  });

  window.markplay.onData(function (next) {
    if (!next) return;
    data = {
      items: Array.isArray(next.items) ? next.items : [],
      index: typeof next.index === 'number' ? next.index : -1,
    };
    applyFullscreen(next.fullscreen);
    render();
  });

  window.markplay.onLanguage(function () {
    I18n.applyI18n();
    render();
  });

  // 首帧：先按"非全屏"初始化按钮状态（HTML 里已有 hidden，这里再兜一次）
  applyFullscreen(false);
  // 再渲染空状态，避免白屏
  render();

  // 通知主进程可以推数据了
  window.markplay.ready();
})();

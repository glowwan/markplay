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
  var footEl = document.getElementById('foot');

  /** 当前数据：{ items: [{path,name,dir}], index } */
  var data = { items: [], index: -1 };

  function t(key, params) {
    return window.markplay && window.markplay.t
      ? window.markplay.t(key, params)
      : key;
  }

  // ---------- 渲染 ----------

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

      li.addEventListener('click', function () {
        window.markplay.openItem(i);
      });

      // 双击 = 打开并关闭列表，符合"选完就走"的直觉
      li.addEventListener('dblclick', function () {
        window.markplay.openItem(i);
        window.markplay.close();
      });

      listEl.appendChild(li);
    });

    // 当前项滚动到可见区
    var cur = listEl.querySelector('.item.current');
    if (cur && cur.scrollIntoView) {
      cur.scrollIntoView({ block: 'nearest' });
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
    render();
  });

  window.markplay.onLanguage(function () {
    I18n.applyI18n();
    render();
  });

  // 首帧先渲染空状态，避免白屏
  render();

  // 通知主进程可以推数据了
  window.markplay.ready();
})();

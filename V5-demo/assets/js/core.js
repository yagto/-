/* ============================================================
   core.js — 基础工具 / 状态管理 / 提示条
   ------------------------------------------------------------
   ★ 本项目全部使用「普通脚本 + defer」，不使用 ES Module。
     原因：ES Module 在 file:// 下会被浏览器安全策略拦掉，
     导致双击 index.html 打开时所有交互静默消失。
     用普通脚本就没有这个问题 —— 双击即可打开，不需要服务器，
     也不需要打包。代价是各文件通过 window.Resume 这个命名空间
     互相引用，而不是 import。
   ============================================================ */

window.Resume = window.Resume || {};

(function (R) {
  'use strict';

  /* ============================================================
     1) DOM 与基础工具
     ============================================================ */
  const $  = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /** 用 requestAnimationFrame 节流。所有滚动回调都走它。 */
  function rafThrottle(fn) {
    let ticking = false;
    let lastArgs = null;
    return function throttled() {
      lastArgs = arguments;
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        fn.apply(null, lastArgs);
      });
    };
  }

  function debounce(fn, wait) {
    wait = wait || 150;
    let t = null;
    return function debounced() {
      const args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(null, args); }, wait);
    };
  }

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  /**
   * 元素在文档中的绝对顶边。
   * 不能直接用 offsetTop —— 它相对 offsetParent，
   * 一旦中间多一层定位祖先就会算错。沿链累加在任何嵌套下都正确。
   */
  function docTop(el) {
    let y = 0;
    let node = el;
    while (node) {
      y += node.offsetTop || 0;
      node = node.offsetParent;
    }
    return y;
  }

  function createEl(tag, attrs, children) {
    const el = document.createElement(tag);
    attrs = attrs || {};
    for (const k in attrs) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === 'dataset') {
        for (const d in v) el.dataset[d] = v[d];
      } else {
        el.setAttribute(k, v === true ? '' : v);
      }
    }
    const list = [].concat(children || []);
    for (const c of list) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  /* ============================================================
     2) 环境与特性检测
     ============================================================ */
  const prefersReducedMotion = () =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const isWide = (min) => window.matchMedia('(min-width:' + (min || 768) + 'px)').matches;

  const supports = {
    snap:      () => CSS.supports('scroll-snap-type', 'y mandatory'),
    dialog:    () => typeof HTMLDialogElement !== 'undefined' &&
                      typeof HTMLDialogElement.prototype.showModal === 'function',
    io:        () => 'IntersectionObserver' in window,
    clipboard: () => !!(navigator.clipboard && navigator.clipboard.writeText),
  };

  /**
   * 存储读写包装。
   * ★ 隐私模式 / 微信 WebView 里 setItem 会直接抛异常。
   *   不 try 的话一个异常就会让 main.js 顶层中断，
   *   后续所有模块静默不执行 —— 症状是"部分功能莫名其妙全没了"。
   */
  function makeStorage(kind) {
    const fallback = Object.create(null);
    let usable = false;
    try {
      const s = window[kind];
      s.setItem('__probe__', '1');
      s.removeItem('__probe__');
      usable = true;
    } catch (e) { usable = false; }

    return {
      get(key) {
        try { return usable ? window[kind].getItem(key) : (fallback[key] || null); }
        catch (e) { return fallback[key] || null; }
      },
      set(key, value) {
        try { if (usable) window[kind].setItem(key, value); else fallback[key] = value; }
        catch (e) { fallback[key] = value; }
      },
      remove(key) {
        try { if (usable) window[kind].removeItem(key); else delete fallback[key]; }
        catch (e) { delete fallback[key]; }
      }
    };
  }

  /** 复制到剪贴板。三级降级，最后退回"请手动复制"。 */
  function copyText(text) {
    if (supports.clipboard()) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return legacyCopy(text); }
      );
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    // 微信 WebView 里常常只有 execCommand 这条路可用
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  /** 屏幕阅读器播报 */
  function announce(message) {
    let live = document.getElementById('sr-live');
    if (!live) {
      live = createEl('div', {
        id: 'sr-live', class: 'sr-only', role: 'status', 'aria-live': 'polite'
      });
      document.body.appendChild(live);
    }
    live.textContent = '';
    setTimeout(function () { live.textContent = message; }, 50);
  }

  /* ============================================================
     3) 极简发布/订阅状态
     ============================================================ */
  const SESSION_KEY = 'resume.v2.session';

  const state = {
    activeSection: null,
    visited: new Set(),
    openedNodes: new Set(),
    qa: { open: false, used: false },
    copied: false,
    plain: false
  };

  (function restore() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved.visited) saved.visited.forEach(v => state.visited.add(v));
      if (saved.openedNodes) saved.openedNodes.forEach(v => state.openedNodes.add(v));
      if (saved.copied) state.copied = true;
      if (saved.qaUsed) state.qa.used = true;
    } catch (e) { /* 存档坏了就当新访客 */ }
  })();

  const subs = new Set();
  let flushing = false;

  function persist() {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        visited: Array.from(state.visited),
        openedNodes: Array.from(state.openedNodes),
        copied: state.copied,
        qaUsed: state.qa.used
      }));
    } catch (e) { /* 存不下就算了，不影响功能 */ }
  }

  const getState = () => state;

  function subscribe(fn) {
    subs.add(fn);
    return function () { subs.delete(fn); };
  }

  /**
   * 更新状态并通知订阅者。
   *   setState({ activeSection: 'skills' })     普通字段
   *   setState({ add: { visited: 'skills' } })   往 Set 里加
   *
   * ★ 不能在 subscribe 回调里直接调 setState —— 会被重入保护静默丢弃。
   *   需要连锁更新时用 queueMicrotask 推到 flush 之外。
   */
  function setState(patch) {
    patch = patch || {};
    if (flushing) {
      console.warn('[store] 订阅回调中再次 setState，已忽略', patch);
      return;
    }

    let changed = false;

    for (const k in patch) {
      if (k === 'add') continue;
      if (state[k] === patch[k]) continue;
      state[k] = patch[k];
      changed = true;
    }

    if (patch.add) {
      for (const k in patch.add) {
        const set = state[k];
        if (!(set instanceof Set) || set.has(patch.add[k])) continue;
        set.add(patch.add[k]);
        changed = true;
      }
    }

    if (!changed) return;
    persist();

    flushing = true;
    try {
      subs.forEach(function (fn) {
        try { fn(state); }
        catch (err) { console.error('[store] 订阅回调出错', err); }
      });
    } finally {
      flushing = false;
    }
  }

  /* ============================================================
     4) 角落提示条
     ------------------------------------------------------------
     绝不用模态遮罩 —— 遮罩会把"提示"变成"拦截"，打断阅读。
     ============================================================ */
  let toastHost = null;

  function toast(text, opts) {
    opts = opts || {};
    const duration = opts.duration || 3200;

    if (!toastHost || !document.body.contains(toastHost)) {
      toastHost = document.getElementById('toast-stack');
      if (!toastHost) {
        toastHost = createEl('div', { id: 'toast-stack', class: 'toast-stack' });
        document.body.appendChild(toastHost);
      }
    }

    const el = createEl('div', { class: 'toast', role: 'status', 'aria-live': 'polite' }, [
      createEl('span', { text: text })
    ]);
    toastHost.appendChild(el);

    function remove() {
      el.classList.add('toast--out');
      let done = false;
      const finish = () => { if (!done) { done = true; el.remove(); } };
      el.addEventListener('animationend', finish, { once: true });
      setTimeout(finish, 400);   // reduced-motion 下 animationend 不会来
    }

    const timer = setTimeout(remove, duration);
    el.addEventListener('click', function () { clearTimeout(timer); remove(); });
    return remove;
  }

  /* ============================================================
     导出到命名空间
     ============================================================ */
  R.util = {
    $, $$, rafThrottle, debounce, clamp, docTop, createEl,
    prefersReducedMotion, isWide, supports, copyText, announce
  };
  R.store = {
    getState, setState, subscribe, toast,
    local: makeStorage('localStorage'),
    session: makeStorage('sessionStorage')
  };

})(window.Resume);

/* ============================================================
   main.js — 装配入口
   ------------------------------------------------------------
   两条全局铁律，写在最前面：

   1) 每个模块单独 try/catch。
      任何一个模块出错，其余模块照常工作。

   2) 只有全部装配完成，才给 <html> 加 .js-ready。
      这个类是"动效增强层"的总开关：在它出现之前，CSS 保证所有
      内容是可见的静态形态；出现之后，才允许把初始态藏起来交给动画。
      一旦有未捕获错误，立刻撤掉它 —— 页面整体退回"全可见"。
   ============================================================ */

(function (R) {
  'use strict';

  const U = R.util;
  const $ = U.$;
  const $$ = U.$$;
  const root = document.documentElement;

  /* ------------------------------------------------------------
     全局兜底：任何未捕获错误 -> 撤销增强态 -> 退回静态全可见
     ------------------------------------------------------------ */
  function degrade() {
    if (!root.classList.contains('js-ready')) return;
    root.classList.remove('js-ready');
    console.warn('[resume] 运行期出错，已退回静态展示，以保证内容完整可读');
  }
  window.addEventListener('error', degrade);
  window.addEventListener('unhandledrejection', degrade);

  /* ------------------------------------------------------------
     精简模式（三条通路共用 .mode-plain 类）
       1) prefers-reduced-motion —— 自动，CSS 层就完成
       2) ?plain=1               —— 自动
       3) 右上角按钮              —— 手动，本次会话内有效
     ------------------------------------------------------------ */
  const PLAIN_KEY = 'resume.v2.plain';

  function initModeToggle() {
    const btn = $('#mode-toggle');
    if (!btn) return;

    const plain = R.config.PLAIN || R.store.local.get(PLAIN_KEY) === '1';

    function apply(on, persist) {
      root.classList.toggle('mode-plain', on);
      btn.setAttribute('aria-pressed', String(on));
      btn.textContent = on ? '恢复动效' : '精简模式 · 只看内容';
      if (persist) {
        // ★ 只写 sessionStorage，不写 localStorage。
        //   HR 误点一下不该让动效永久消失 —— 这份简历的卖点就是动效。
        //   刷新还在，关掉标签页就忘掉。
        R.store.session.set(PLAIN_KEY, on ? '1' : '0');
        U.announce(on ? '已切换到精简模式' : '已恢复动效');
        setTimeout(function () { R.sections.init(); }, 0);
      }
    }

    if (plain) apply(true, false);

    btn.addEventListener('click', function () {
      apply(!root.classList.contains('mode-plain'), true);
    });
  }

  /* ------------------------------------------------------------
     一键复制联系方式
     ------------------------------------------------------------ */
  function initCopy() {
    const items = $$('[data-copy]');
    if (!items.length) return;

    items.forEach(function (btn) {
      btn.addEventListener('click', function () {
        const value = btn.dataset.copy;
        if (!value) return;
        const label = btn.dataset.copyLabel || '内容';

        U.copyText(value).then(function (ok) {
          if (ok) {
            R.store.toast('已复制' + label + '：' + value);
            U.announce(label + '已复制到剪贴板');
            R.store.setState({ copied: true });
            btn.classList.add('is-copied');
            setTimeout(function () { btn.classList.remove('is-copied'); }, 1200);
          } else {
            // 最后的退路：把文本选中，让用户自己按 Ctrl+C / 长按复制
            R.store.toast('复制失败，请手动复制：' + value, { duration: 6000 });
            const target = btn.querySelector('.contact-item__value');
            if (target && window.getSelection) {
              const range = document.createRange();
              range.selectNodeContents(target);
              const sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
            }
          }
        });
      });
    });
  }

  /* ------------------------------------------------------------
     逐模块装配
     ------------------------------------------------------------ */
  const instances = [];

  function boot(name, factory) {
    try {
      const inst = factory();
      if (inst) instances.push(inst);
    } catch (err) {
      console.error('[resume] 模块「' + name + '」初始化失败，已跳过：', err);
    }
  }

  boot('modeToggle', function () { initModeToggle(); return null; });
  boot('sections',   function () { return R.sections.init(); });
  boot('avatar',     function () { return R.avatar.init(); });
  boot('panels',     function () { return R.panels.init(); });
  boot('gallery',    function () { return R.gallery.init(); });
  boot('copy',       function () { initCopy(); return null; });

  /* ------------------------------------------------------------
     标记 JS 就绪 —— 必须是最后一步
     ------------------------------------------------------------ */
  requestAnimationFrame(function () {
    root.classList.add('js-ready');
    if (R.config.DEBUG) {
      console.info('[resume] debug 模式。Resume.debug.batch([...]) 可批量测问答。');
    }
  });

  /* ------------------------------------------------------------
     调试出口
     ------------------------------------------------------------ */
  window.Resume.app = {
    instances: instances,
    getState: R.store.getState,
    setState: R.store.setState
  };

})(window.Resume);

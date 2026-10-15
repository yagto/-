/* ============================================================
   panels.js — 浮动面板的点击放大
   ------------------------------------------------------------
   服务两组面板：
     「关于我」   四块（擅长的事 / 当前能力 / 自我评价 / 做事方式）
     「我能做什么」两块（专业领域 / 拓展技能）

   ★ 这个文件刻意做得很薄：方向、缩放、位移全部写在 CSS 里
     （见 layout.css 的 .panels 段），这里只负责切两个类名：
        .panels.is-focused   有块被选中
        .panel.is-focus      被选中的是这一块

   为什么这么分：
     方向和手感是要反复调的，放在 CSS 里改一个数就能试；
     而"谁被选中"是状态，必须由 JS 管。两者混在一起，
     以后想调动画就得改 JS，很容易碰坏逻辑。

   ★ 两组面板各自独立：一组展开不影响另一组。
     但它们都在 document 上挂监听 —— 所以点「我能做什么」那块时，
     「关于我」的监听会看到"点在自己地盘外"，顺手把它自己收起来。
     这正是想要的效果：翻页回来不会留着一块展开的。
   ============================================================ */

(function (R) {
  'use strict';

  /** 给一个 .panels 容器接线，返回它的控制器 */
  function wire(host) {
    const panels = Array.prototype.slice.call(host.querySelectorAll('.panel'));
    if (!panels.length) return null;

    let focused = null;

    function focus(panel) {
      focused = panel;
      host.classList.add('is-focused');
      panels.forEach(function (p) {
        const on = (p === panel);
        p.classList.toggle('is-focus', on);
        p.setAttribute('aria-pressed', String(on));
      });
    }

    function clear() {
      focused = null;
      host.classList.remove('is-focused');
      panels.forEach(function (p) {
        p.classList.remove('is-focus');
        p.setAttribute('aria-pressed', 'false');
      });
    }

    /* 点同一块 = 收回；点另一块 = 换到那一块（方向由 CSS 自动反向） */
    panels.forEach(function (p) {
      p.addEventListener('click', function () {
        if (focused === p) clear();
        else focus(p);
      });
    });

    /* 点面板以外的空白处收回。
       注意：面板自身的 click 会冒泡到这里，所以要放行 host 内部的点击。 */
    document.addEventListener('click', function (e) {
      if (!focused) return;
      if (host.contains(e.target)) return;
      clear();
    });

    /* Esc 收回，并把焦点还回去 —— 键盘用户不能因为一次 Esc 就丢了位置 */
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !focused) return;
      const last = focused;
      clear();
      last.focus();
    });

    return { clear: clear, focus: focus };
  }

  function init() {
    const hosts = Array.prototype.slice.call(document.querySelectorAll('.panels'));
    const out = hosts.map(wire).filter(Boolean);
    return out.length ? out : null;
  }

  R.panels = { init: init };

})(window.Resume);

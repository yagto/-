/* ============================================================
   gallery.js — 项目截图弹层
   ------------------------------------------------------------
   页面上任何带 data-gallery 的元素，点一下打开弹层：
     data-gallery        图片路径，用 | 分隔
     data-gallery-title  弹层标题（可选）

   ★ 渐进增强：那些元素在 HTML 里写成 <a href="第一张图">，
     所以没有 JS 的时候它就是个普通链接 —— 点开能看到原图。
     这个文件跑起来之后，才把点击接管成弹层。
     这是全站的第一条硬约束「关掉 JS 仍是一份完整可读的简历」的落地方式。

   ★ 关闭方式四种：✕ / 点背景 / Esc / 点面板空白处。
   ★ 打开时焦点移到关闭按钮，关闭时还回原来那个按钮 ——
     不然键盘用户会掉到页面底部（WCAG 2.4.3）。
   ============================================================ */

(function (R) {
  'use strict';

  const U = R.util;

  function init() {
    const el = document.getElementById('gallery');
    if (!el) return null;

    const panel = el.querySelector('.gallery__panel');
    const listEl = el.querySelector('.gallery__list');
    const titleEl = el.querySelector('.gallery__title');
    const closeBtn = el.querySelector('.gallery__close');
    const triggers = U.$$('[data-gallery]');
    if (!triggers.length) return null;

    let opener = null;

    function open(srcs, title, from) {
      opener = from || null;
      titleEl.textContent = title || '截图';

      listEl.innerHTML = '';
      srcs.forEach(function (src) {
        listEl.appendChild(U.createEl('img', {
          class: 'gallery__img',
          src: src,
          alt: (title || '截图') + '（' + src.split('/').pop() + '）'
        }));
      });

      el.hidden = false;
      // 锁住背景滚动 —— 分屏吸附下不锁的话，弹层滚到底会带着整页一起动
      document.documentElement.classList.add('gallery-open');
      // 先 hidden=false 再加类，过渡才会跑
      requestAnimationFrame(function () { el.classList.add('is-on'); });
      if (closeBtn) closeBtn.focus();
    }

    function close() {
      if (el.hidden) return;
      el.classList.remove('is-on');
      document.documentElement.classList.remove('gallery-open');
      setTimeout(function () {
        if (el.classList.contains('is-on')) return;   // 期间又被打开了，别拆台
        el.hidden = true;
        listEl.innerHTML = '';                        // 卸掉 img，别让解码后的位图一直占内存
        if (opener && opener.focus) opener.focus();
      }, 200);
    }

    triggers.forEach(function (t) {
      t.addEventListener('click', function (e) {
        const srcs = (t.getAttribute('data-gallery') || '')
          .split('|').map(function (s) { return s.trim(); }).filter(Boolean);
        // 没配清单就放它走 —— 让它当普通链接跳转，总比什么都不发生强
        if (!srcs.length) return;
        e.preventDefault();
        open(srcs, t.getAttribute('data-gallery-title'), t);
      });
    });

    el.addEventListener('click', function (e) {
      const t = e.target;
      if (t.hasAttribute && t.hasAttribute('data-gallery-close')) close();
      else if (t === panel) close();     // 点面板空白（不是图）也关
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !el.hidden) close();
    });

    return { open: open, close: close };
  }

  R.gallery = { init: init };

})(window.Resume);

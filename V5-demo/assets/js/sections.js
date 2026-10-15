/* ============================================================
   sections.js — 分屏吸附 / 当前屏追踪 / 进度条 / 圆点 / 溢出守卫
                 + 景深式转场（上滑进入下一页）
   ------------------------------------------------------------
   这两件事共用同一个滚动循环，所以放在一个文件里。
   ============================================================ */

(function (R) {
  'use strict';

  const U = R.util;
  const $ = U.$, $$ = U.$$;
  const root = document.documentElement;

  /* ============================================================
     景深式转场
     ------------------------------------------------------------
     效果：上滑时上一屏收进后景（略缩、淡出、上移），
           下一屏从下方升到前景。

     ★ 两个正确性细节，改的时候别踩：

     1) 位置必须用 docTop() - scrollY 算，不能用 getBoundingClientRect()。
        rect 返回的是「变换之后」的矩形 —— 一边读它一边写 transform
        会形成反馈回路，页面会自己漂移。docTop 是布局位置，不受
        transform 影响，而 transform 也不改变布局，所以只需 resize 时测一次。

     2) 只在吸附真正生效时才启用。若因内容超高挂了 .snap-off，
        必须立刻撤销所有变换 —— 否则用户滚到一半停下，
        会看到一屏半透明的、读不清的内容。
     ============================================================ */
  const ENTER = { scaleFrom: 0.97, scaleTo: 1,     opacityFrom: 0.5, opacityTo: 1, yFrom: 40, yTo: 0 };
  const LEAVE = { scaleFrom: 1,    scaleTo: 0.94,  opacityFrom: 1,   opacityTo: 0, yFrom: 0,  yTo: -32 };

  const lerp = (a, b, p) => a + (b - a) * p;

  function initDepthTransition(sections) {
    let layoutTops = [];
    let enabled = false;
    let rafId = 0;

    function shouldEnable() {
      return !root.classList.contains('mode-plain') &&
             !root.classList.contains('snap-off') &&
             !U.prefersReducedMotion() &&
             U.isWide(768);
    }

    const measure = () => { layoutTops = sections.map(U.docTop); };

    function clear() {
      sections.forEach(function (s) {
        s.style.transform = '';
        s.style.opacity = '';
      });
    }

    function apply() {
      rafId = 0;
      if (!enabled) return;

      const vh = window.innerHeight || 1;
      const scrollY = window.scrollY;

      for (let i = 0; i < sections.length; i++) {
        // 1 = 刚好在视口下沿，0 = 顶到视口上沿，-1 = 已完全滚出上方
        const d = (layoutTops[i] - scrollY) / vh;

        let t;
        if (d >= 0) {
          const p = 1 - U.clamp(d, 0, 1);      // 进入段
          t = {
            scale: lerp(ENTER.scaleFrom, ENTER.scaleTo, p),
            opacity: lerp(ENTER.opacityFrom, ENTER.opacityTo, p),
            y: lerp(ENTER.yFrom, ENTER.yTo, p)
          };
        } else {
          const p = U.clamp(-d, 0, 1);          // 离开段
          t = {
            scale: lerp(LEAVE.scaleFrom, LEAVE.scaleTo, p),
            opacity: lerp(LEAVE.opacityFrom, LEAVE.opacityTo, p),
            y: lerp(LEAVE.yFrom, LEAVE.yTo, p)
          };
        }

        sections[i].style.transform =
          'translate3d(0,' + t.y.toFixed(2) + 'px,0) scale(' + t.scale.toFixed(3) + ')';
        sections[i].style.opacity = t.opacity.toFixed(3);
      }
    }

    function schedule() {
      if (!rafId) rafId = requestAnimationFrame(apply);
    }

    function syncEnabled() {
      const next = shouldEnable();
      if (next === enabled) return false;
      enabled = next;
      if (!enabled) {
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
        clear();
      } else {
        measure();
        schedule();
      }
      return true;
    }

    const onResize = U.debounce(function () {
      measure();
      syncEnabled();
      schedule();
    }, 150);

    window.addEventListener('scroll', function () { if (enabled) schedule(); }, { passive: true });
    window.addEventListener('resize', onResize);

    // 溢出守卫可能随时挂上/摘掉 .snap-off，要立刻响应
    if ('MutationObserver' in window) {
      const mo = new MutationObserver(function () {
        if (syncEnabled()) onResize();
      });
      mo.observe(root, { attributes: true, attributeFilter: ['class'] });
    }

    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(onResize).catch(function () {});
    }

    measure();
    syncEnabled();

    return { refresh: onResize };
  }

  /* ============================================================
     分屏控制
     ============================================================ */
  function initSections() {
    const sections = $$('.section');
    if (!sections.length) return { goTo: function () {} };

    const bar = $('.progress__bar');
    const progressHost = $('.progress');
    const dotsHost = $('.snap-dots');

    let dots = [];
    let activeIndex = -1;
    let io = null;

    /* ------------------------------------------------------------
       溢出守卫 —— 最高优先级的一道保险
       ------------------------------------------------------------
       任何一屏的内容高于视口时，mandatory 吸附会让用户永远滚不到它底部。
       CSS 媒体查询判断不了"内容是否真的放得下"，必须实测高度。

       宽屏和手机的处理刻意不同：

         宽屏 —— 只要有一屏超高，就整站关掉吸附。
                 宽屏上一屏内容超高通常是意外（窗口被压扁、缩放 150%），
                 这时退回普通长滚动最稳。

         手机 —— 不整站关。改成逐屏判定：
                   装得下 → 打个 .is-fits，交给 CSS 垂直居中
                   装不下 → 什么都不做，CSS 那边它是固定高 + overflow:auto，
                            屏内可以上下滑
                 手机是指望"一屏一页"的主力场景，
                 因为其中几屏偏高就把吸附整个关掉，正是之前
                 "上下页拼成一张长图"的原因。
       ------------------------------------------------------------ */
    /** 缩放下限。再小字就看不清了，宁可让那一屏退回屏内滚动。 */
    const MIN_SCALE = 0.7;

    /** 量一屏的自然内容高（不含 section 的上下留白） */
    function contentHeight(s) {
      const inner = s.querySelector('.section__inner') || s;
      // ★ 不能用 s.scrollHeight：section 自己是固定高 + overflow:auto 的滚动
      //   容器，挂上 .is-fits 后又变回 overflow:visible，那个值会飘。
      //   量内部内容才稳；而且 transform 不影响布局，反复测量不会打架。
      return Math.max(inner.offsetHeight, inner.scrollHeight);
    }

    function guardOverflow() {
      const vh = window.innerHeight;
      const narrow = !U.isWide(768);

      if (!narrow) {
        /* ---------- 宽屏：保持原来的做法 ---------- */
        sections.forEach(function (s) {
          s.classList.remove('is-fits', 'is-scaled', 'is-tall');
        });
        root.style.removeProperty('--sec-zoom');
        const tooTall = sections.some(s => s.scrollHeight > vh + 8);
        root.classList.toggle('snap-off', tooTall);
        return;
      }

      /* ---------- 手机：统一缩放 ----------
       * 手机屏窄，内容会被拉得很高。
       * 各屏各缩各的，会让翻页时字号忽大忽小，所以所有屏共用一个系数：
       * 取"让最高的那屏刚好装下"所需的最小值。
       *
       * ★ 缩放要么全上，要么全不上 —— 这是踩出来的。
       *   早先的写法是"缩完能装下才给它上缩放"，于是最高那一屏被排除在外：
       *   别的屏都缩到 0.7，只有它还是 100%，翻到那儿就是明显大一号，
       *   看着像"漏了一屏没缩"。现在所有屏共用同一个变换。
       *
       * ★ 系数兜底在 MIN_SCALE。个别屏即便缩到下限仍装不下的，
       *   打上 .is-tall：保留缩放（字号仍和别屏一致），但允许它屏内滚动 ——
       *   不这么做的话，多出来的那几像素会被裁掉。
       */
      root.classList.remove('snap-off');

      const cs = getComputedStyle(sections[0]);
      const padTotal = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      const avail = vh - padTotal;

      const needs = sections.map(contentHeight);
      let scale = 1;
      needs.forEach(function (need) {
        if (need > 0) scale = Math.min(scale, avail / need);
      });
      scale = Math.max(MIN_SCALE, Math.min(1, scale));

      root.style.setProperty('--sec-zoom', String(scale));
      const scaling = scale < 0.995;

      sections.forEach(function (s, i) {
        const gap = avail - needs[i] * (scaling ? scale : 1);
        s.classList.toggle('is-scaled', scaling);
        s.classList.toggle('is-tall', gap < -8);   // 缩了还是装不下
        s.classList.toggle('is-fits', !scaling && gap >= -8);
      });
    }

    /* ---------------- 章节圆点 ---------------- */
    function buildDots() {
      if (!dotsHost) return;
      dotsHost.innerHTML = '';
      dots = sections.map(function (sec, i) {
        const label = sec.dataset.label ||
          (sec.querySelector('h2') ? sec.querySelector('h2').textContent.trim() : '') ||
          ('第 ' + (i + 1) + ' 屏');
        const dot = U.createEl('button', {
          class: 'snap-dot', type: 'button',
          'aria-label': '跳到：' + label,
          'aria-current': 'false',
          title: label
        });
        dot.addEventListener('click', function () { goTo(i); });
        dotsHost.appendChild(dot);
        return dot;
      });
    }

    /* ---------------- 当前屏 ---------------- */
    function setActive(index) {
      if (index < 0 || index === activeIndex) return;
      activeIndex = index;
      dots.forEach((d, i) => d.setAttribute('aria-current', String(i === activeIndex)));
      sections.forEach((s, i) => s.classList.toggle('is-active', i === activeIndex));
      const id = sections[index].id;
      if (id) R.store.setState({ activeSection: id, add: { visited: id } });
    }

    function initObserver() {
      if (U.supports.io()) {
        io = new IntersectionObserver(function (entries) {
          entries.forEach(function (e) {
            if (e.isIntersecting) setActive(sections.indexOf(e.target));
          });
        }, { rootMargin: '-45% 0px -45% 0px', threshold: 0 });
        sections.forEach(s => io.observe(s));
        return;
      }
      // 降级：退回滚动计算
      const onScroll = U.rafThrottle(function () {
        const mid = window.scrollY + window.innerHeight / 2;
        let best = 0, bestDist = Infinity;
        sections.forEach(function (s, i) {
          const d = Math.abs(U.docTop(s) + s.offsetHeight / 2 - mid);
          if (d < bestDist) { bestDist = d; best = i; }
        });
        setActive(best);
      });
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }

    /* ---------------- 进度条 ---------------- */
    const updateProgress = U.rafThrottle(function () {
      if (!bar) return;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const p = max > 0 ? U.clamp(window.scrollY / max, 0, 1) : 0;
      bar.style.transform = 'scaleX(' + p.toFixed(4) + ')';
      if (progressHost) {
        progressHost.setAttribute('role', 'progressbar');
        progressHost.setAttribute('aria-valuemin', '0');
        progressHost.setAttribute('aria-valuemax', '100');
        progressHost.setAttribute('aria-valuenow', String(Math.round(p * 100)));
        progressHost.setAttribute('aria-label', '阅读进度');
      }
    });

    /* ---------------- 跳屏 ----------------
       mandatory 吸附下直接 scrollTo({behavior:'smooth'}) 会被中途
       重新吸附，出现"弹一下又回去"。所以跳转前临时挂起吸附。 */
    function goTo(index, opts) {
      opts = opts || {};
      const target = sections[index];
      if (!target) return;

      const top = U.docTop(target);
      const animate = opts.smooth !== false && !U.prefersReducedMotion();

      // ★ 必须用 'instant'，不能用 'auto'。
      //   'auto' 的含义是"交给 CSS 的 scroll-behavior 决定" —— 而我们在
      //   base.css 里设了 scroll-behavior: smooth，于是本该瞬间跳的地方
      //   会变成动画。只有 'instant' 才是真的立刻到位。
      if (!animate) { window.scrollTo({ top: top, behavior: 'instant' }); return; }

      root.classList.add('snap-suspend');
      window.scrollTo({ top: top, behavior: 'smooth' });

      let done = false;
      function finish() {
        if (done) return;
        done = true;
        root.classList.remove('snap-suspend');
        window.removeEventListener('scrollend', finish);
      }
      if ('onscrollend' in window) {
        window.addEventListener('scrollend', finish, { once: true });
        setTimeout(finish, 900);
      } else {
        setTimeout(finish, 700);
      }
    }

    /* ---------------- 键盘焦点跨屏 ----------------
       按 Tab 定位到下一屏的元素时，浏览器的滚动会被吸附覆盖，
       焦点跑到屏幕外，用户看不见自己在哪（WCAG 2.4.7）。
       解决：焦点落到非当前屏时，先挂起吸附，把该屏滚进来，再恢复。 */
    function onFocusIn(e) {
      const sec = e.target && e.target.closest ? e.target.closest('.section') : null;
      if (!sec) return;
      const i = sections.indexOf(sec);
      if (i === -1 || i === activeIndex) return;
      root.classList.add('snap-suspend');
      sec.scrollIntoView({ block: 'start', behavior: 'instant' });
      setActive(i);
      requestAnimationFrame(function () { root.classList.remove('snap-suspend'); });
    }

    /* ---------------- hash 深链 ----------------
       吸附挂在 html 上（而不是包裹 div）的好处：
       #skills 深链、Ctrl+F 定位、前进后退的滚动还原全部原生可用。 */
    function syncHash() {
      const sec = sections[activeIndex];
      if (!sec || !sec.id) return;
      history.replaceState(null, '', '#' + sec.id);
    }

    function handleInitialHash() {
      const id = location.hash.slice(1);
      if (!id) return;
      const i = sections.findIndex(s => s.id === id);
      if (i > 0) {
        requestAnimationFrame(function () {
          // 首屏带 hash 打开时应当直接落到那一屏，不要从顶部滚过去
          window.scrollTo({ top: U.docTop(sections[i]), behavior: 'instant' });
          setActive(i);
        });
      }
    }

    /* ---------------- 装配 ---------------- */
    buildDots();
    guardOverflow();
    initObserver();
    handleInitialHash();

    window.addEventListener('scroll', updateProgress, { passive: true });
    updateProgress();

    const onResize = U.debounce(function () { guardOverflow(); updateProgress(); }, 150);
    window.addEventListener('resize', onResize);
    document.addEventListener('focusin', onFocusIn);

    let hashTimer = 0;
    window.addEventListener('scroll', function () {
      clearTimeout(hashTimer);
      hashTimer = setTimeout(syncHash, 260);
    }, { passive: true });

    if ('ResizeObserver' in window) {
      const ro = new ResizeObserver(U.debounce(function () {
        guardOverflow(); updateProgress();
      }, 200));
      sections.forEach(s => ro.observe(s));
    }

    /* ★ 图片加载完必须重量一次。
       section 的高度被钉死在 100dvh，所以「内部变高了」这件事
       ResizeObserver 是看不见的（它盯的是 section 自己的尺寸）。
       二维码图在手机上有 108px 高，图没加载完时算出来的系数会偏大，
       结果就是最高那一屏永远差几像素装不下。 */
    window.addEventListener('load', onResize);
    $$('img').forEach(function (img) {
      if (!img.complete) img.addEventListener('load', onResize, { once: true });
    });

    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        guardOverflow(); updateProgress();
      }).catch(function () {});
    }

    // 内容里的揭示动画
    initReveal();

    // 景深转场（依赖上面的 .snap-off 判定，所以放最后）
    initDepthTransition(sections);

    return {
      goTo: goTo,
      refresh: function () { guardOverflow(); updateProgress(); }
    };
  }

  /* ============================================================
     入场动画 + 关键数字滚动
     ------------------------------------------------------------
     ★ HTML 里写的是数字的终值。这里才把它归零再滚上去。
       如果 JS 挂了、或归零后动画没跑起来，用户看到的仍是终值。
     ============================================================ */
  function initReveal() {
    const items = $$('.reveal');
    const counters = $$('[data-count-to]');

    function runCounter(el) {
      if (el.dataset.countPending !== 'true') return;
      el.dataset.countPending = 'false';

      const to = Number(el.dataset.countTo);
      const final = el.dataset.countFinal || String(to);

      if (U.prefersReducedMotion() || !to) { el.textContent = final; return; }

      const DURATION = 800;
      const start = performance.now();
      const ease = t => 1 - Math.pow(1 - t, 3);

      function frame(now) {
        const t = Math.min((now - start) / DURATION, 1);
        el.textContent = String(Math.round(ease(t) * to));
        if (t < 1) requestAnimationFrame(frame);
        else el.textContent = final;   // 收尾一定回到原始文案
      }
      requestAnimationFrame(frame);
    }

    if (!U.supports.io()) {
      items.forEach(el => el.classList.add('is-visible'));
      counters.forEach(function (el) {
        el.textContent = el.dataset.countFinal || el.textContent;
      });
      return;
    }

    // 先把数字归零（终值已存在 dataset 里）
    counters.forEach(function (el) {
      el.dataset.countFinal = el.textContent.trim();
      el.textContent = '0';
      el.dataset.countPending = 'true';
    });

    const io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add('is-visible');
        if (e.target.hasAttribute('data-count-to')) runCounter(e.target);
        const inner = e.target.querySelectorAll('[data-count-to]');
        Array.prototype.forEach.call(inner, runCounter);
        io.unobserve(e.target);
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.12 });

    counters.forEach(el => io.observe(el));
    items.forEach(el => io.observe(el));

    // 首屏不该等滚动才出现
    const first = document.getElementById('identity');
    if (first) {
      Array.prototype.forEach.call(first.querySelectorAll('.reveal'), function (el) {
        el.classList.add('is-visible');
      });
    }
  }

  R.sections = { init: initSections };

})(window.Resume);

/* ============================================================
   avatar.js — AI 分身：悬浮球 + 半屏面板 + 消息流
   ------------------------------------------------------------
   行为约束：
     · 不主动说话
     · 不自动弹出
     · 没有任何待机动画（V1 那个浮动 + 呼吸光点是 AI 味的来源之一）

   ★ UI 层只调 gateway.ask()，它返回 Promise。
     今天答案来自本地问答库；将来换成 Serverless 的真模型，
     这个文件一行都不用改。
   ============================================================ */

(function (R) {
  'use strict';

  const U = R.util;
  const $ = U.$;

  function init() {
    const ball = document.getElementById('avatar-ball');
    const panel = document.getElementById('avatar-panel');
    const log = document.getElementById('chat-log');
    const form = document.getElementById('chat-form');
    const input = document.getElementById('chat-input');
    const closeBtn = document.getElementById('avatar-close');
    const openBtns = document.querySelectorAll('[data-open-avatar]');

    if (!ball || !panel || !log) return null;

    const QA = R.QA;
    const gateway = R.ai.createGateway(R.ai.buildIndex(QA));

    let isOpen = false;
    let greeted = false;
    let busy = false;

    /* ---------------- 消息 ---------------- */
    function addMessage(text, kind) {
      const el = U.createEl('div', {
        class: 'chat-msg chat-msg--' + (kind || 'bot'),
        text: text
      });
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
      return el;
    }

    /* ---------------- 过渡与流式输出 ----------------
       一次问答分三段：正在理解问题 → 正在生成回答 → 回答逐字流出。

       ★ 本地匹配是瞬时的（不到 1 毫秒），这里的等待是刻意加的。两个理由：
         · 一问一答立刻蹦出结果，反而不像在跟"人"说话；
         · 将来接上真模型，这两段等待是真实存在的 ——
           现在把状态机搭好，到时候只换实现、不动界面。
       ------------------------------------------------------------ */
    const PHASE_THINK = '小分身正在理解问题...';
    const PHASE_WRITE = '小分身正在生成回答...';
    const THINK_MS = 320;       // 第一阶段停留多久
    const MIN_TOTAL_MS = 720;   // 两阶段合计的最短时长，防止一闪而过
    const CHARS_PER_SEC = 52;   // 流式输出速度（字/秒）

    const wait = ms => new Promise(r => setTimeout(r, ms));

    function addPending(text) {
      const el = U.createEl('div', {
        class: 'chat-msg chat-msg--bot chat-msg--pending',
        role: 'status',
        'aria-live': 'polite'
      }, [
        U.createEl('span', { class: 'dots', 'aria-hidden': 'true' }, [
          U.createEl('i'), U.createEl('i'), U.createEl('i')
        ]),
        U.createEl('span', { class: 'pending__text', text: text || '' })
      ]);
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
      return el;
    }

    function setPendingText(el, text) {
      const t = el.querySelector('.pending__text');
      if (t) t.textContent = text;
      log.scrollTop = log.scrollHeight;
    }

    /** 把文字逐字打进气泡。返回 Promise，打完才 resolve。 */
    function streamInto(el, text) {
      return new Promise(function (resolve) {
        // 精简模式 / 系统开了"减少动态效果"：直接全量显示，不做逐字
        if (U.prefersReducedMotion() || !text) {
          el.textContent = text || '';
          resolve();
          return;
        }
        const started = performance.now();
        el.classList.add('is-streaming');

        requestAnimationFrame(function tick(now) {
          const n = Math.min(text.length,
            Math.floor((now - started) / 1000 * CHARS_PER_SEC));
          el.textContent = text.slice(0, n);
          log.scrollTop = log.scrollHeight;

          if (n < text.length) {
            requestAnimationFrame(tick);
          } else {
            el.textContent = text;        // 收尾一定是全文，不留半截
            el.classList.remove('is-streaming');
            resolve();
          }
        });
      });
    }

    /* ---------------- 示例问题 ----------------
       原先聊天区底部有一排可点的快捷问题按钮，现在去掉了 ——
       它在手机上占一整行，把聊天区挤得很紧。
       改成把两三个示例直接写进问候语：不占额外空间，
       但 HR 依然知道能问什么。示例取自 qa.js 的 quickQuestions，
       想换就在那边改。 */
    function sampleQuestions(n) {
      return (QA.quickQuestions || []).slice(0, n)
        .map(function (q) { return '「' + String(q).replace(/[?？]\s*$/, '') + '」'; })
        .join('');
    }

    /* ---------------- 提问主流程 ----------------
       命中或没命中都走同一套过渡，不做分支 ——
       否则答不上来时会"瞬间回一句"，反而显得敷衍。
       ------------------------------------------------------------ */
    function ask(question) {
      const q = String(question || '').trim();
      if (!q || busy) return;

      busy = true;
      addMessage(q, 'user');
      if (input) input.value = '';
      R.store.setState({ qa: { open: R.store.getState().qa.open, used: true } });

      const pending = addPending(PHASE_THINK);

      (async function reply() {
        const reduced = U.prefersReducedMotion();
        const started = performance.now();

        // 第一段：理解问题
        setPendingText(pending, PHASE_THINK);
        await wait(reduced ? 0 : THINK_MS);

        // 第二段：生成回答
        setPendingText(pending, PHASE_WRITE);
        let result;
        try {
          result = await gateway.ask(q, { section: R.store.getState().activeSection });
        } catch (e) {
          // gateway 内部已吞掉所有预期错误；能到这里说明出了意料之外的问题
          result = { text: QA.fallback, hit: false };
        }

        // 本地匹配太快，"正在生成"会一闪而过，这里兜一个最短显示时长
        const floor = reduced ? 0 : MIN_TOTAL_MS;
        const elapsed = performance.now() - started;
        if (elapsed < floor) await wait(floor - elapsed);

        // 第三段：逐字流出
        pending.remove();
        const bubble = addMessage('', 'bot');
        await streamInto(bubble, result.text);

        // 没命中就只给兜底句 —— 兜底句本身已经写了"您可以尝试询问本人呢"
        U.announce(result.hit ? '小分身已回答' : '小分身没有找到答案');
        busy = false;
      })();
    }

    /* ---------------- 开合 ---------------- */
    function open() {
      if (isOpen) return;
      isOpen = true;
      panel.dataset.open = 'true';
      panel.removeAttribute('inert');
      ball.setAttribute('aria-expanded', 'true');

      if (!greeted) {
        greeted = true;
        addMessage('你好，我是他的小分身。关于他的任何问题都可以问我 —— 比如 ' +
                   sampleQuestions(3) + '。');
      }

      R.store.setState({ qa: { open: true, used: R.store.getState().qa.used } });
      setTimeout(function () { if (input) input.focus(); }, 220);
    }

    function close() {
      if (!isOpen) return;
      isOpen = false;
      panel.dataset.open = 'false';
      // 收起后把面板从可达树里摘掉，
      // 否则读屏用户按 Tab 会走进一个看不见的面板
      panel.setAttribute('inert', '');
      ball.setAttribute('aria-expanded', 'false');
      R.store.setState({ qa: { open: false, used: R.store.getState().qa.used } });
      ball.focus();
    }

    /* ---------------- 事件 ---------------- */
    ball.addEventListener('click', function () { isOpen ? close() : open(); });
    ball.setAttribute('aria-controls', 'avatar-panel');
    ball.setAttribute('aria-expanded', 'false');

    if (closeBtn) closeBtn.addEventListener('click', close);
    Array.prototype.forEach.call(openBtns, function (b) {
      b.addEventListener('click', open);
    });

    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        ask(input ? input.value : '');
      });
    }

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen) close();
    });

    panel.setAttribute('inert', '');

    /* ---------------- 调试入口 ---------------- */
    if (R.config.DEBUG) {
      window.__ask = ask;
      window.__gateway = gateway;
      console.info('[debug] 可用：__ask("问题") 单条；Resume.debug.batch([...]) 批量回归');
    }

    return { ask: ask, open: open, close: close, gateway: gateway };
  }

  R.avatar = { init: init };

})(window.Resume);

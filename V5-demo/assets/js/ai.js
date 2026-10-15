/* ============================================================
   ai.js — 本地问答匹配 + 未来接 Serverless 的网关
   ------------------------------------------------------------
   设计取向（重要）：宁可兜底，不可答错。

   如果 HR 说「前端我不太想做」，而分身回了一段热情洋溢的
   "我为什么想做前端"，那一瞬间这个页面的可信度就没了。
   所以有四道保险，见下面各处注释。

   ★ 这个文件现在有两个身份：
     1～5 节是**本地问答库的匹配器** —— 只在模型不可用时才上场（安全网）；
     第 6 节是**网关** —— 页面所有提问的唯一入口，它负责决定问谁。
   ============================================================ */

(function (R) {
  'use strict';

  /* ============================================================
     1) 归一化
     ============================================================ */
  function normalize(input) {
    return String(input || '')
      // 全角 → 半角
      .replace(/[！-～]/g, function (c) {
        return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
      })
      .replace(/　/g, ' ')
      .toLowerCase()
      // 标点 → 空格。不能直接删成空串，
      // 否则「前端，为什么」会被粘成一个不存在的词。
      .replace(/[，。、！？；：""''《》【】（）,.!?;:'"()[\]{}·~—\-_/\\|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* ============================================================
     2) 否定词检测（词级）
     只看词的前面一两个字符。用于「不喜欢X」这种前置否定。
     ============================================================ */
  const NEGATIONS = { '不': 1, '没': 1, '别': 1, '无': 1, '非': 1, '未': 1, '莫': 1 };

  function isNegated(text, term) {
    const i = text.indexOf(term);
    if (i < 0) return false;
    const c1 = text[i - 1];
    const c2 = text[i - 2];
    if (c1 && NEGATIONS[c1]) return true;
    if (c1 && c2 && NEGATIONS[c2]) return true;
    return false;
  }

  /* ============================================================
     3) 负面意图检测（整句级）★
     ------------------------------------------------------------
     中文的否定经常跟在宾语后面：「前端我不太想做」
     词级检测只看词的前面，抓不到这种。

     一旦整句表达了"不感兴趣/不想做"，就直接兜底 ——
     与其热情介绍一件对方明确说不想做的事，不如承认没把握。
     ============================================================ */
  const NEGATIVE_INTENT = [
    /不(太|很|怎么|再|怎么太)?(想做|做|要|喜欢|感|考虑|选|投|学|擅长|适合)/,
    /(没|无|不)[^，。！？]{0,3}(兴趣|意向|想法|打算)/,
    /(讨厌|反感|不喜欢|不愿意|不考虑|不打算|不想)/
  ];

  // 「会不会」「想不想」是 A-not-A 疑问句式，不是负面意图
  const ANOT_A = /会不会|想不想|做不做|喜不喜欢|算不算|是不是|要不要|能不能|去不去/;
  // 「为什么…不…」是在问理由，不是表达偏好
  const ASKING_WHY = /为什么|为何|咋不|怎么不/;

  function hasNegativeIntent(text) {
    if (ANOT_A.test(text)) return false;
    if (ASKING_WHY.test(text)) return false;
    return NEGATIVE_INTENT.some(re => re.test(text));
  }

  /* ============================================================
     4) 加权打分
     长词更值钱：「毕业设计」(4字) 应当比「设计」更有分量
     ============================================================ */
  const termWeight = t => 1 + Math.log(t.length);

  function scoreEntry(entry, text) {
    const kw = entry.keywords || {};
    const must = kw.must || [];
    const any = kw.any || [];
    const boost = kw.boost || [];

    // 硬门槛一：must 里有一个不命中，直接淘汰
    if (must.length && !must.every(t => text.indexOf(t) >= 0)) return 0;

    // 硬门槛二：exclude 里命中任意一个，直接淘汰
    // 用来挡"话题对但问的不是这件事"的情况。
    // 例：internship 要挡掉「能实习多久」—— 那句里的"实习"是问得到岗时间，
    // 不是问实习经历，用别处的答案去答就是答非所问。
    const exclude = entry.exclude || [];
    if (exclude.some(t => text.indexOf(t) >= 0)) return 0;

    let score = 0;
    let anyHit = false;
    let boostHit = false;
    let aliasHit = false;

    any.forEach(function (t) {
      if (text.indexOf(t) >= 0 && !isNegated(text, t)) {
        score += 1.4 * termWeight(t);
        anyHit = true;
      }
    });
    boost.forEach(function (t) {
      if (text.indexOf(t) >= 0 && !isNegated(text, t)) {
        score += 0.6 * termWeight(t);
        boostHit = true;
      }
    });
    (entry.aliases || []).forEach(function (a) {
      if (text.indexOf(normalize(a)) >= 0) { score += 2.2; aliasHit = true; }
    });

    /* ★ 硬门槛三：至少命中一个「话题词」或「别名」。
       不能只靠 boost 词达标 —— boost 是"什么/哪里/怎么"这类通用词，
       几乎每句话都有。少了这道闸，「你们公司在哪里」会被
       internship 抢走（那句里连"实习"两个字都没有）。 */
    if (!anyHit && !aliasHit) return 0;

    /* requireBoost —— 光命中话题词还不够，必须同时有"意图词"。
       例：「前端」是很多问题的共同背景，
       「你会前端框架吗」「前端我不太想做」都会命中它，
       但只有「为什么想做前端」才该答 why-frontend。 */
    if (entry.requireBoost && !boostHit && !aliasHit) return 0;

    return score * (entry.weight || 1);
  }

  /* ============================================================
     5) 阈值 + 歧义拒答
     ============================================================ */
  const THRESHOLD = 2.2;   // 低于此分 = 未命中
  const MARGIN = 1.25;     // 第一名 / 第二名 < 该倍数 = 歧义，拒答

  function buildIndex(qa) {
    return {
      fallback: qa.fallback,
      entries: qa.entries.map(function (e) {
        return Object.assign({}, e);
      })
    };
  }

  const round = n => Math.round(n * 100) / 100;

  function matchQA(index, rawQuestion) {
    const text = normalize(rawQuestion);

    if (hasNegativeIntent(text)) {
      return { hit: false, reason: 'negative_intent', debug: { text: text } };
    }

    let best = null, second = null;

    index.entries.forEach(function (entry) {
      const s = scoreEntry(entry, text);
      if (s <= 0) return;
      if (!best || s > best.score) { second = best; best = { entry: entry, score: s }; }
      else if (!second || s > second.score) { second = { entry: entry, score: s }; }
    });

    const debug = {
      text: text,
      best: best ? { id: best.entry.id, score: round(best.score) } : null,
      second: second ? { id: second.entry.id, score: round(second.score) } : null
    };

    if (!best || best.score < THRESHOLD) {
      debug.reason = 'below_threshold';
      return { hit: false, reason: 'below_threshold', debug: debug };
    }
    if (second && second.score * MARGIN > best.score) {
      // 「歧义即兜底」—— 自动实现了"难以回答的问题返回兜底句"，
      // 不需要人工列举哪些问题算"难答"。
      debug.reason = 'ambiguous';
      return { hit: false, reason: 'ambiguous', debug: debug };
    }

    return {
      hit: true, id: best.entry.id, answer: best.entry.answer,
      score: round(best.score), debug: debug
    };
  }

  /* ============================================================
     6) 网关 —— UI 层唯一的入口
     ------------------------------------------------------------
     契约固定，实现可换：
         ask(question, ctx) -> Promise<{ source, text, hit }>

     顺序（2026-10-15 起）：先问真模型，不行才用本地库。

       config.AI.KEY 填了         → 走 DeepSeek
       没填 / 超时 / 报错 / 超额   → 回落到本地问答库
       本地库也没命中              → 兜底句

     ★ 为什么还用本地库？
       它是安全网。API 欠费、网络不通、模型改版，页面都还能接话，
       不会变成一个点不开的按钮。

     ★ 为什么从第一天就写成异步？
       本地匹配是同步的，真模型是异步的。
       当初要是把答案当同步字符串直插 DOM，现在整个消息流都得重写。

     ★ 密钥为什么在前端？
       静态站点没有服务端，这是唯一的选择，代价是密钥公开可见。
       见 config.js 里的说明。
     ============================================================ */
  function createGateway(index) {
    const cfg = (R.config && R.config.AI) || {};
    const endpoint = cfg.ENDPOINT;
    const key = cfg.KEY;
    const model = cfg.MODEL || 'deepseek-flash';
    const timeout = cfg.TIMEOUT_MS || 10000;
    const cap = cfg.MAX_PER_SESSION || 30;
    const maxChars = cfg.MAX_QUESTION_CHARS || 200;
    const prompt = (R.persona && R.persona.SYSTEM_PROMPT) || '';

    // 每次打开页面重新计数。挡的是手滑连点和死循环，不是真人。
    let used = 0;

    const remoteReady = !!(endpoint && key && prompt);

    /** 本地问答库；没命中就给兜底句 */
    function local(question) {
      const m = matchQA(index, question);
      return m.hit
        ? { source: 'local', text: m.answer, hit: true, debug: m.debug }
        : { source: 'local', text: index.fallback, hit: false, debug: m.debug };
    }

    /** 问真模型。任何失败都 resolve(null)，绝不 reject —— 由上层决定怎么退。 */
    function remote(question) {
      const controller = new AbortController();
      const timer = setTimeout(function () { controller.abort(); }, timeout);
      const done = function () { clearTimeout(timer); };

      return fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + key
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: String(question).slice(0, maxChars) }
          ],
          // 这个模型的思考模式默认是开的，且 effort 默认 high。
          // 回答"他是谁"这种问题用不上推理链，开着又慢又贵 —— 关掉。
          thinking: { type: 'disabled' },
          stream: false
        }),
        signal: controller.signal
      })
        .then(function (res) {
          done();
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function (data) {
          const msg = data && data.choices && data.choices[0] && data.choices[0].message;
          const text = String((msg && msg.content) || '').trim();
          if (!text) throw new Error('空回答');
          return text;
        })
        .catch(function (err) {
          done();
          // 静默回落，但 debug 模式下要能看见原因 ——
          // 不然"AI 没生效"这件事在页面上完全没有痕迹。
          if (R.config && R.config.DEBUG) {
            console.warn('[ai] 模型不可用，回落到本地库：', err && err.message);
          }
          return null;
        });
    }

    return {
      ask: function (question, ctx) {
        ctx = ctx || {};
        if (!remoteReady || used >= cap) return Promise.resolve(local(question));
        used++;
        return remote(question).then(function (text) {
          if (text) return { source: 'ai', text: text, hit: true };
          return local(question);
        });
      },

      /** 调试用：这次打开还剩几句 AI 额度 */
      remaining: function () { return remoteReady ? Math.max(0, cap - used) : 0; }
    };
  }

  R.ai = {
    normalize: normalize,
    matchQA: matchQA,
    buildIndex: buildIndex,
    createGateway: createGateway
  };

  /* ============================================================
     7) 调参入口（网址加 ?debug=1 后可用）
     ------------------------------------------------------------
     没有这个，阈值 2.2 和歧义倍数 1.25 只能靠猜。
     ============================================================ */
  R.debug = {
    /**
     * 测**本地问答库**（不联网、不花 token）。
     * 改完 qa.js 就跑这个 —— 它只看匹配器，不看模型。
     */
    batch: function (list) {
      const index = R.ai.buildIndex(R.QA);
      const rows = list.map(function (q) {
        const r = matchQA(index, q);
        return {
          '问': q,
          '命中': r.hit ? 'HIT' : 'MISS',
          '条目': r.debug && r.debug.best ? r.debug.best.id : '-',
          '分数': r.debug && r.debug.best ? r.debug.best.score : '-',
          '原因': r.debug && r.debug.reason ? r.debug.reason : 'ok'
        };
      });
      console.table(rows);
      return rows;
    },

    /**
     * 真问一次 AI，看它答得怎么样。**会花 token**，别拿来批量刷。
     * 想知道走的是模型还是本地库，看返回的 source。
     */
    ask: function (q) {
      const gw = R.ai.createGateway(R.ai.buildIndex(R.QA));
      console.info('[debug] 剩余 AI 额度：' + gw.remaining() + ' 句');
      return gw.ask(q, {}).then(function (r) {
        console.log('%csource = ' + r.source, 'font-weight:bold');
        console.log(r.text);
        return r;
      });
    }
  };

})(window.Resume);

// ============================================================================
// 遥控器切换模型 —— 客户端插件（全局 bundle 版，浏览器端）
// ----------------------------------------------------------------------------
// 从 .agent-presets/remote-model-switch 迁移而来。改这个文件后：
//   重启 DSH + 刷新页面即生效（本文件无需 pnpm install）。
// 逻辑与动态插件版一致：🎮 按钮 + 组合键 -> 模型/思考强度 映射。
// ============================================================================
window.__ModuleLoader__.load({
  id: "dsh-remote-model-switch",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
    var React = require("react")

    var inject = ['slots']

    // 诊断通道：把客户端状态 POST 给宿主落盘（$DSH_HOME/.rms-diag.ndjson）
    function report(stage, info) {
      try {
        fetch('/remote-model-switch/diag', {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: JSON.stringify(Object.assign({ stage: stage }, info || {})),
        }).catch(function () {})
      } catch (e) {}
    }
    report('module-loaded')

    function apply(ctx) {
      report('apply-entered')
      // 服务用 ctx.get 无注入读取（缺失不 park fiber）
      function get(name) { try { return ctx.get(name) } catch (e) { return undefined } }

    // ── 运行时服务（惰性获取） ───────────────────────────────────────────
    function remoteSession() {
      try {
        return get('remote.session') || (ctx.remote && ctx.remote.session) || null
      } catch (e) {
        return null
      }
    }
    function currentSessionId() {
      let s
      try { s = get('sessions') || ctx.sessions } catch (e) { s = undefined }
      if (!s || !s.list) return undefined
      const snap = s.list.getSnapshot()
      return snap && snap.current
    }

    // ── 极小的外部 store：内部状态变化时让所有占用者重渲染 ────────────────
    const listeners = new Set()
    let version = 0
    function subscribe(fn) { listeners.add(fn); return function () { listeners.delete(fn) } }
    function getVersion() { return version }
    function redraw() { version++; for (const fn of [...listeners]) { try { fn() } catch (e) {} } }

    // ── 状态 ────────────────────────────────────────────────────────────────
    // mappings: 组合键字符串 -> { key, ctrl, alt, shift, meta, provider, model, reasoningEffort }
    const mappings = {}
    let catalog = null        // 模型目录缓存
    let flash = null          // 面板内联状态文字 { text, kind }
    let learnResolve = null   // 正在录入按键（Promise resolver）
    let pendingCombo = null   // 录入到的组合键
    let pendingKey = null     // 组合键字符串
    let pickerFor = null      // '' = 主面板；'<key>' = 正在为哪个组合键选模型
    let effortFor = null      // 正在为哪个组合键选思考强度
    let nextId = 1            // 自增 id（React key 用）
    let panelOpen = false     // 主面板/子面板是否打开
    let btnRef = null         // 🎮 按钮 DOM 引用（面板定位）
    let lastKeySeen = ''      // 监听中实时显示的按键
    let firstKeydownSeen = false

    // ── 小工具 ──────────────────────────────────────────────────────────────
    function comboString(c) {
      const parts = []
      if (c.ctrl) parts.push('Ctrl')
      if (c.alt) parts.push('Alt')
      if (c.shift) parts.push('Shift')
      if (c.meta) parts.push('Meta')
      parts.push(String(c.key).toUpperCase())
      return parts.join('+')
    }
    function effortName(modelId, effortId) {
      if (!catalog) return effortId
      for (const g of catalog.groups || []) {
        for (const m of g.models || []) {
          if (m.id === modelId) {
            const e = ((m.reasoning && m.reasoning.efforts) || []).find((x) => x.id === effortId)
            return e ? e.name : effortId
          }
        }
      }
      return effortId
    }
    function mappingLine(m) {
      let s = m.model || '未选模型'
      if (m.provider) s = `${m.provider}/${s}`
      if (m.reasoningEffort) s += `（${effortName(m.model, m.reasoningEffort)}）`
      return `${comboString(m)} → ${s}`
    }
    function flatModels() {
      return (catalog && catalog.groups || []).reduce((acc, g) => acc.concat(g.models || []), [])
    }
    function later(fn, ms) {
      const id = window.setTimeout(fn, ms)
      return () => window.clearTimeout(id)
    }
    // 状态文字只存进面板内联显示，不再弹浮动提示
    function setFlash(text, kind) {
      flash = { text, kind: kind || 'info' }
      redraw()
    }

    // ── 模型目录（首选官方 modelDirectories 服务，回退 remote.session） ────
    function directories() {
      try {
        const d = get('modelDirectories')
        return d && typeof d.directoryFor === 'function' ? d : null
      } catch (e) { return null }
    }
    function directoryInstance() {
      const d = directories()
      const sid = currentSessionId()
      if (!d || !sid) return null
      try {
        const inst = d.directoryFor(sid)
        if (inst && typeof inst.select === 'function') return inst
      } catch (e) {
        report('directoryFor-failed', { err: String((e && e.message) || e) })
      }
      return null
    }
    function catalogFromSnapshot(snap) {
      if (!snap || !Array.isArray(snap.groups)) return null
      return {
        groups: snap.groups.map((g) => ({
          models: (g.models || []).map((m) => ({ id: m.id, name: m.name || m.id, provider: g.id, reasoning: m.reasoning })),
        })),
        default: snap.current ? { provider: snap.current.provider } : null,
      }
    }
    let dirSubscribed = null
    async function refreshCatalog() {
      const inst = directoryInstance()
      if (inst) {
        if (inst.store && typeof inst.store.subscribe === 'function' && dirSubscribed !== inst) {
          dirSubscribed = inst
          try {
            inst.store.subscribe(() => {
              const c = catalogFromSnapshot(inst.store.getSnapshot())
              if (c) { catalog = c; if (panelOpen) redraw() }
            })
          } catch (e) {}
        }
        try { await inst.load() } catch (e) { report('catalog-load-failed', { err: String((e && e.message) || e) }) }
        const c = catalogFromSnapshot(inst.store && typeof inst.store.getSnapshot === 'function' ? inst.store.getSnapshot() : null)
        if (c) {
          catalog = c
          setFlash('模型列表已刷新（' + flatModels().length + ' 个）', 'ok')
          redraw()
          return
        }
      }
      const rs = remoteSession()
      report('catalog-fallback', { dirs: !!directories(), remote: !!rs, sid: currentSessionId() })
      if (!rs) { setFlash('模型服务不可用', 'error'); return }
      try {
        catalog = await rs.modelCatalog()
        setFlash('模型列表已刷新', 'ok')
      } catch (e) {
        setFlash('刷新失败：' + String((e && e.message) || e), 'error')
      }
    }

    // ── 切换模型 ─────────────────────────────────────────────────────────────
    async function switchTo(m) {
      const sid = currentSessionId()
      report('switch-attempt', { provider: m.provider, model: m.model, effort: m.reasoningEffort, sid: sid })
      const inst = directoryInstance()
      if (inst && m.provider) {
        try {
          const sel = { provider: m.provider, model: m.model }
          if (m.reasoningEffort) sel.reasoningEffort = m.reasoningEffort
          await inst.select(sel)
          closePanel()
          setFlash('已切换：' + m.model, 'ok')
          report('switch-ok', { via: 'directories', model: m.model })
          return
        } catch (e) {
          report('switch-directory-failed', { err: String((e && e.message) || e) })
        }
      }
      const rs = remoteSession()
      if (rs && sid) {
        try {
          const payload = { sessionId: sid, provider: m.provider, model: m.model }
          if (m.reasoningEffort) payload.reasoningEffort = m.reasoningEffort
          await rs.selectModel(payload)
          closePanel()
          setFlash('已切换：' + m.model, 'ok')
          report('switch-ok', { via: 'remote.session', model: m.model })
        } catch (e) {
          setFlash('切换失败：' + String((e && e.message) || e), 'error')
        }
      } else {
        setFlash('模型服务不可用', 'error')
      }
    }

    // ── 按键处理（捕获阶段挂 window，专注输入时也能触发） ─────────────────
    function onKey(e) {
      if (!e || !e.key) return
      if (!firstKeydownSeen) { firstKeydownSeen = true; report('first-keydown', { key: e.key }) }

      // 录入模式：采集第一个非修饰键（实时显示收到的按键）
      if (learnResolve) {
        report('keydown-any', { key: e.key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey })
        if (e.key !== lastKeySeen) { lastKeySeen = e.key; redraw() }
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation()
          cancelLearn('已取消录入')
          return
        }
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return
        e.preventDefault(); e.stopPropagation()
        const combo = { key: e.key.toLowerCase(), ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey }
        report('learn-captured', { combo: comboString(combo) })
        const resolve = learnResolve
        learnResolve = null
        resolve(combo)
        return
      }

      // 正常模式：查映射
      const combo = { key: e.key.toLowerCase(), ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey }
      const m = mappings[comboString(combo)]
      if (!m) return
      e.preventDefault(); e.stopPropagation()
      switchTo(m)
    }

    // ── 录入按键（面板不关闭，在面板内显示监听状态） ──────────────────────
    function beginLearn() {
      if (learnResolve) return
      pendingCombo = null
      pendingKey = null
      effortFor = null
      pickerFor = 'learn'
      panelOpen = true
      lastKeySeen = ''
      redraw()
      new Promise((resolve) => { learnResolve = resolve })
        .then((combo) => {
          if (!combo) { pickerFor = ''; redraw(); return }
          const key = comboString(combo)
          if (mappings[key]) { setFlash(`组合键 ${key} 已存在，先删除再重录`, 'error'); pickerFor = ''; redraw(); return }
          pendingCombo = combo
          pendingKey = key
          pickerFor = key
          effortFor = null
          redraw()
          setFlash(`已采集 ${key}，请选择要切换的模型…`, 'ok')
        })
    }
    function cancelLearn(msg) {
      if (!learnResolve) return
      const resolve = learnResolve
      learnResolve = null
      if (msg) setFlash(msg, 'info')
      resolve(null)
    }

    // ── 面板控制 ─────────────────────────────────────────────────────────────
    function closePanel() {
      cancelLearn()
      panelOpen = false
      pickerFor = null
      effortFor = null
      destroyPanelCloser()
      redraw()
    }
    function destroyPanelCloser() {
      if (!panelCloser) return
      try { panelCloser() } catch (e) {}
      panelCloser = null
    }
    function togglePanel() {
      if (learnResolve) { cancelLearn('已取消录入'); return }
      if (panelOpen) { closePanel(); return }
      if (!catalog) refreshCatalog()
      pickerFor = ''
      effortFor = null
      panelOpen = true
      redraw()
      // 点击面板外 / Esc / 窗口缩放 关闭
      const onDocDown = (e) => {
        if (e.target && e.target.closest && e.target.closest('.rms-panel, .rms-btn')) return
        closePanel()
      }
      const onDocKey = (e) => { if (e.key === 'Escape' && !learnResolve) closePanel() }
      const onResize = () => redraw()
      document.addEventListener('pointerdown', onDocDown, true)
      document.addEventListener('keydown', onDocKey, true)
      window.addEventListener('resize', onResize)
      panelCloser = () => {
        document.removeEventListener('pointerdown', onDocDown, true)
        document.removeEventListener('keydown', onDocKey, true)
        window.removeEventListener('resize', onResize)
      }
    }

    // ── 渲染 ─────────────────────────────────────────────────────────────────
    function h() {
      const args = Array.prototype.slice.call(arguments)
      return React.createElement.apply(React, [args[0], args[1] || null].concat(args.slice(2)))
    }

    const panelStyle = () => {
      const r = btnRef ? btnRef.getBoundingClientRect() : { left: 8, top: 8, bottom: 8 }
      const left = Math.max(8, Math.min(r.left, window.innerWidth - 352))
      // 向上弹出：按钮在屏幕底部的输入行，面板锚定在按钮上沿
      const bottom = Math.max(8, window.innerHeight - r.top + 8)
      return {
        position: 'fixed',
        left, bottom,
        width: 336,
        maxHeight: Math.max(160, r.top - 24),
        overflowY: 'auto',
        background: '#ffffff',
        color: '#111111',
        borderRadius: 12,
        boxShadow: '0 8px 30px rgba(0,0,0,.18)',
        border: '1px solid rgba(0,0,0,.08)',
        padding: 12,
        fontSize: 13,
        zIndex: 2147483000,
        boxSizing: 'border-box',
      }
    }
    const btn = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 8, border: '1px solid rgba(0,0,0,.12)', background: '#f5f5f5', cursor: 'pointer', fontSize: 13, color: '#111' }
    const row = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 0', borderBottom: '1px solid rgba(0,0,0,.06)' }
    const small = { border: 'none', background: 'transparent', color: '#3b82f6', cursor: 'pointer', fontSize: 12, padding: '2px 4px' }
    const danger = { border: 'none', background: 'transparent', color: '#dc2626', cursor: 'pointer', fontSize: 12, padding: '2px 4px' }

    function setEffort(effortId) {
      const key = effortFor
      if (!key || !mappings[key]) return
      mappings[key].reasoningEffort = effortId || undefined
      const m = mappings[key]
      setFlash(`已设置：${comboString(m)} → ${m.model}${m.reasoningEffort ? '（' + effortName(m.model, m.reasoningEffort) + '）' : ''}`, 'ok')
      pickerFor = null
      effortFor = null
      panelOpen = false
      destroyPanelCloser()
      redraw()
    }

    function Panel() {
      const closeBtn = h('button', { style: Object.assign({}, btn, { position: 'absolute', top: 8, right: 8, padding: '2px 6px' }), onClick: () => closePanel() }, '✕')

      // 思考强度选择器
      if (effortFor && mappings[effortFor]) {
        const m = mappings[effortFor]
        const model = flatModels().find((x) => x.id === m.model)
        const efforts = (model && model.reasoning && model.reasoning.efforts) || []
        return h('div', { className: 'rms-panel', style: panelStyle() }, [
          closeBtn,
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, `思考强度 · ${m.model}`),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
            h('button', { style: btn, onClick: () => setEffort(undefined) }, '默认'),
            efforts.map((e) => h('button', { key: e.id, style: btn, onClick: () => setEffort(e.id) }, e.name)),
          ),
        ])
      }

      // 录入监听视图（面板保持打开）
      if (pickerFor === 'learn') {
        return h('div', { className: 'rms-panel', style: panelStyle() }, [
          closeBtn,
          h('div', { style: { fontWeight: 600, marginBottom: 8, color: '#2563eb' } }, '● 正在监听…'),
          h('div', { style: { color: '#555', lineHeight: 1.7 } }, '按遥控器上要用到的按键（建议 F13–F24 或 Ctrl/Alt 组合）。'),
          h('div', { style: { margin: '8px 0', padding: '8px 10px', borderRadius: 8, background: lastKeySeen ? '#eff6ff' : '#f5f5f5', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 } },
            lastKeySeen
              ? h('span', null, ['已收到按键：', h('b', { style: { marginLeft: 4 } }, lastKeySeen)])
              : h('span', { style: { color: '#999' } }, '尚未收到任何按键…（先随便按一个键试试）')),
          h('div', { style: { marginTop: 4 } },
            h('button', { style: btn, onClick: () => cancelLearn('已取消录入') }, '取消（Esc）')),
        ])
      }

      // 模型选择器
      if (pickerFor && pickerFor !== '') {
        const isNew = pendingKey === pickerFor
        const title = isNew ? `为 ${pickerFor} 选择模型` : `更换 ${pickerFor} 的模型`
        return h('div', { className: 'rms-panel', style: panelStyle() }, [
          closeBtn,
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, title),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
            flatModels().map((m) => h('button', {
              key: m.id, style: btn,
              onClick: () => {
                if (isNew) {
                  mappings[pickerFor] = Object.assign({ _id: nextId++, key: pendingKey }, pendingCombo, { provider: m.provider || (catalog.default && catalog.default.provider), model: m.id })
                  pendingCombo = null
                  pendingKey = null
                } else {
                  mappings[pickerFor].provider = m.provider || (catalog.default && catalog.default.provider)
                  mappings[pickerFor].model = m.id
                  mappings[pickerFor].reasoningEffort = undefined
                }
                effortFor = pickerFor
                redraw()
              },
            }, m.name)),
          ),
        ])
      }

      // 主面板
      const keys = Object.keys(mappings).sort()
      return h('div', { className: 'rms-panel', style: panelStyle() }, [
        closeBtn,
        h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '遥控器切换模型'),
        h('div', { style: { display: 'flex', gap: 6, marginBottom: 10 } },
          h('button', { style: btn, onClick: () => beginLearn() }, '＋ 添加按键映射'),
          h('button', { style: Object.assign({}, btn, { color: '#2563eb' }), onClick: () => refreshCatalog() }, '刷新模型列表'),
        ),
        keys.length === 0
          ? h('div', { style: { color: '#888', padding: '6px 0' } }, '还没有映射。点击“添加按键映射”，然后按遥控器上要用的键（建议 F13–F24 或 Ctrl/Alt 组合）。')
          : keys.map((key) => {
              const m = mappings[key]
              return h('div', { key: key, style: row }, [
                h('div', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, mappingLine(m)),
                h('div', { style: { display: 'flex', gap: 2 } },
                  h('button', { style: small, onClick: () => { pickerFor = key; pendingKey = null; effortFor = null; redraw() } }, '换模型'),
                  m.provider ? h('button', { style: small, onClick: () => { effortFor = key; redraw() } }, '强度') : null,
                  h('button', { style: danger, onClick: () => { delete mappings[key]; if (pickerFor === key) pickerFor = null; if (effortFor === key) effortFor = null; redraw() } }, '删除'),
                ),
              ])
            }),
        h('div', { style: { marginTop: 10, color: flash && flash.kind === 'error' ? '#dc2626' : '#666', fontSize: 12, lineHeight: 1.5 } },
          flash ? flash.text : '映射保存在内存中，刷新页面会清空。'),
      ])
    }

    // ── 🎮 按钮（conversation.input.left）——机械键帽样式 ───────────────────
    const KeyboardIcon = () => h('svg', {
      width: 16, height: 13, viewBox: '0 0 16 13', fill: 'none', 'aria-hidden': true,
    }, [
      h('rect', { key: 'r', x: 0.7, y: 1.5, width: 14.6, height: 10, rx: 1.8, stroke: 'currentColor', strokeWidth: 1.1 }),
      h('path', { key: 'a', d: 'M3 4.4h1.8M6.2 4.4h1.8M9.4 4.4h1.8M12.2 4.4h1', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round' }),
      h('path', { key: 'b', d: 'M3 6.8h1.8M6.2 6.8h1.8M9.4 6.8h3.6', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round' }),
      h('path', { key: 'c', d: 'M5.4 9.2h5.2', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round' }),
    ])
    const RemoteModelSwitchButton = () => {
      React.useSyncExternalStore(subscribe, getVersion)
      return h('button', {
        ref: (el) => { btnRef = el },
        className: 'rms-btn',
        title: '遥控器切换模型',
        onClick: () => togglePanel(),
        style: {
          width: 27, height: 23, borderRadius: 5,
          border: '1px solid rgba(128,128,128,.55)',
          background: 'linear-gradient(180deg, rgba(140,140,140,.24), rgba(140,140,140,.06))',
          boxShadow: panelOpen
            ? 'inset 0 2px 4px rgba(0,0,0,.35)'
            : '0 2px 0 rgba(0,0,0,.30), inset 0 1px 0 rgba(255,255,255,.30)',
          transform: panelOpen ? 'translateY(1px)' : 'none',
          cursor: 'pointer', fontSize: 0,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          padding: 0, color: 'inherit', flexShrink: 0,
          transition: 'transform .08s ease, box-shadow .08s ease',
        },
      }, h(KeyboardIcon))
    }

    // ── 浮层面板（shell.overlay，root 作用域） ──────────────────────────────
    const RemoteModelSwitchPanel = () => {
      React.useSyncExternalStore(subscribe, getVersion)
      if (!panelOpen) return null
      return Panel()
    }

    // ── 挂载 ─────────────────────────────────────────────────────────────────
    // 兼容两种 register 签名：
    //   现代 API: slots.register({ name, id, order }, Component)
    //   旧/动态守卫 API: slots.register(name, { id, order, render })
    const disposes = []
    // bundle 客户端必须先在槽位上 inject 声明占有，再在回调里 register
    function mountSeat(name, id, order, component) {
      try {
        const stop = ctx.slots.inject(name, () => {
          try {
            const d = ctx.slots.register(
              { name, id, order, label: function () { return '遥控器切换模型' } },
              component,
            )
            return typeof d === 'function' ? d : undefined
          } catch (e) {
            report('register-failed', { for: name, err: String((e && e.message) || e) })
            return undefined
          }
        })
        if (typeof stop === 'function') disposes.push(stop)
        report('seat-injected', { for: name })
        return true
      } catch (e) {
        report('inject-failed', { for: name, err: String((e && e.message) || e) })
        return false
      }
    }

    const btnOk = mountSeat('conversation.input.left', 'remote-model-switch', 0, RemoteModelSwitchButton)
    const panelOk = mountSeat('shell.overlay', 'remote-model-switch-panel', 1000, RemoteModelSwitchPanel)
    report('mounted', { btnOk: btnOk, panelOk: panelOk })
    if (!btnOk || !panelOk) return

    window.addEventListener('keydown', onKey, true)

    report('services-probe', { sessions: !!get('sessions'), dirs: !!directories(), remote: !!remoteSession() })
    // 启动时静默拉一次模型目录
    if (!catalog) { try { refreshCatalog() } catch (e) {} }

    ctx.on('dispose', () => {
      window.removeEventListener('keydown', onKey, true)
      destroyPanelCloser()
      for (const d of disposes) { try { d() } catch (e) {} }
      listeners.clear()
    })
  
    }

    function applySafe(ctx) {
      try {
        apply(ctx)
      } catch (e) {
        report('apply-threw', { err: String((e && (e.stack || e.message)) || e) })
      }
    }

    exports.apply = applySafe
    exports.inject = inject
    return module.exports
  },
})

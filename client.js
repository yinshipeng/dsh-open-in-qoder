/**
 * Browser half of dsh-open-in-qoder.
 *
 * Renders one icon button in the conversation header utilities — the top-right
 * row of the conversation window, immediately right of the shipped Open In...
 * split button — and opens the session's workspace directory in Qoder CN IDE.
 *
 * Availability comes from the Host half's `GET /open-in-qoder/status`; the
 * button renders nothing until that answer says the application is installed,
 * so a machine without the IDE sees no dead control. Clicking posts the session
 * `cwd` to `POST /open-in-qoder/open` and reports a refusal through a small
 * transient toast, while a successful desktop handoff stays silent because the
 * IDE window opening is its own confirmation.
 */
window.__ModuleLoader__.load({
  id: 'dsh-open-in-qoder',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace shared by the dictionaries and `props.t`. */
    const NS = 'open-in-qoder'
    /** Right-aligned Session utilities in the conversation header. */
    const SLOT = 'conversation.session.header.utilities'
    /** Immediately right of the shipped Open In... entry, which sits at -10. */
    const ORDER = -9
    /** Host routes owned by the companion Host row. */
    const STATUS_ROUTE = 'open-in-qoder/status'
    const OPEN_ROUTE = 'open-in-qoder/open'
    /** How long a toast stays on screen. */
    const TOAST_MS = 3600
    /** Availability read attempts before the control stays hidden. */
    const STATUS_ATTEMPTS = 3

    /** Simplified Chinese dictionary. */
    const zh = {
      'action.open': '在 {app} 中打开',
      'action.busy': '正在打开 {app}…',
      'toast.opened': '已在 {app} 中打开',
      'toast.failed': '无法在 {app} 中打开，请重试',
      'toast.unreachable': '无法连接 DSH 主机，请重试',
    }

    /** English dictionary. */
    const en = {
      'action.open': 'Open in {app}',
      'action.busy': 'Opening in {app}…',
      'toast.opened': 'Opened in {app}',
      'toast.failed': 'Could not open in {app}. Try again.',
      'toast.unreachable': 'Lost the connection to the DSH Host. Try again.',
    }

    /** Replace `{name}` placeholders in one dictionary string. */
    function format(template, vars) {
      if (typeof template !== 'string') return ''
      if (vars === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, key) => {
        const value = vars[key]
        return value === undefined ? match : String(value)
      })
    }

    /** Local fallback translator, used only when the slot hands no `t`. */
    function fallbackTranslate(key, vars) {
      let language = ''
      try {
        language = document.documentElement.lang ?? ''
      } catch {
        language = ''
      }
      const dict = language.toLowerCase().startsWith('zh') ? zh : en
      return format(dict[key] ?? en[key] ?? key, vars)
    }

    /** Read availability and the configured application label from the Host. */
    async function readStatus() {
      try {
        const response = await fetch(STATUS_ROUTE, {
          headers: { accept: 'application/json' },
          cache: 'no-store',
        })
        if (!response.ok) return null
        const envelope = await response.json()
        const value = envelope?.value
        if (envelope?.ok !== true || value === null || typeof value !== 'object') return null
        if (typeof value.label !== 'string' || value.label === '') return null
        return { available: value.available === true, label: value.label }
      } catch {
        return null
      }
    }

    /**
     * The shared status read. A failed read is not memoized: the Host row may
     * still be starting (a bundle activated moments ago, or a page opened while
     * the Host was applying the row), so the next attempt reads again instead of
     * caching "no application" for the life of the page.
     */
    let statusPromise
    function loadStatus() {
      statusPromise ??= readStatus().then((value) => {
        if (value === null) statusPromise = undefined
        return value
      })
      return statusPromise
    }

    /** Whether this page runs on a coarse-pointer (phone or tablet) device. */
    function isTouchDevice() {
      try {
        return window.matchMedia('(pointer: coarse)').matches
      } catch {
        return false
      }
    }

    /**
     * The header button.
     * @param props - composed entry props; the slot is locale-bound via `t`.
     */
    function OpenInQoder(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackTranslate
      const sessionId = props.sessionId
      const useSessions = props.useSessions
      /** The session's absolute workspace directory. */
      const cwd = typeof useSessions === 'function'
        ? useSessions((state) => state?.byId?.[sessionId]?.cwd)
        : undefined
      /** undefined = still reading, null = no answer from the Host. */
      const [status, setStatus] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)
      /** Transient notice: `{ kind, key, seq }`. */
      const [notice, setNotice] = React.useState(undefined)
      const noticeSeq = React.useRef(0)

      React.useEffect(() => {
        let alive = true
        let timer
        const read = (attempt) => {
          loadStatus().then((value) => {
            if (!alive) return
            if (value === null && attempt + 1 < STATUS_ATTEMPTS) {
              timer = window.setTimeout(() => read(attempt + 1), 700 * (attempt + 1))
              return
            }
            setStatus(value)
          })
        }
        read(0)
        return () => {
          alive = false
          window.clearTimeout(timer)
        }
      }, [])

      React.useEffect(() => {
        if (notice === undefined) return undefined
        const timer = window.setTimeout(() => setNotice(undefined), TOAST_MS)
        return () => window.clearTimeout(timer)
      }, [notice])

      const label = status?.label ?? ''
      const announce = (kind, key) => {
        noticeSeq.current += 1
        setNotice({ kind, key, seq: noticeSeq.current })
      }

      const open = async () => {
        if (busy || typeof cwd !== 'string' || cwd === '') return
        setBusy(true)
        try {
          const response = await fetch(OPEN_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: cwd }),
          })
          if (!response.ok) {
            announce('error', 'toast.failed')
            return
          }
          if (isTouchDevice()) announce('success', 'toast.opened')
        } catch {
          announce('error', 'toast.unreachable')
        } finally {
          setBusy(false)
        }
      }

      // No answer yet, no installed IDE, or no directory to hand over: no control.
      if (status?.available !== true) return null
      if (typeof cwd !== 'string' || cwd === '') return null

      const title = busy ? format(t('action.busy'), { app: label }) : format(t('action.open'), { app: label })

      const toast = notice === undefined ? null : h('div', {
        key: 'toast',
        className: 'qob-toast',
        role: 'status',
        'aria-live': 'polite',
        'data-tone': notice.kind,
      }, h('span', { className: 'qob-toast-text' }, format(t(notice.key), { app: label })))

      return h('div', { className: 'qob-root', 'data-dsh-plugin': 'open-in-qoder' },
        h('style', { key: 'style' }, CSS),
        h('button', {
          key: 'button',
          type: 'button',
          className: 'qob-button',
          'data-busy': busy ? 'true' : undefined,
          title,
          'aria-label': title,
          disabled: busy,
          onClick: open,
        }, ICON),
        toast)
    }

    /**
     * A panel with an arrow leaving its top-right corner: "hand this workspace
     * to another application". Deliberately not a curved arrow, which the host
     * already uses for undo and reply actions.
     */
    const ICON = h('svg', {
      className: 'qob-icon',
      width: 15,
      height: 15,
      viewBox: '0 0 16 16',
      fill: 'none',
      'aria-hidden': true,
    },
    h('path', {
      d: 'M8.9 3.6H4.4a1.7 1.7 0 0 0-1.7 1.7v6.3a1.7 1.7 0 0 0 1.7 1.7h6.3a1.7 1.7 0 0 0 1.7-1.7V7.1',
      stroke: 'currentColor',
      strokeWidth: '1.35',
      strokeLinecap: 'round',
    }),
    h('path', {
      d: 'M9.7 6.3h4.1V2.2',
      stroke: 'currentColor',
      strokeWidth: '1.35',
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
    h('path', {
      d: 'M13.5 2.5 7.6 8.4',
      stroke: 'currentColor',
      strokeWidth: '1.35',
      strokeLinecap: 'round',
    }))

    /** Scoped styles: theme alias tokens only, so light/dark themes follow. */
    const CSS = [
      '.qob-root{display:inline-flex;align-items:center;min-width:0}',
      '.qob-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;',
      'height:24px;width:28px;margin:0;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;',
      'background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;',
      'transition:background-color .12s,border-color .12s,color .12s}',
      '.qob-button:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.qob-button:active{background:var(--dsw-alias-bg-layer-1)}',
      '.qob-button:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-brand-primary)}',
      '.qob-button[data-busy=true]{cursor:default;opacity:.6}',
      '.qob-icon{flex:none;display:block}',
      '.qob-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:2147483000;',
      'box-sizing:border-box;max-width:min(420px,calc(100vw - 32px));padding:9px 14px;border-radius:10px;',
      'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);',
      'color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12.5px;line-height:1.45;',
      'box-shadow:0 8px 24px rgba(0,0,0,.18);pointer-events:none}',
      '.qob-toast[data-tone=error]{border-color:var(--dsw-alias-state-error-primary)}',
      '.qob-toast[data-tone=success]{border-color:var(--dsw-alias-state-success-primary)}',
      '.qob-toast-text{display:block}',
    ].join('')

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'open-in-qoder: dictionaries')
        } catch (error) {
          console.warn('[open-in-qoder] locale registration failed', error)
        }
        ctx.slots.inject(SLOT, () => {
          try {
            return ctx.slots.register({
              name: SLOT,
              id: 'qoder-open',
              order: ORDER,
              locale: NS,
            }, OpenInQoder)
          } catch (error) {
            console.warn('[open-in-qoder] slot registration failed', error)
            return () => {}
          }
        })
      },
    }
  },
})
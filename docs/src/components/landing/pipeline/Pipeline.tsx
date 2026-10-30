import { Check, Cpu, Pause, Play } from 'lucide-react'
import { AnimatePresence, LazyMotion, domAnimation, m } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { analyzers, outputs, scenarios, stages, triggers } from './data.ts'

import './pipeline.css'

/** Phases of one scenario: trigger, wire in, four engine stages, wire to analyzers, analyzers, wires out, outputs. */
const durations = [900, 850, 380, 380, 380, 380, 850, 950, 850, 4300]
const final = durations.length - 1
const total = durations.reduce((sum, d) => sum + d, 0)
const ease = [0.4, 0, 0.2, 1] as const

interface Wire {
  id: string
  d: string
}

interface Geometry {
  width: number
  height: number
  vertical: boolean
  wires: Wire[]
}

interface Point {
  x: number
  y: number
}

const curve = (a: Point, b: Point, vertical: boolean) => {
  if (vertical) {
    const my = (a.y + b.y) / 2
    return `M${a.x} ${a.y}C${a.x} ${my} ${b.x} ${my} ${b.x} ${b.y}`
  }
  const mx = (a.x + b.x) / 2
  return `M${a.x} ${a.y}C${mx} ${a.y} ${mx} ${b.y} ${b.x} ${b.y}`
}

export default function Pipeline() {
  const [reduce, setReduce] = useState(false)
  const [round, setRound] = useState(0)
  const [scenario, setScenario] = useState(0)
  const [phase, setPhase] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [hover, setHover] = useState(false)
  const [inView, setInView] = useState(false)
  const [geometry, setGeometry] = useState<Geometry>()
  const rootRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const nodes = useRef(new Map<string, HTMLElement>())
  const remaining = useRef<{ key: string; ms: number } | undefined>(undefined)

  const current = scenarios[scenario] ?? scenarios[0]
  const running = playing && !hover && inView && !reduce
  const shownPhase = reduce ? final : phase

  const register = (id: string) => (el: HTMLElement | null) => {
    if (el) nodes.current.set(id, el)
    else nodes.current.delete(id)
  }

  const measure = useCallback(() => {
    const stage = stageRef.current
    if (!stage) return
    const box = stage.getBoundingClientRect()
    const rect = (id: string) => {
      const b = nodes.current.get(id)?.getBoundingClientRect()
      if (!b) return undefined
      const l = b.left - box.left
      const t = b.top - box.top
      return { l, t, r: l + b.width, b: t + b.height, cx: l + b.width / 2, cy: t + b.height / 2 }
    }
    const engine = rect('engine')
    const lab = rect('analyzers')
    const inputs = rect('col:triggers')
    const sinks = rect('col:outputs')
    if (!engine || !lab || !inputs || !sinks) return
    const vertical = lab.t >= engine.b - 1
    const wires: Wire[] = []
    if (vertical) {
      wires.push({
        id: 'in',
        d: curve({ x: inputs.cx, y: inputs.b }, { x: engine.cx, y: engine.t }, true),
      })
      wires.push({
        id: 'core',
        d: curve({ x: engine.cx, y: engine.b }, { x: lab.cx, y: lab.t }, true),
      })
      wires.push({
        id: 'out',
        d: curve({ x: lab.cx, y: lab.b }, { x: sinks.cx, y: sinks.t }, true),
      })
    } else {
      for (const t of triggers) {
        const r = rect(t.id)
        if (r)
          wires.push({
            id: `in:${t.id}`,
            d: curve({ x: r.r, y: r.cy }, { x: engine.l, y: engine.cy }, false),
          })
      }
      wires.push({
        id: 'core',
        d: curve({ x: engine.r, y: engine.cy }, { x: lab.l, y: lab.cy }, false),
      })
      for (const o of outputs) {
        const r = rect(o.id)
        if (r)
          wires.push({
            id: `out:${o.id}`,
            d: curve({ x: lab.r, y: lab.cy }, { x: r.l, y: r.cy }, false),
          })
      }
    }
    setGeometry({ width: box.width, height: box.height, vertical, wires })
  }, [])

  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduce(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    measure()
    const observer = new ResizeObserver(measure)
    if (stageRef.current) observer.observe(stageRef.current)
    for (const id of ['engine', 'analyzers', 'col:triggers', 'col:outputs']) {
      const el = nodes.current.get(id)
      if (el) observer.observe(el)
    }
    void document.fonts?.ready.then(measure)
    return () => observer.disconnect()
  }, [measure])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return undefined
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry?.isIntersecting ?? false),
      {
        threshold: 0.25,
      },
    )
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!running) return undefined
    const key = `${round}:${scenario}:${phase}`
    const wait = remaining.current?.key === key ? remaining.current.ms : (durations[phase] ?? 1000)
    const started = performance.now()
    let fired = false
    const timer = setTimeout(() => {
      fired = true
      if (phase < final) setPhase(phase + 1)
      else {
        setScenario((s) => (s + 1) % scenarios.length)
        setPhase(0)
      }
    }, wait)
    return () => {
      clearTimeout(timer)
      if (!fired) remaining.current = { key, ms: Math.max(0, wait - (performance.now() - started)) }
    }
  }, [running, phase, scenario, round])

  const select = (index: number) => {
    setScenario(index)
    setPhase(0)
    setRound((r) => r + 1)
  }

  const hasOutputs = Object.keys(current.results).length > 0
  const wireOn = (id: string) => {
    if (id === 'in') return shownPhase >= 1
    if (id === 'core') return shownPhase >= 6
    if (id === 'out') return hasOutputs && shownPhase >= 8
    if (id.startsWith('in:')) return id === `in:${current.trigger}` && shownPhase >= 1
    return id.startsWith('out:') && id.slice(4) in current.results && shownPhase >= 8
  }
  const travelling = (id: string) =>
    !reduce &&
    wireOn(id) &&
    ((id.startsWith('in') && phase === 1) ||
      (id === 'core' && phase === 6) ||
      (id.startsWith('out') && phase === 8))

  const activeAnalyzers = current.analyzers

  return (
    <LazyMotion features={domAnimation} strict>
      <div
        ref={rootRef}
        className="pl"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <div className="pl-bar">
          <div className="pl-pills" role="tablist" aria-label="Scenarios">
            {scenarios.map((s, i) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={i === scenario}
                className="pl-pill"
                onClick={() => select(i)}
              >
                <span className="pl-pill-index">{String(i + 1).padStart(2, '0')}</span>
                {s.pill}
                {i === scenario && !reduce && (
                  <span
                    key={`${scenario}-${round}`}
                    className="pl-pill-progress"
                    style={{
                      animationDuration: `${total}ms`,
                      animationPlayState: running ? 'running' : 'paused',
                    }}
                  />
                )}
              </button>
            ))}
          </div>
          {!reduce && (
            <button
              type="button"
              className="pl-toggle"
              onClick={() => setPlaying((p) => !p)}
              aria-label={playing ? 'Pause the animation' : 'Play the animation'}
            >
              {playing ? <Pause size={14} /> : <Play size={14} />}
            </button>
          )}
        </div>

        <div ref={stageRef} className="pl-stage">
          {geometry && (
            <svg
              className="pl-wires"
              width={geometry.width}
              height={geometry.height}
              viewBox={`0 0 ${geometry.width} ${geometry.height}`}
              aria-hidden="true"
            >
              {geometry.wires.map((wire) => (
                <g key={wire.id}>
                  <path d={wire.d} className="pl-wire" />
                  {wireOn(wire.id) && (
                    <m.path
                      key={`${scenario}-lit`}
                      d={wire.d}
                      className="pl-wire-lit"
                      initial={{ pathLength: reduce ? 1 : 0 }}
                      animate={{ pathLength: 1 }}
                      transition={{ duration: 0.8, ease }}
                    />
                  )}
                  {travelling(wire.id) && (
                    <m.path
                      key={`${scenario}-${phase}-comet`}
                      d={wire.d}
                      className="pl-comet"
                      initial={{ pathLength: 0.18, pathOffset: 0, opacity: 0 }}
                      animate={{ pathOffset: 0.82, opacity: [0, 1, 1, 0] }}
                      transition={{ duration: 0.85, ease: 'easeInOut' }}
                    />
                  )}
                </g>
              ))}
            </svg>
          )}

          <div className="pl-col" ref={register('col:triggers')}>
            <p className="pl-head">Triggers</p>
            {triggers.map((t) => {
              const on = t.id === current.trigger
              return (
                <div
                  key={t.id}
                  ref={register(t.id)}
                  className="pl-node"
                  data-state={on ? 'on' : 'idle'}
                >
                  <span className="pl-icon">
                    <t.icon size={15} strokeWidth={1.75} />
                  </span>
                  <span className="pl-text">
                    <span className="pl-label">{t.label}</span>
                    <span className="pl-detail">{t.detail}</span>
                  </span>
                  {on && !reduce && <span className="pl-ping" />}
                </div>
              )
            })}
          </div>

          <div className="pl-col">
            <p className="pl-head">Engine</p>
            <div
              ref={register('engine')}
              className="pl-engine"
              data-state={shownPhase >= 2 ? 'on' : 'idle'}
            >
              <div className="pl-engine-top">
                <span className="pl-icon">
                  <Cpu size={15} strokeWidth={1.75} />
                </span>
                <span className="pl-label">holtkeeper serve</span>
                <span className="pl-role">web · worker · scheduler</span>
              </div>
              <ol className="pl-steps">
                {stages.map((s, i) => {
                  const note = current.stages[s.id]
                  const reached = shownPhase >= 2 + i
                  const state = reached ? (note ? 'on' : 'skip') : 'idle'
                  return (
                    <li key={s.id} className="pl-step" data-state={state}>
                      <span className="pl-step-dot">
                        {state === 'on' && <Check size={10} strokeWidth={3} />}
                      </span>
                      <span className="pl-text">
                        <span className="pl-label">
                          <s.icon size={13} strokeWidth={1.75} />
                          {s.label}
                        </span>
                        <span className="pl-detail">
                          {state === 'on' ? note : state === 'skip' ? 'not needed' : s.detail}
                        </span>
                      </span>
                    </li>
                  )
                })}
              </ol>
            </div>
          </div>

          <div className="pl-col">
            <p className="pl-head">Analyzers</p>
            <div
              ref={register('analyzers')}
              className="pl-lab"
              data-state={shownPhase >= 7 ? 'on' : 'idle'}
            >
              {analyzers.map((a) => {
                const order = activeAnalyzers.indexOf(a.id)
                const on = order >= 0 && shownPhase >= 7
                return (
                  <span
                    key={a.id}
                    className="pl-chip"
                    data-state={on ? 'on' : order >= 0 && shownPhase >= 6 ? 'next' : 'idle'}
                    style={{ transitionDelay: on && !reduce ? `${order * 110}ms` : '0ms' }}
                  >
                    <a.icon size={12} strokeWidth={1.75} />
                    {a.id}
                  </span>
                )
              })}
            </div>
          </div>

          <div className="pl-col" ref={register('col:outputs')}>
            <p className="pl-head">Outputs</p>
            {outputs.map((o) => {
              const result = current.results[o.id]
              const on = result !== undefined && shownPhase >= final
              return (
                <div
                  key={o.id}
                  ref={register(o.id)}
                  className="pl-node pl-out"
                  data-state={on ? 'on' : 'idle'}
                >
                  <span className="pl-icon">
                    <o.icon size={15} strokeWidth={1.75} />
                  </span>
                  <span className="pl-text">
                    <span className="pl-label">{o.label}</span>
                    <span className="pl-detail">{on ? result : o.detail}</span>
                  </span>
                  {on && (
                    <span className="pl-ok">
                      <Check size={11} strokeWidth={3} />
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <div className="pl-caption" aria-live="polite">
          <AnimatePresence mode="wait" initial={false}>
            <m.p
              key={current.id}
              initial={reduce ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? undefined : { opacity: 0, y: -6 }}
              transition={{ duration: 0.25, ease }}
            >
              {current.caption}
            </m.p>
          </AnimatePresence>
        </div>
      </div>
    </LazyMotion>
  )
}

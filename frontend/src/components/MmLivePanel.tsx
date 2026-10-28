// @ts-nocheck
import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const POLL_MS = 2000
const money = (v) => typeof v === 'number' && Number.isFinite(v) ? `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}` : '—'
const num = (v, d = 3) => typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—'
const time = (v) => typeof v === 'number' ? new Date(v).toLocaleTimeString() : '—'
const ago = (v, now) => typeof v === 'number' ? `${Math.max(0, Math.round((now - v) / 1000))}s ago` : 'never'
const STATE_TONE = { running: 'default', stale: 'destructive', halted: 'destructive', finished: 'secondary', unknown: 'outline' }

async function getJson(url, signal) {
  const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw Error(body.error || `HTTP ${r.status}`)
  return body
}

function Metrics({ items }) {
  return <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">{items.map(([name, value, hint]) => <div key={name}><dt className="text-xs text-muted-foreground">{name}</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{value}</dd>{hint && <dd className="text-xs text-muted-foreground tabular-nums">{hint}</dd>}</div>)}</dl>
}

/** P&L against the market stop: the bar fills toward the stop as the market loses. */
function StopMeter({ pnl, stop }) {
  if (typeof pnl !== 'number' || !stop) return <span className="text-muted-foreground">—</span>
  const used = Math.min(1, Math.max(0, -pnl / stop))
  return <div className="flex min-w-28 items-center gap-2">
    <span className={`w-14 text-right tabular-nums ${pnl < 0 ? 'text-destructive' : ''}`}>{money(pnl)}</span>
    <div className="h-1.5 flex-1 rounded bg-muted" aria-label={`${Math.round(used * 100)}% of the $${stop} market stop used`}>
      <div className={`h-1.5 rounded ${used > 0.7 ? 'bg-destructive' : 'bg-primary'}`} style={{ width: `${used * 100}%` }} />
    </div>
  </div>
}

function eventText(e) {
  const s = (k) => e[k] ?? ''
  switch (e.type) {
    case 'submit': return `${e.exit ? 'EXIT ' : ''}${s('side')} ${num(e.shares, 2)} @ ${num(e.price)} · ${String(s('tokenId')).slice(0, 8)}…`
    case 'ack': return `acknowledged ${String(s('venueOrderId')).slice(0, 12)}`
    case 'fill': return `${s('side')} ${num(e.shares, 2)} @ ${num(e.price)} (${s('status')})`
    case 'cancel': return `cancelled ${(e.cancelled || []).length}/${(e.ids || []).length}`
    case 'market_stop': return `market stopped at ${money(-e.lossUsd)} · ${String(s('conditionId')).slice(0, 10)}…`
    case 'halt': return `HALT: ${s('reason')}`
    case 'reject': return `rejected: ${s('error')}`
    case 'closed': return `closed ${s('state')}, filled ${num(e.filled, 2)}`
    case 'book_error': return `book error: ${s('error')}`
    default: return Object.entries(e).filter(([k]) => !['at', 'type'].includes(k)).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ').slice(0, 160)
  }
}

export default function MmLivePanel() {
  const [runs, setRuns] = useState(null)
  const [killFile, setKillFile] = useState(null)
  const [selected, setSelected] = useState(null)
  const [run, setRun] = useState(null)
  const [error, setError] = useState(null)
  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let disposed = false, inFlight = false
    const controller = new AbortController()
    const poll = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const list = await getJson('/api/mm/runs', controller.signal)
        if (disposed) return
        setRuns(list.runs); setKillFile(list.killFile); setError(null)
        const id = selected ?? list.runs[0]?.id
        if (id) { const d = await getJson(`/api/mm/runs/${encodeURIComponent(id)}`, controller.signal); if (!disposed) setRun(d.run) }
      } catch (e) { if (!disposed && e.name !== 'AbortError') setError(String(e.message || e)) }
      finally { inFlight = false; if (!disposed) setNow(Date.now()) }
    }
    void poll()
    const timer = setInterval(poll, POLL_MS)
    return () => { disposed = true; clearInterval(timer); controller.abort() }
  }, [selected])

  const status = run?.status
  const live = run?.config?.mode === 'live'
  const up = run && ['running', 'stale'].includes(run.state)
  const markets = useMemo(() => [...(status?.markets || [])].sort((a, b) => (a.pnlUsd ?? 0) - (b.pnlUsd ?? 0)), [status])

  const kill = async () => {
    setBusy(true)
    try { const r = await fetch(`/api/mm/runs/${encodeURIComponent(run.id)}/kill`, { method: 'POST', credentials: 'same-origin' }); const b = await r.json(); if (!r.ok) throw Error(b.error) }
    catch (e) { setError(`Kill request failed: ${e.message || e}`) } finally { setBusy(false) }
  }
  const clearKill = async () => {
    setBusy(true)
    try { const r = await fetch('/api/mm/kill-file/clear', { method: 'POST', credentials: 'same-origin' }); const b = await r.json(); if (!r.ok) throw Error(b.error) }
    catch (e) { setError(`Could not clear the kill file: ${e.message || e}`) } finally { setBusy(false) }
  }

  if (runs && !runs.length) return <Card><CardHeader><CardTitle>MM execution</CardTitle><CardDescription>No runs yet. Start one with <code>npx tsx scripts/mm-live.ts run --budget=200</code>; it appears here within a few seconds.</CardDescription></CardHeader></Card>

  return <section aria-label="MM execution" className="space-y-3">
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3 sm:flex-row">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>MM execution</CardTitle>
            {run && <Badge variant={live ? 'destructive' : 'outline'}>{live ? 'LIVE · real orders' : 'DRY-RUN · nothing sent'}</Badge>}
            {run && <Badge variant={STATE_TONE[run.state]}>{run.state}</Badge>}
            {run?.config?.sides && <Badge variant="outline">{run.config.sides === 'both' ? 'YES + NO bids' : 'YES bid only'}</Badge>}
            {status?.budget && <Badge variant="outline">${status.budget} profile</Badge>}
          </div>
          <CardDescription className="text-pretty">Status {ago(status?.at, now)} · started {time(status?.startedAt)} · {status?.running ? `ends ${time(status?.endsAt)}` : `ended ${time(status?.endedAt)}`} · limits {run?.config?.limitsHash ?? '—'}</CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {runs && <Select value={selected ?? runs[0]?.id} onValueChange={(v) => { setSelected(v); setRun(null) }}>
            <SelectTrigger className="w-72" aria-label="Run"><SelectValue placeholder="Run" /></SelectTrigger>
            <SelectContent>{runs.map((r) => <SelectItem key={r.id} value={r.id}>{r.state === 'running' ? '● ' : ''}{r.id} · {r.mode}</SelectItem>)}</SelectContent>
          </Select>}
          {up && <Dialog>
            <DialogTrigger asChild><Button variant="destructive" disabled={busy}>Kill run</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Kill this MM run?</DialogTitle><DialogDescription>This creates {status?.killFile}. The runner cancels every order{live ? ' on the exchange' : ''}, stops quoting and shuts down. Held shares are kept. The kill file then blocks the next start until it is cleared here.</DialogDescription></DialogHeader>
              <DialogFooter><DialogClose asChild><Button variant="outline">Keep running</Button></DialogClose><DialogClose asChild><Button variant="destructive" onClick={kill}>Kill and cancel all</Button></DialogClose></DialogFooter>
            </DialogContent>
          </Dialog>}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {status && <Metrics items={[
          ['Session P&L', money(status.equityUsd), `cash ${money(status.cashUsd)}`],
          ['Loss room', money(status.lossRoomUsd), `of ${money(status.maxLossUsd)} limit`],
          ['Est. reward / day', money(status.estRewardUsdPerDay), 'estimate, not booked'],
          ['Fills', String(status.fills ?? 0), `${status.placed ?? 0} placed · ${status.cancelled ?? 0} cancelled`],
          ['Markets stopped', String(markets.filter((m) => m.stopped).length), `stop at ${money(-(status.maxMarketLossUsd ?? 0))} each`],
          ['Cycles', String(status.cycles ?? 0), `${status.bookErrors ?? 0} book errors`],
        ]} />}
        {!status && run && <p className="text-sm text-muted-foreground">This run predates live status. Its summary is shown below when present.</p>}
      </CardContent>
    </Card>

    {error && <Alert variant="destructive"><AlertTitle>MM feed problem</AlertTitle><AlertDescription>{error}. The values shown may be out of date.</AlertDescription></Alert>}
    {run?.state === 'stale' && <Alert variant="destructive"><AlertTitle>Runner status is stale</AlertTitle><AlertDescription>The runner process is up but has not written status for {ago(status?.at, now)}. Check the terminal, or kill the run.</AlertDescription></Alert>}
    {status?.halted && status.halted !== 'run_complete' && <Alert variant="destructive"><AlertTitle>Halted: {status.halted}</AlertTitle><AlertDescription>All orders were cancelled and quoting stopped. A person has to restart the runner{status.cleanShutdown === false ? ', and shutdown was not confirmed clean: check the venue for resting orders' : ''}.</AlertDescription></Alert>}
    {killFile?.present && <Alert variant="destructive"><AlertTitle>Kill file present</AlertTitle><AlertDescription className="flex flex-wrap items-center gap-3"><span>{killFile.path} stops any run that starts.</span>{!runs?.some((r) => ['running', 'stale'].includes(r.state)) && <Button size="sm" variant="outline" disabled={busy} onClick={clearKill}>Clear kill file</Button>}</AlertDescription></Alert>}

    {status && <Card>
      <CardHeader><CardTitle>Markets</CardTitle><CardDescription>Worst first. Resting quotes refresh every cycle; a stopped market sells its shares at the best bid and quotes no more today.</CardDescription></CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow><TableHead>Market</TableHead><TableHead className="text-right">YES mid</TableHead><TableHead className="text-right">YES / NO held</TableHead><TableHead>P&L vs stop</TableHead><TableHead>Resting</TableHead><TableHead className="text-right">Reward / day</TableHead><TableHead>State</TableHead></TableRow></TableHeader>
          <TableBody>{markets.map((m) => <TableRow key={m.conditionId}>
            <TableCell className="max-w-72 truncate" title={m.question}>{m.question}</TableCell>
            <TableCell className="text-right tabular-nums">{num(m.yesMid)}</TableCell>
            <TableCell className="text-right tabular-nums">{num(m.yesShares, 1)} / {num(m.noShares, 1)}</TableCell>
            <TableCell><StopMeter pnl={m.pnlUsd} stop={status.maxMarketLossUsd} /></TableCell>
            <TableCell className="text-xs tabular-nums">{m.orders.length ? m.orders.map((o, i) => <div key={i}>{o.exit ? 'EXIT ' : ''}{o.outcome} {o.side} {num(o.shares - o.filled, 0)} @ {num(o.price)}{o.state !== 'open' ? ` (${o.state})` : ''}</div>) : <span className="text-muted-foreground">none</span>}</TableCell>
            <TableCell className="text-right tabular-nums">{money(m.estRewardUsdPerDay)}</TableCell>
            <TableCell>{m.stopped ? <Badge variant="destructive">stopped {money(-m.stopped.lossUsd)}</Badge> : m.orders.length ? <Badge variant="outline">quoting {Math.round(m.quotedPct)}%</Badge> : <Badge variant="secondary">idle</Badge>}</TableCell>
          </TableRow>)}</TableBody>
        </Table>
        {Object.keys(status.reasons || {}).length > 0 && <p className="mt-3 text-xs text-muted-foreground">Planner decisions: {Object.entries(status.reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.replaceAll('_', ' ')} ${v}`).join(' · ')}{Object.keys(run.recentSkips || {}).length ? ` · recent skips: ${Object.entries(run.recentSkips).map(([k, v]) => `${k.replaceAll('_', ' ')} ${v}`).join(', ')}` : ''}</p>}
      </CardContent>
    </Card>}

    {run && <Card>
      <CardHeader><CardTitle>Actions</CardTitle><CardDescription>Orders, fills, cancels, stops and halts from the run's journal, newest first.</CardDescription></CardHeader>
      <CardContent className="max-h-96 overflow-y-auto">
        {run.events.length ? <ol className="space-y-1 font-mono text-xs">{run.events.map((e, i) => <li key={i} className={['halt', 'market_stop', 'reject', 'orphans', 'drift'].includes(e.type) ? 'text-destructive' : e.type === 'fill' ? 'font-semibold' : ''}><span className="text-muted-foreground">{time(e.at)}</span> <span className="inline-block w-24">{e.type}</span> {eventText(e)}</li>)}</ol> : <p className="text-sm text-muted-foreground">No actions yet.</p>}
      </CardContent>
    </Card>}

    {run?.lossLedger && <p className="text-xs text-muted-foreground">Loss ledger ({run.config.mode}): {run.lossLedger.sessions.length} earlier sessions, net {money(run.lossLedger.sessions.reduce((t, x) => t + x.pnlUsd, 0))}. Earlier losses count against this run's loss limit.</p>}
  </section>
}

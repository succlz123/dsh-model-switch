// dsh-model-switch — 宿主半。
// 1) 启动标记：证明本行被宿主挂载（$DSH_HOME/.rms-host-loaded.json）。
// 2) 诊断路由：浏览器半把加载/激活状态 POST 到 /model-switch/diag，
//    宿主落盘到 $DSH_HOME/.rms-diag.ndjson，便于命令行排查。
// 功能全在客户端半（lib/client.js）。

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'model-switch'
export const inject = ['webServer']

const HOME = process.env.DSH_HOME || process.cwd()
const MARKER = join(HOME, '.dms-host-loaded.json')
const DIAG = join(HOME, '.dms-diag.ndjson')

function writeMarker(event, extra) {
  try {
    writeFileSync(MARKER, JSON.stringify({ event, at: new Date().toISOString(), ...extra }, null, 2))
  } catch {}
}

export function apply(ctx) {
  writeMarker('host-apply', { pid: process.pid })
  ctx.effect(() => {
    const post = (req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        try { appendFileSync(DIAG, `[${new Date().toISOString()}] ${body.slice(0, 4000)}\n`) } catch {}
        res.writeHead(204, { 'access-control-allow-origin': '*' })
        res.end()
      })
    }
    const get = (req, res) => {
      let marker = ''
      let diag = ''
      try { marker = readFileSync(MARKER, 'utf8') } catch (e) { marker = String(e) }
      try { diag = readFileSync(DIAG, 'utf8') } catch (e) { diag = String(e) }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
      res.end(`marker:\n${marker}\n\ndiag:\n${diag}`)
    }
    const postRoute = ctx.webServer.register({ kind: 'exact', path: '/model-switch/diag', handler: post })
    const getRoute = ctx.webServer.register({ kind: 'exact', path: '/model-switch/state', handler: get })
    return () => { postRoute(); getRoute() }
  }, 'dsh-model-switch: diag routes')
}

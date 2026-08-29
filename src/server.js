// podcast-together 自建后端
// 与官方 laf 云函数(room-operate / web-socket / parse-text / room-clock / pt-service)协议完全一致
// 单进程:HTTP + WebSocket + 内存房间表(带 JSON 落盘),无需 laf、无需数据库
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { WebSocketServer } from "ws"
import * as cheerio from "cheerio"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.PORT || 3000)
// 访问口令:设置后所有接口和 WebSocket 消息都必须带上 x-pt-token 字段(留空则不校验)
const TOKEN = process.env.PT_TOKEN || ""
// parse-text 允许抓取的页面域名后缀(直链 mp3/m4a 不受限)
const PARSE_HOST_WHITELIST = [
  "xiaoyuzhoufm.com",
  "podcasts.apple.com",
  "pod.link",
  "youzhiyouxing.cn",
  "sspai.com",
  "mp.weixin.qq.com",
]
const MAX_ROOM_NUM = 15
const MIN_DURATION_FOR_A_PERSON = 250   // 同一人两次操作的最小间隔(ms)
const SWEEP_PERIOD = 15 * 1000          // 房间巡检周期(对应 room-clock 定时触发器)
const ROOM_EXPIRE_MILLI = 7 * 24 * 3600 * 1000   // 房间 7 天未活跃标记为 EXPIRED
const DATA_FILE = path.join(__dirname, "..", "data", "rooms.json")

const DEFAULT_ROOM_CFG = { everyoneCanOperatePlayer: "Y" }
const SPEED_RATES = ["0.8", "1", "1.2", "1.5", "1.7"]

// ===================== 房间存储 =====================
// rooms: Map<roomId, Room>
const rooms = new Map()
const visitors = new Map()   // 访客统计(仅内存,可选)

const loadRooms = () => {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8")
    const list = JSON.parse(raw)
    for (const [id, room] of Object.entries(list)) rooms.set(id, room)
    console.log(`已从磁盘恢复 ${rooms.size} 个房间`)
  } catch (e) { /* 首次启动无文件 */ }
}

let saveTimer = 0
const saveRooms = () => {
  // 500ms 防抖落盘
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = 0
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true })
      fs.writeFileSync(DATA_FILE, JSON.stringify(Object.fromEntries(rooms)))
    } catch (e) {
      console.error("落盘失败:", e.message)
    }
  }, 500)
}

// ===================== 房间逻辑(对应 room-operate.ts) =====================
const genRoomId = () => {
  // 6 位大写字母数字(去掉易混淆字符),与 laf 的 24 位 doc id 一样对客户端不透明
  const ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  let id = ""
  for (let i = 0; i < 6; i++) id += ABC[Math.floor(Math.random() * ABC.length)]
  return rooms.has(id) ? genRoomId() : id
}

const genGuestId = (participants) => {
  const ABC = "abcdefghijkmnopqrstuvwyz123456789"
  const ids = participants.map((v) => v.guestId)
  for (let run = 0; run < 15; run++) {
    let id = ""
    for (let i = 0; i < 11; i++) id += ABC[Math.floor(Math.random() * ABC.length)]
    if (!ids.includes(id)) return id
  }
  return `g${Date.now().toString(36)}`
}

const pausePlayer = (room, operator = "") => {
  if (room.playStatus === "PAUSED") return
  room.playStatus = "PAUSED"
  const participants = room.participants || []
  const rate = Number(room.speedRate)
  const speedRateNum = isNaN(rate) || rate >= 1.71 ? 1 : rate
  if (participants.length > 0) {
    let lastHeartbeat = room.operateStamp
    for (const p of participants) {
      if (p.heartbeatStamp > lastHeartbeat) lastHeartbeat = p.heartbeatStamp
    }
    room.contentStamp += (lastHeartbeat - room.operateStamp) * speedRateNum
    room.operateStamp = Date.now()
    room.operator = operator
  }
}

const toParticipantClient = (v) => ({
  nickName: v.nickName,
  guestId: v.guestId,
  heartbeatStamp: v.heartbeatStamp,
  enterStamp: v.enterStamp,
})

const toRoRes = (room, extra = {}) => ({
  roomId: room._id,
  content: room.content,
  playStatus: room.playStatus,
  speedRate: room.speedRate,
  operator: room.operator,
  contentStamp: room.contentStamp,
  operateStamp: room.operateStamp,
  participants: (room.participants || []).map(toParticipantClient),
  everyoneCanOperatePlayer: (room.config || DEFAULT_ROOM_CFG).everyoneCanOperatePlayer,
  ...extra,
})

const recordVisitor = (body) => {
  const nonce = body["x-pt-local-id"]
  if (!nonce) return
  const now = Date.now()
  const v = visitors.get(nonce)
  if (v) {
    v.nickName = body.nickName || v.nickName
    if (body.operateType === "CREATE") { v.createNum++; v.createRoomStamp = now }
    else { v.enterNum++; v.enterRoomStamp = now }
    return
  }
  visitors.set(nonce, {
    nickName: body.nickName || "",
    enterRoomStamp: body.operateType === "ENTER" ? now : -1,
    enterNum: body.operateType === "ENTER" ? 1 : 0,
    createNum: body.operateType === "CREATE" ? 1 : 0,
    createRoomStamp: body.operateType === "CREATE" ? now : -1,
    createStamp: now,
    nonce,
  })
}

const checkMyRoomAndDelete = (clientId) => {
  for (const room of rooms.values()) {
    if (room.oState === "OK" && room.owner === clientId) {
      pausePlayer(room)
      room.oState = "DELETED"
      room.participants = []
    }
  }
}

const handleCreate = (body) => {
  const clientId = body["x-pt-local-id"]
  checkMyRoomAndDelete(clientId)
  recordVisitor(body)

  const now = Date.now()
  const roomId = genRoomId()
  const room = {
    _id: roomId,
    content: body.roomData,
    oState: "OK",
    playStatus: "PAUSED",
    speedRate: "1",
    contentStamp: 0,
    operateStamp: now,
    operator: "",
    createStamp: now,
    owner: clientId,
    participants: [],
    config: { ...DEFAULT_ROOM_CFG },
  }
  rooms.set(roomId, room)
  saveRooms()
  return { code: "0000", data: toRoRes(room) }
}

const handleEnter = (body) => {
  const clientId = body["x-pt-local-id"]
  const { roomId, nickName } = body
  const room = rooms.get(roomId)
  if (!room) return { code: "E4004" }
  if (room.oState === "EXPIRED") return { code: "E4006" }
  if (room.oState === "DELETED") return { code: "E4004" }

  const now = Date.now()
  let me = room.participants.find((v) => v.nonce === clientId)
  if (me) {
    me.nickName = nickName
    me.enterStamp = now
    me.heartbeatStamp = now
  } else {
    if (room.participants.length >= MAX_ROOM_NUM) return { code: "R0001" }
    me = {
      nickName,
      enterStamp: now,
      heartbeatStamp: now,
      guestId: genGuestId(room.participants),
      nonce: clientId,
    }
    room.participants.push(me)
  }
  // 踢掉 60s 无心跳的人
  room.participants = room.participants.filter((v) => now - v.heartbeatStamp < 60 * 1000)

  recordVisitor(body)
  saveRooms()
  return {
    code: "0000",
    data: toRoRes(room, {
      guestId: me.guestId,
      iamOwner: room.owner === clientId ? "Y" : "N",
    }),
  }
}

const handleHeartbeat = (body) => {
  const clientId = body["x-pt-local-id"]
  const { roomId, nickName } = body
  const room = rooms.get(roomId)
  if (!room) return { code: "E4004" }
  if (room.oState === "EXPIRED") return { code: "E4006" }
  if (room.oState === "DELETED") return { code: "E4004" }

  const now = Date.now()
  const me = room.participants.find((v) => v.nonce === clientId)
  if (!me) return { code: "E4003" }
  me.heartbeatStamp = now
  me.nickName = nickName
  // 踢掉 50s 无心跳的人
  room.participants = room.participants.filter((v) => now - v.heartbeatStamp < 50 * 1000)
  saveRooms()
  return { code: "0000", data: toRoRes(room) }
}

const handleLeave = (body) => {
  const clientId = body["x-pt-local-id"]
  const { roomId } = body
  const room = rooms.get(roomId)
  if (!room) return { code: "E4004" }
  if (room.oState === "EXPIRED") return { code: "E4006" }
  if (room.oState === "DELETED") return { code: "E4004" }
  if (!room.participants || room.participants.length < 1) return { code: "0000" }

  const me = room.participants.find((v) => v.nonce === clientId)
  if (!me) return { code: "E4003" }
  if (room.participants.length === 1) {
    pausePlayer(room)
    room.participants = []
    saveRooms()
    return { code: "0000" }
  }
  room.participants = room.participants.filter((v) => v.nonce !== clientId)
  saveRooms()
  return { code: "0000" }
}

// 口令校验;TOKEN 未设置时放行
const checkToken = (body) => {
  if (TOKEN && body["x-pt-token"] !== TOKEN) return { code: "E4003" }
  return null
}

// 入参校验(对应 checkEntry)
const checkEntry = (body) => {
  const tokenErr = checkToken(body)
  if (tokenErr) return tokenErr
  const localId = body["x-pt-local-id"]
  if (!localId) return { code: "E4000" }
  const { operateType = "", nickName, roomId } = body
  const roomData = body.roomData
  if (!nickName && operateType !== "CREATE") return { code: "E4000" }
  if (!["CREATE", "ENTER", "HEARTBEAT", "LEAVE"].includes(operateType)) return { code: "E4000" }
  if (["ENTER", "HEARTBEAT", "LEAVE"].includes(operateType) && !roomId) return { code: "E4000" }
  if (operateType === "CREATE") {
    if (!roomData || roomData.infoType !== "podcast" || !roomData.audioUrl) {
      return { code: "E4000", errMsg: "roomData.audioUrl is required" }
    }
  }
  return null
}

// ===================== 房间巡检(对应 room-clock.ts) =====================
const sweepRooms = () => {
  const now = Date.now()
  for (const room of rooms.values()) {
    if (room.oState !== "OK") continue
    // 长期未活跃的房间标记过期
    const lastActive = Math.max(room.createStamp, room.operateStamp)
    if (now - lastActive > ROOM_EXPIRE_MILLI) {
      room.oState = "EXPIRED"
      saveRooms()
      continue
    }
    if (room.playStatus !== "PLAYING") continue
    let participants = room.participants || []
    if (participants.length < 1) {
      room.playStatus = "PAUSED"
      saveRooms()
      continue
    }
    const SEC_50_AGO = now - 50 * 1000
    let lastHeartbeat = 1
    const kept = participants.filter((p) => {
      if (p.heartbeatStamp > lastHeartbeat) lastHeartbeat = p.heartbeatStamp
      return p.heartbeatStamp > SEC_50_AGO
    })
    if (kept.length === participants.length) continue
    room.participants = kept
    if (kept.length === 0) {
      const rate = Number(room.speedRate)
      const speedRateNum = isNaN(rate) || rate >= 1.71 ? 1 : rate
      room.playStatus = "PAUSED"
      room.contentStamp += (lastHeartbeat - room.operateStamp) * speedRateNum
      room.operateStamp = now
      room.operator = ""
    }
    saveRooms()
  }
}

// ===================== WebSocket(对应 web-socket.ts) =====================
const wss = new WebSocketServer({ noServer: true })
// socket -> { roomId }
const socketMeta = new WeakMap()

const broadcastRoomStatus = (roomId, roomStatus) => {
  const msg = JSON.stringify({ responseType: "NEW_STATUS", roomStatus })
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue
    const meta = socketMeta.get(client)
    if (meta && meta.roomId === roomId) client.send(msg)
  }
}

const getOperatorGuestId = (clientId, room) => {
  if (!room) return undefined
  if (room.oState === "EXPIRED" || room.oState === "DELETED") return undefined
  const me = (room.participants || []).find((v) => v.nonce === clientId)
  return me ? me.guestId : undefined
}

const roomStatusOf = (room) => ({
  roomId: room._id,
  playStatus: room.playStatus,
  speedRate: room.speedRate,
  operator: room.operator,
  contentStamp: room.contentStamp,
  operateStamp: room.operateStamp,
  everyoneCanOperatePlayer: (room.config || DEFAULT_ROOM_CFG).everyoneCanOperatePlayer,
})

wss.on("connection", (socket) => {
  socket.send(JSON.stringify({ responseType: "CONNECTED" }))

  socket.on("message", (data) => {
    let req
    try { req = JSON.parse(data.toString()) } catch (e) { return }
    if (!req || !req.operateType || !req.roomId || !req["x-pt-local-id"] || !req["x-pt-stamp"]) {
      socket.close()
      return
    }
    // 口令校验
    if (TOKEN && req["x-pt-token"] !== TOKEN) {
      socket.close()
      return
    }
    const { operateType, roomId } = req
    const clientId = req["x-pt-local-id"]

    if (operateType === "FIRST_SEND") {
      const room = rooms.get(roomId)
      if (!room) { socket.close(); return }
      const guestId = getOperatorGuestId(clientId, room)
      if (!guestId) { socket.close(); return }
      socketMeta.set(socket, { roomId })
      socket.send(JSON.stringify({ responseType: "NEW_STATUS", roomStatus: roomStatusOf(room) }))
      return
    }

    if (operateType === "HEARTBEAT") {
      const meta = socketMeta.get(socket)
      if (!meta || meta.roomId !== roomId) { socket.close(); return }
      socket.send(JSON.stringify({ responseType: "HEARTBEAT" }))
      return
    }

    if (operateType === "SET_PLAYER") {
      const { playStatus, speedRate, contentStamp, everyoneCanOperatePlayer } = req
      if (!playStatus || !speedRate || typeof contentStamp !== "number") return
      const room = rooms.get(roomId)
      if (!room) return
      const cfg = room.config || DEFAULT_ROOM_CFG
      const isOwner = room.owner === clientId
      if (!isOwner && cfg.everyoneCanOperatePlayer === "N") return

      const guestId = getOperatorGuestId(clientId, room)
      if (!guestId) { socket.close(); return }

      // 同一个人两次操作的间隔过短则忽略
      if (guestId === room.operator && req["x-pt-stamp"] - room.operateStamp < MIN_DURATION_FOR_A_PERSON) return

      room.playStatus = playStatus
      room.speedRate = speedRate
      room.contentStamp = contentStamp
      room.operateStamp = req["x-pt-stamp"]
      room.operator = guestId
      if (everyoneCanOperatePlayer && isOwner) room.config = { ...cfg, everyoneCanOperatePlayer }
      saveRooms()

      const roomStatus = roomStatusOf(room)
      broadcastRoomStatus(roomId, roomStatus)
      return
    }
  })
})

// ===================== parse-text(对应 parse-text.ts) =====================
const WX_AUDIO_URL = "https://res.wx.qq.com/voice/getvoice?mediaid="
const MAX_FETCH_MILLI = 4000

const judgeIsCdnLink = (link) => /^https?:\/\/[\w.-]*\w{1,32}\.\w{2,6}\/\S+.(mp3|m4a)[?=\w]*$/.test(link)

const BROWSER_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

const fetchLink = async (link) => {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), MAX_FETCH_MILLI)
  try {
    // 部分站点(如小宇宙)会拦截非浏览器 UA，必须带上
    const res = await fetch(link, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": BROWSER_UA } })
    const html = await res.text()
    const lower = html.toLowerCase()
    if (!lower.includes("head") || !lower.includes("meta")) return ""
    return html
  } catch (e) {
    return ""
  } finally {
    clearTimeout(timer)
  }
}

const getAudioUrl = (html, isMp) => {
  const reg0 = /http(s)?:\/\/[^\s/"']{2,40}\/[^\s"']{2,240}\.(mp3|m4a)\?[^\s/"']{3,240}/g
  const m0 = html.match(reg0)
  if (m0 && m0[0]) return m0[0]
  const reg1 = /http(s)?:\/\/[^\s/"']{2,40}\/[^\s"']{2,240}\.(mp3|m4a)/g
  const m1 = html.match(reg1)
  if (m1 && m1[0]) return m1[0]
  if (!isMp) return ""
  const reg2 = /(?<="voice_id":")\w{10,50}(?=")/g
  const m2 = html.match(reg2)
  if (m2 && m2[0]) return WX_AUDIO_URL + m2[0]
  const reg3 = /(?<='voice_id':')\w{10,50}(?=')/g
  const m3 = html.match(reg3)
  if (m3 && m3[0]) return WX_AUDIO_URL + m3[0]
  return ""
}

const parseHtml = (html, originLink) => {
  const $ = cheerio.load(html)
  let appName = "", sourceType = ""
  let title = "", audioUrl = "", description = ""
  let imageUrl = "", twitterImage = "", linkUrl = ""
  let seriesName = "", seriesUrl = ""

  const isMp = originLink.includes("mp.weixin.qq.com")

  $("head meta").each((i, el) => {
    const meta = $(el)
    const prop = meta.attr("property")
    const name = meta.attr("name")
    const content = meta.attr("content") ?? ""
    if (prop === "og:title") title = content
    else if (prop === "og:description" || name === "description") description = content
    else if (prop === "og:image") imageUrl = content
    else if (prop === "og:audio") audioUrl = content
    else if (name === "application-name") appName = content
    else if (prop === "twitter:image") twitterImage = content
    else if (prop === "og:url") linkUrl = content
    else if (prop === "og:site_name" && !appName) appName = content
  })

  if (!audioUrl) {
    audioUrl = getAudioUrl(html, isMp)
    if (!audioUrl) return { code: "E4004" }
  }

  if (!imageUrl && twitterImage) imageUrl = twitterImage
  if (!title) title = $("head title").text().trim()

  $("head script").each((i, el) => {
    const spt = $(el)
    const name = spt.attr("name")
    if (name === "schema:podcast-show") {
      let j = {}
      try { j = JSON.parse(spt.text()) } catch (e) { return }
      if (j.url) linkUrl = j.url
      const partOfSeries = j.partOfSeries || {}
      seriesName = partOfSeries.name || seriesName
      seriesUrl = partOfSeries.url || seriesUrl
      if (j.description) description = j.description
    } else if (name === "schema:podcast-episode") {
      let j = {}
      try { j = JSON.parse(spt.text()) } catch (e) { return }
      if (j.name) title = j.name
      if (j.description) description = j.description
      if (j.isPartOf) seriesName = j.isPartOf
    }
  })

  // 适配 pod.link
  if (originLink.includes("pod.link")) {
    let newHtml = html
    const idx = newHtml.indexOf("window.__STATE__")
    if (idx > 0) {
      newHtml = newHtml.substring(idx)
      const idx2 = newHtml.indexOf(title)
      if (idx2 > 0) {
        const audio = getAudioUrl(newHtml.substring(idx2), false)
        if (audio) audioUrl = audio
      }
    }
  }

  // 适配 youzhiyouxing.cn 的图片
  const isYZYX = originLink.includes("youzhiyouxing.cn")
  if (isYZYX) {
    if (!imageUrl) {
      $(".lazy-image-container img").each((i, el) => {
        const src = $(el).attr("data-src")
        if (src && !imageUrl) imageUrl = src
      })
    }
    if (!seriesName) {
      $("body .tw-text-14.tw-leading-none").each((i, el) => {
        const t = $(el).text().trim()
        if (t && !seriesName) seriesName = t
      })
    }
  }

  // 适配微信公众号
  if (isMp) {
    sourceType = "weixin_mp"
    imageUrl = ""   // 微信图片有防盗链
    const m = html.match(/(?<=class="profile_nickname">)\S+(?=<\/strong>)/g)
    if (m && m.length) seriesName = m[m.length - 1]
  }

  if (!linkUrl) linkUrl = originLink

  if (appName === "小宇宙") sourceType = "xiaoyuzhou"
  else if (appName === "一派·Podcast") {
    sourceType = "sspai"
    if (!seriesName) seriesName = "一派·Podcast"
    if (!seriesUrl) seriesUrl = "https://sspai.typlog.io/"
  }
  else if (isYZYX) sourceType = "youzhiyouxing"
  else if (linkUrl.includes("podcasts.apple.com")) sourceType = "apple_podcast"
  else if (appName && !seriesName) seriesName = appName

  return {
    code: "0000",
    data: { infoType: "podcast", title, audioUrl, description, imageUrl, linkUrl, sourceType, seriesName, seriesUrl },
  }
}

const handleParseText = async (body) => {
  const tokenErr = checkToken(body)
  if (tokenErr) return tokenErr
  const link = body.link
  if (!link || !body["x-pt-local-id"]) return { code: "E4000" }
  if (!link.startsWith("http")) return { code: "E4000" }

  if (judgeIsCdnLink(link)) {
    return { code: "0000", data: { infoType: "podcast", audioUrl: link } }
  }
  // 非直链的网页解析只允许白名单域名,防止被当成开放代理
  let host = ""
  try { host = new URL(link).hostname } catch (e) { return { code: "E4000" } }
  const allowed = PARSE_HOST_WHITELIST.some((suffix) => host === suffix || host.endsWith("." + suffix))
  if (!allowed) return { code: "E4003" }

  const html = await fetchLink(link)
  if (!html) return { code: "E4004" }
  return parseHtml(html, link)
}

// ===================== HTTP 路由 =====================
const json = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(obj))
}

const readBody = (req) => new Promise((resolve) => {
  let chunks = []
  req.on("data", (c) => chunks.push(c))
  req.on("end", () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))) }
    catch (e) { resolve(null) }
  })
})

const withCors = (res) => {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
}

const server = http.createServer(async (req, res) => {
  withCors(res)
  if (req.method === "OPTIONS") { res.end(); return }
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname
  const ua = req.headers["user-agent"]

  if (req.method !== "POST") {
    // 健康检查
    if (req.method === "GET" && (pathname === "/pt-service" || pathname === "/")) {
      return json(res, 200, { code: "E4005" })
    }
    return json(res, 404, { code: "E4044" })
  }

  const body = await readBody(req)
  if (!body) return json(res, 200, { code: "E4000" })

  if (pathname === "/pt-service") {
    return json(res, 200, { code: "0000", data: { stamp: Date.now() } })
  }

  if (pathname === "/parse-text") {
    const t1 = Date.now()
    const result = await handleParseText(body)
    console.log(`[parse-text] ${body.link} -> ${result.code} (${Date.now() - t1}ms)`)
    return json(res, 200, result)
  }

  if (pathname === "/room-operate") {
    const err = checkEntry(body)
    if (err) return json(res, 200, err)
    let result = { code: "E4044" }
    if (body.operateType === "CREATE") result = handleCreate(body)
    else if (body.operateType === "ENTER") result = handleEnter(body)
    else if (body.operateType === "HEARTBEAT") result = handleHeartbeat(body)
    else if (body.operateType === "LEAVE") result = handleLeave(body)
    console.log(`[room-operate] ${body.operateType} room=${body.roomId || "-"} client=${body["x-pt-local-id"]}`)
    return json(res, 200, result)
  }

  return json(res, 404, { code: "E4044" })
})

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req)
  })
})

const main = () => {
  loadRooms()
  setInterval(sweepRooms, SWEEP_PERIOD)
  server.listen(PORT, () => {
    console.log(`podcast-together 后端已启动:`)
    console.log(`  HTTP     http://0.0.0.0:${PORT}  (/room-operate /parse-text /pt-service)`)
    console.log(`  WebSocket ws://0.0.0.0:${PORT}`)
  })
}

main()

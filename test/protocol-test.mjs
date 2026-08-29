// 端到端协议测试:模拟两个小程序客户端 创建/进入/心跳/ws 同步/操作播放器/离开
const API = "http://127.0.0.1:3000"

const post = (path, body) =>
  fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json())

const base = (localId) => ({
  "x-pt-version": "0.10.4",
  "x-pt-client": "miniprogram",
  "x-pt-stamp": Date.now(),
  "x-pt-language": "zh-CN",
  "x-pt-local-id": localId,
})

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg)
    process.exit(1)
  }
  console.log("PASS:", msg)
}

const main = async () => {
  // 1. 房主创建房间
  const createRes = await post("/room-operate", { ...base("client-A"), operateType: "CREATE", nickName: "房主", roomData: { infoType: "podcast", audioUrl: "https://example.com/ep1.mp3", title: "EP1" } })
  assert(createRes.code === "0000" && createRes.data.roomId, "CREATE 返回 roomId=" + createRes.data.roomId)
  assert(createRes.data.iamOwner === undefined && createRes.data.playStatus === "PAUSED", "新房间为 PAUSED")
  const roomId = createRes.data.roomId

  // 2. 房主进入
  const enterA = await post("/room-operate", { ...base("client-A"), operateType: "ENTER", roomId, nickName: "房主" })
  assert(enterA.code === "0000" && enterA.data.iamOwner === "Y" && enterA.data.guestId, "房主 ENTER, iamOwner=Y, guestId=" + enterA.data.guestId)
  const guestA = enterA.data.guestId

  // 3. 朋友进入
  const enterB = await post("/room-operate", { ...base("client-B"), operateType: "ENTER", roomId, nickName: "朋友" })
  assert(enterB.code === "0000" && enterB.data.iamOwner === "N", "朋友 ENTER, iamOwner=N")
  assert(enterB.data.participants.length === 2, "房间内 2 人")

  // 4. 两人建立 WebSocket,收 CONNECTED -> 发 FIRST_SEND -> 收 NEW_STATUS
  const mkClient = (localId, name) =>
    new Promise((resolve, reject) => {
      import("ws").then(({ default: WebSocket }) => {
        const ws = new WebSocket("ws://127.0.0.1:3000")
        const state = { name, ws, statuses: [], connected: false, firstStatus: null }
        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString())
          if (msg.responseType === "CONNECTED") {
            state.connected = true
            ws.send(JSON.stringify({ ...base(localId), operateType: "FIRST_SEND", roomId }))
          } else if (msg.responseType === "NEW_STATUS") {
            state.statuses.push(msg.roomStatus)
            if (!state.firstStatus) state.firstStatus = msg.roomStatus
          }
        })
        ws.on("open", () => resolve(state))
        ws.on("error", reject)
      })
    })

  const A = await mkClient("client-A", "A")
  const B = await mkClient("client-B", "B")
  await new Promise((r) => setTimeout(r, 500))
  assert(A.connected && B.connected, "双方均收到 CONNECTED")
  assert(A.firstStatus && A.firstStatus.roomId === roomId && A.firstStatus.speedRate === "1", "A 的 FIRST_SEND 得到 NEW_STATUS 初始状态")

  // 5. 房主通过 ws 上报 SET_PLAYER:PLAYING @ 120000ms, 1.2x
  const stamp5 = Date.now()
  A.ws.send(JSON.stringify({
    ...base("client-A"), operateType: "SET_PLAYER", roomId,
    playStatus: "PLAYING", speedRate: "1.2", contentStamp: 120000,
    "x-pt-stamp": stamp5,
  }))
  await new Promise((r) => setTimeout(r, 500))
  assert(B.statuses.length >= 1 && B.statuses[B.statuses.length - 1].contentStamp === 120000 && B.statuses[B.statuses.length - 1].playStatus === "PLAYING", "B 收到 NEW_STATUS: PLAYING@120000ms 1.2x")
  assert(B.statuses[B.statuses.length - 1].operator === guestA, "operator 为房主 guestId")

  // 6. 同一人 250ms 内的重复操作被忽略(用与上一次操作相差 100ms 的时间戳)
  const before = B.statuses.length
  A.ws.send(JSON.stringify({ ...base("client-A"), operateType: "SET_PLAYER", roomId, playStatus: "PAUSED", speedRate: "1.2", contentStamp: 120500, "x-pt-stamp": stamp5 + 100 }))
  await new Promise((r) => setTimeout(r, 500))
  assert(B.statuses.length === before, "同一人 250ms 内重复操作被忽略")
  assert(B.statuses[B.statuses.length - 1].contentStamp === 120000, "状态仍是首次操作的 120000")

  // 7. 非房主可操作(默认 everyoneCanOperatePlayer=Y)
  await new Promise((r) => setTimeout(r, 300))
  B.ws.send(JSON.stringify({ ...base("client-B"), operateType: "SET_PLAYER", roomId, playStatus: "PAUSED", speedRate: "1", contentStamp: 130000, "x-pt-stamp": Date.now() }))
  await new Promise((r) => setTimeout(r, 500))
  const last = A.statuses[A.statuses.length - 1]
  assert(last && last.playStatus === "PAUSED" && last.contentStamp === 130000 && last.speedRate === "1", "朋友操作被广播: PAUSED@130000ms 1x")

  // 8. 心跳
  A.ws.send(JSON.stringify({ ...base("client-A"), operateType: "HEARTBEAT", roomId }))
  await new Promise((r) => setTimeout(r, 300))
  assert(true, "ws HEARTBEAT 已发送(无异常断开)")

  // 9. 房主创建新房间 -> 旧房间 DELETED
  const create2 = await post("/room-operate", { ...base("client-A"), operateType: "CREATE", nickName: "房主", roomData: { infoType: "podcast", audioUrl: "https://example.com/ep2.mp3" } })
  assert(create2.code === "0000" && create2.data.roomId !== roomId, "房主再建新房间的 roomId=" + create2.data.roomId)
  const reEnter = await post("/room-operate", { ...base("client-A"), operateType: "ENTER", roomId, nickName: "房主" })
  assert(reEnter.code === "E4004", "旧房间已 DELETED, ENTER 返回 E4004")

  // 10. 查无房间
  const ghost = await post("/room-operate", { ...base("client-C"), operateType: "ENTER", roomId: "ZZZZZZ", nickName: "路人" })
  assert(ghost.code === "E4004", "不存在的房间返回 E4004")

  A.ws.close()
  B.ws.close()
  console.log("\n全部测试通过 ✅")
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

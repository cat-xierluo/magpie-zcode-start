// auth.checkin claims the gift plans ZCode's preview lists for an account
// (magpie-community/plugins#503). The preview and the "already claimed"
// replies are real (#503's capture of 10-29, the 10-06 preview in
// usage.test.mjs); the code 0 claim reply has not been seen yet, so its
// fixture carries only the code.
import { test, expect, afterAll, beforeAll, beforeEach } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

let ZCodeAuthPlugin, _internal
beforeAll(async () => {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ ZCodeAuthPlugin, _internal } = await import("./index.mjs"))
})
const offline = async () => { throw new Error("no network in tests") }
const real = globalThis.fetch
afterAll(() => (globalThis.fetch = real))
beforeEach(() => {
  globalThis.fetch = offline
  _internal.routes.clear()
})

// serve is the fake zcode.z.ai: route answers each request, and a request
// it doesn't answer is a 404
function serve(route) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    const c = { url: u, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body }
    calls.push(c)
    return (await route(c)) ?? new Response("", { status: 404 })
  }
  return calls
}
const json = (v, status = 200) => new Response(typeof v === "string" ? v : JSON.stringify(v), { status })
const jwt = (exp) => ["{}", JSON.stringify({ exp })].map((s) => Buffer.from(s).toString("base64url")).join(".") + ".sig"
const now = Math.trunc(Date.now() / 1000)
const DEVICE = "11111111-2222-4333-8444-555555555555"
const TOKEN = jwt(now + 86400)
const oauth = (state) => ({ type: "oauth", access: state.key ?? state.jwt ?? "", refresh: JSON.stringify(state), expires: 0 })
const SIGNED_IN = oauth({ site: "zai", jwt: TOKEN, device: DEVICE })
async function checkin(auth = SIGNED_IN) {
  const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
  return hooks.auth.checkin(async () => auth, { id: "zcode" })
}

// #503: the preview of an account with nothing to claim
const PREVIEW_NONE = '{"code":0,"msg":"","data":{"plans":[],"server_time":1793318263}}'
// usage.test.mjs's real preview, the day's ZCode Trust Build unclaimed
const PREVIEW_ONE = {
  code: 0, msg: "",
  data: {
    server_time: 1791216750,
    plans: [{
      user_plan_id: "upl_2107141892427358208", plan_id: "zcode-v3-start-plan-trust-1006", name: "ZCode Trust Build",
      description: "ZCode Global Build", priority: 110, status: "active", starts_at: 1791216750, ends_at: 1791302400,
      entitlements: [{ entitlement_id: "zcode-v3-start-plan-trust-1006", show_name: "GLM-5.3-Flash", meter: "model_usage",
        unit_type: "token", capabilities: ["model:glm-5.3-flash"], grant_units: 100000000, period: "one_time", priority: 110, effective_at: 0 }],
    }],
  },
}
const PREVIEW_TWO = { ...PREVIEW_ONE, data: { ...PREVIEW_ONE.data, plans: [...PREVIEW_ONE.data.plans, { plan_id: "zcode-v3-start-plan-1029", name: "ZCODE GLOBAL BUILD", status: "active" }] } }
// #503's reply to claiming a plan claimed before, as it came
const CLAIMED_BEFORE = '{"code":1003,"msg":"target already exists","data":{"server_time":1793318302,"message":"You have already claimed this plan."},"logid":"202610292358223079156af0f90065850e"}'
// a code 0 claim: only the code is known
const CLAIMED_NOW = '{"code":0,"msg":""}'
// the 10-06 answer to a claim without the app's captcha (#30)
const CAPTCHA = '{"code":3007,"msg":"captcha verify failed"}'

const PREVIEW = "/api/v1/zcode-plan/billing/preview"
const CLAIM = "/api/v1/zcode-plan/billing/claim"
// claimWith serves the preview and answers each claim with claim(plan_id)
function claimWith(preview, claim) {
  return serve(({ url, method, body }) => {
    if (url.pathname === PREVIEW && method === "GET") return json(preview)
    if (url.pathname === CLAIM && method === "POST") return claim(JSON.parse(body).plan_id)
  })
}
const claims = (calls) => calls.filter((c) => c.url.pathname === CLAIM)

test("nothing to claim: inactive, and no claim is asked", async () => {
  const calls = claimWith(PREVIEW_NONE, () => json(CLAIMED_NOW))
  const r = await checkin()
  expect(r).toEqual({ outcome: "inactive", message: "no ZCode gift plan to claim" })
  expect(claims(calls)).toEqual([])
  // the preview went out as the app's billing calls do
  const p = calls[0]
  expect(p.url.pathname).toBe(PREVIEW)
  expect(p.url.searchParams.get("app_version")).toBe("3.16.3")
  expect(p.url.searchParams.get("platform")).toBe(`${process.platform}-${process.arch}`)
  expect(p.headers.Authorization).toBe("Bearer " + TOKEN)
  expect(p.headers["X-Device-Mid"]).toBe(DEVICE)
  expect(p.headers["X-ZCode-App-Version"]).toBe("3.16.3")
  expect(p.headers["X-Platform"]).toBe(`${process.platform}-${process.arch}`)
})

test("one plan to claim, claimed with code 0", async () => {
  _internal.routes.set("\0" + TOKEN, { stale: true })
  const calls = claimWith(PREVIEW_ONE, () => json(CLAIMED_NOW))
  const r = await checkin()
  expect(r).toEqual({ outcome: "claimed", message: "claimed ZCode Trust Build" })
  const [c] = claims(calls)
  expect(claims(calls).length).toBe(1)
  expect(c.url.origin).toBe("https://zcode.z.ai")
  expect(JSON.parse(c.body)).toEqual({ plan_id: "zcode-v3-start-plan-trust-1006" })
  expect(c.headers.Authorization).toBe("Bearer " + TOKEN)
  expect(c.headers["X-Device-Mid"]).toBe(DEVICE)
  expect(c.headers["X-ZCode-App-Version"]).toBe("3.16.3")
  expect(c.headers["X-Platform"]).toBe(`${process.platform}-${process.arch}`)
  expect(c.headers["Content-Type"]).toBe("application/json")
  // the route is read again, so the next request uses the plan
  expect(_internal.routes.has("\0" + TOKEN)).toBe(false)
})

test("a plan claimed before (HTTP 200, code 1003) is done, not a failure", async () => {
  claimWith(PREVIEW_ONE, () => json(CLAIMED_BEFORE))
  expect(await checkin()).toEqual({ outcome: "done", message: "already claimed: ZCode Trust Build" })
})

test("a claim ZCode wants the app's captcha for is captcha: claimed in the ZCode app", async () => {
  claimWith(PREVIEW_ONE, () => json(CAPTCHA, 400))
  const r = await checkin()
  expect(r.outcome).toBe("captcha")
  expect(r.message).toContain("ZCode Trust Build: claim it in the ZCode app (captcha verify failed)")
})

test("a claim that doesn't read is failed (unknown), never claimed", async () => {
  for (const answer of [
    () => json("", 500),
    () => json("<html>bad gateway</html>", 502),
    () => json("not json at all"), // HTTP 200, garbled
    () => json("{}"), // no code
    () => json('{"code":0}', 500), // a code 0 on an HTTP error is no claim
    () => json('{"code":1001,"msg":"system busy"}'),
    () => { throw new Error("socket hang up") },
  ]) {
    claimWith(PREVIEW_ONE, answer)
    const r = await checkin()
    expect(r.outcome).toBe("failed")
    expect(r.message).toStartWith("ZCode Trust Build: ")
    // a failed claim never touches the account's sign-in
    expect(r.signIn).toBeUndefined()
  }
})

test("a preview that doesn't read is failed (unknown), and nothing is claimed", async () => {
  for (const answer of [
    () => json("", 500),
    () => json("garbled"),
    () => json('{"code":0,"data":{}}'), // no plan list
    () => json('{"code":401,"msg":"token invalid"}', 401),
    () => { throw new Error("no network in tests") },
  ]) {
    const calls = serve(({ url }) => (url.pathname === PREVIEW ? answer() : json(CLAIMED_NOW)))
    const r = await checkin()
    expect(r.outcome).toBe("failed")
    expect(r.signIn).toBeUndefined()
    expect(claims(calls)).toEqual([])
  }
})

test("one claimed and one failed is failed, naming the claimed one, so it is asked again", async () => {
  claimWith(PREVIEW_TWO, (id) => (id === "zcode-v3-start-plan-1029" ? json("", 503) : json(CLAIMED_NOW)))
  const r = await checkin()
  expect(r.outcome).toBe("failed")
  expect(r.message).toBe("claimed ZCode Trust Build; ZCODE GLOBAL BUILD: HTTP 503, unreadable reply (empty)")
  // asked again: the one claimed answers 1003 now
  claimWith(PREVIEW_TWO, (id) => (id === "zcode-v3-start-plan-1029" ? json(CLAIMED_NOW) : json(CLAIMED_BEFORE)))
  expect(await checkin()).toEqual({ outcome: "claimed", message: "claimed ZCODE GLOBAL BUILD" })
})

test("an account with no ZCode session asks nothing", async () => {
  const calls = serve(() => json(CLAIMED_NOW))
  const key = await checkin({ type: "api", key: "k", metadata: { site: "zai" } })
  expect(key.outcome).toBe("ineligible")
  const expired = await checkin(oauth({ site: "zai", jwt: jwt(now - 60), device: DEVICE }))
  expect(expired.outcome).toBe("failed")
  expect(expired.message).toContain("sign-in has expired")
  expect(expired.signIn).toBeUndefined()
  expect(calls).toEqual([])
})

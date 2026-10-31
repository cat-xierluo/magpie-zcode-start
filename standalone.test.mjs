import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { createCipheriv, createHash, randomBytes } from "node:crypto"
import * as entry from "./index.mjs"

const realFetch = globalThis.fetch
const URL = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages"
let directory, file

beforeAll(() => {
  if (![tmpdir(), realpathSync(tmpdir())].some((p) => homedir().startsWith(p))) {
    throw new Error("run with an isolated HOME under the temporary directory")
  }
})
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "zcode-start-signins-"))
  file = join(directory, "plugin-auth.json")
  globalThis.fetch = async () => { throw new Error("unexpected network request") }
})
afterEach(() => {
  globalThis.fetch = realFetch
  rmSync(directory, { recursive: true, force: true })
})

function oauth(uid, token = "one") {
  const jwt = ["{}", JSON.stringify({ sub: uid, token, exp: Math.floor(Date.now() / 1000) + 3600 })]
    .map((x) => Buffer.from(x).toString("base64url")).join(".") + ".synthetic"
  return {
    type: "oauth", access: "paid-api-key", expires: 0,
    accountId: `${uid}@example.test`, uid,
    refresh: JSON.stringify({ site: "zai", jwt, key: "paid-api-key", device: `device-${uid}` }),
  }
}

const save = (all) => writeFileSync(file, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 })
const read = () => JSON.parse(readFileSync(file, "utf8"))
const mirrors = () => Object.entries(read()).filter(([id]) => id.startsWith("zcode-start#"))

async function plugin(onSet) {
  const writes = []
  const hooks = await entry.ZCodeStartAuthPlugin({
    directory, magpie: {},
    client: { auth: { set: async ({ path, body }) => {
      if (onSet) await onSet(path.id, body)
      writes.push(path.id)
      save({ ...read(), [path.id]: body })
    } } },
  })
  return { hooks, writes }
}

function serveGift() {
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options })
    if (String(url).includes("/billing/balance")) {
      const now = Math.floor(Date.now() / 1000)
      return Response.json({ code: 0, data: {
        plans: [{ plan_id: "weekend", status: "active", name: "Weekend", ends_at: now + 86400 }],
        balances: [{ plan_id: "weekend", show_name: "GLM-5.3", capabilities: ["model:GLM-5.3"],
          total_units: 100, used_units: 1, remaining_units: 99 }],
      } })
    }
    if (String(url) === URL) return Response.json({ type: "message", content: [] })
    throw new Error("unexpected vendor endpoint")
  }
  return calls
}
const request = (model = "GLM-5.3-Trial") => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: "user", content: "offline" }] }),
})

test("the installed entry exports only Start and preserves the normal provider configuration", async () => {
  save({})
  expect(Object.keys(entry)).toEqual(["ZCodeStartAuthPlugin"])
  const { hooks } = await plugin()
  expect(hooks.provider.id).toBe("zcode-start")
  expect(hooks.auth.provider).toBe("zcode-start")
  expect(hooks.auth.checkin).toBeUndefined()
  const zcode = { name: "existing Pro", options: { concurrency: 7 }, models: { paid: {} } }
  const config = { provider: { zcode } }
  const original = JSON.stringify(zcode)
  await hooks.config(config)
  expect(config.provider.zcode).toBe(zcode)
  expect(JSON.stringify(config.provider.zcode)).toBe(original)
  expect(config.provider["zcode-start"].name).toBe("ZCode Start Plan")
})

test("independent startup imports OAuth sessions without registering or writing zcode", async () => {
  const source = oauth("alice")
  const other = { type: "api", key: "other-secret" }
  save({ zcode: source, "zcode#bob": oauth("bob"), "zcode#key": { type: "api", key: "paid-only" }, unrelated: other })
  const { writes } = await plugin()
  expect(writes).toHaveLength(2)
  expect(writes.every((id) => /^zcode-start#[0-9a-f]{12}$/.test(id))).toBe(true)
  expect(read().zcode).toEqual(source)
  expect(read().unrelated).toEqual(other)
  const copy = mirrors()[0][1]
  const state = JSON.parse(copy.refresh)
  expect(copy.access).toBe("zcode-start")
  expect(state.jwt).toBeUndefined()
  expect(state.key).toBeUndefined()
  expect(state.source).toBeUndefined()
  expect(JSON.stringify(copy)).not.toContain("paid-api-key")
  expect((await plugin()).writes).toEqual([])
})

test("normal and team records for one user share one Start account; namesakes with different uids stay separate", async () => {
  const alice = oauth("alice")
  const team = { ...alice, accountId: "alice (team)" }
  const namesake = { ...oauth("bob"), accountId: alice.accountId }
  save({ zcode: alice, "zcode#team": team, "zcode#namesake": namesake })
  await plugin()
  expect(mirrors()).toHaveLength(2)
})

test("a cached Start loader follows source token renewal without creating another mirror", async () => {
  save({ zcode: oauth("alice") })
  const { hooks } = await plugin()
  const [id, old] = mirrors()[0]
  const loader = await hooks.auth.loader(async () => old, { id })
  const rotated = oauth("alice", "two")
  save({ ...read(), zcode: rotated })
  const calls = serveGift()
  const response = await loader.fetch(URL, request())
  expect(response.status).toBe(200)
  const sent = calls.find((call) => call.url === URL)
  expect(new Headers(sent.options.headers).get("authorization")).toBe("Bearer " + JSON.parse(rotated.refresh).jwt)
  expect(JSON.parse(sent.options.body).model).toBe("GLM-5.3")
  expect(calls.every((call) => call.url.startsWith("https://zcode.z.ai/"))).toBe(true)
  expect(mirrors()).toHaveLength(1)
  await plugin()
  expect(mirrors()[0][0]).toBe(id)
})

test("source logout and a different user in the same slot never reuse the old Start session", async () => {
  save({ zcode: oauth("alice") })
  const { hooks } = await plugin()
  const [id, old] = mirrors()[0]
  const loader = await hooks.auth.loader(async () => old, { id })
  for (const source of [null, oauth("bob"), { type: "api", key: "paid" }]) {
    const all = read()
    if (source) all.zcode = source
    else delete all.zcode
    save(all)
    expect(await hooks.provider.models({}, { auth: old })).toEqual({})
    expect((await hooks.auth.usage(async () => old)).error).toContain("no matching ZCode sign-in")
    await expect(loader.fetch(URL, request())).rejects.toThrow("no matching ZCode sign-in")
  }
})

test("broken auth data is preserved and blocks stale requests without a fallback read", async () => {
  save({ zcode: oauth("alice") })
  const { hooks } = await plugin()
  const [id, old] = mirrors()[0]
  const loader = await hooks.auth.loader(async () => old, { id })
  for (const text of ["{ broken", "[]", "null"]) {
    writeFileSync(file, text)
    expect((await plugin()).writes).toEqual([])
    expect(readFileSync(file, "utf8")).toBe(text)
    expect(await hooks.provider.models({}, { auth: old })).toEqual({})
    await expect(loader.fetch(URL, request())).rejects.toThrow("could not be read")
  }
})

test("legacy mirrors keep their old account keys when the independent entry replaces the bridge", async () => {
  const source = oauth("alice")
  const id = "zcode-start#" + createHash("sha256").update(JSON.stringify(source.uid)).digest("hex").slice(0, 12)
  save({ zcode: source, [id]: source })
  const { hooks, writes } = await plugin()
  expect(writes).toEqual([id])
  expect(mirrors()).toHaveLength(1)
  const calls = serveGift()
  const models = await hooks.provider.models({}, { auth: source })
  expect(Object.keys(models)).toEqual(["GLM-5.3-Trial"])
  expect(calls).toHaveLength(1)
})

test("a stable JWT subject preserves identity across renewals without a uid or display name", async () => {
  const source = oauth("alice")
  delete source.uid
  delete source.accountId
  save({ zcode: source })
  await plugin()
  const [id] = mirrors()[0]
  const rotated = oauth("alice", "two")
  delete rotated.uid
  delete rotated.accountId
  save({ ...read(), zcode: rotated })
  const { hooks } = await plugin()
  expect(mirrors().map(([key]) => key)).toEqual([id])
  const calls = serveGift()
  const loader = await hooks.auth.loader(async () => mirrors()[0][1], { id })
  expect((await loader.fetch(URL, request())).status).toBe(200)
  expect(new Headers(calls.at(-1).options.headers).get("authorization")).toBe("Bearer " + JSON.parse(rotated.refresh).jwt)
})

test("an unidentified source cannot be rebound by replacing the person in its slot", async () => {
  const source = oauth("alice")
  delete source.uid
  delete source.accountId
  source.refresh = JSON.stringify({ site: "zai", jwt: "unidentified-session" })
  save({ zcode: source })
  expect((await plugin()).writes).toEqual([])
  expect(mirrors()).toEqual([])
})

test("two sites with the same uid and two namesakes with different JWT subjects never merge", async () => {
  const first = oauth("alice")
  const otherSite = { ...first, refresh: JSON.stringify({ ...JSON.parse(first.refresh), site: "bigmodel" }) }
  const namesake = oauth("bob")
  delete first.uid
  delete namesake.uid
  namesake.accountId = first.accountId
  save({ zcode: first, "zcode#other-site": otherSite, "zcode#namesake": namesake })
  await plugin()
  expect(mirrors()).toHaveLength(3)
})

test("removing the selected login does not redirect its old Start account to a sibling login", async () => {
  const source = oauth("alice")
  save({ zcode: source, "zcode#team": { ...source, accountId: "alice (team)" } })
  const { hooks } = await plugin()
  const [id, auth] = mirrors()[0]
  const loader = await hooks.auth.loader(async () => auth, { id })
  const all = read()
  delete all.zcode
  save(all)
  await expect(loader.fetch(URL, request())).rejects.toThrow("no matching ZCode sign-in")
})

test("concurrent source deletion leaves at most a revoked reference, never another session copy", async () => {
  save({ zcode: oauth("alice") })
  const { hooks } = await plugin(async () => {
    const all = read()
    delete all.zcode
    save(all)
  })
  const [id, auth] = mirrors()[0]
  expect(auth.access).toBe("zcode-start")
  expect(JSON.parse(auth.refresh).jwt).toBeUndefined()
  await expect(hooks.auth.loader(async () => auth, { id })).rejects.toThrow("no matching ZCode sign-in")
})

test("one failed reference write does not prevent another account from loading", async () => {
  save({ zcode: oauth("alice"), "zcode#bob": oauth("bob") })
  let attempts = 0
  const { hooks } = await plugin(async () => {
    if (++attempts === 1) throw new Error("synthetic storage failure")
  })
  expect(hooks.provider.id).toBe("zcode-start")
  expect(mirrors()).toHaveLength(1)
})

test("refreshing models imports a source added after the plugin was loaded", async () => {
  save({})
  const { hooks } = await plugin()
  save({ zcode: oauth("alice") })
  expect(await hooks.provider.models({})).toEqual({})
  expect(mirrors()).toHaveLength(1)
})

test("a desktop-origin sign-in follows its own renewed session without borrowing a different desktop user", async () => {
  const seed = process.env.ZCODE_CREDENTIAL_SECRET
  process.env.ZCODE_CREDENTIAL_SECRET = "standalone-desktop-test"
  const app = join(homedir(), ".zcode", "v2")
  mkdirSync(app, { recursive: true })
  const files = ["credentials.json", "setting.json"].map((name) => join(app, name))
  const originals = files.map((path) => {
    try { return readFileSync(path) } catch { return null }
  })
  const desktop = (uid, jwt, email = `${uid}@example.test`) => {
    const encrypt = (text) => {
      const key = createHash("sha256").update("standalone-desktop-test").digest()
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv)
      const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()])
      return "enc:v1:" + [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".")
    }
    writeFileSync(files[0], JSON.stringify({
      zcodejwttoken: encrypt(jwt),
      "oauth:zai:user_info": encrypt(JSON.stringify({ id: uid, email })),
    }))
    writeFileSync(files[1], "{}")
  }
  try {
    const source = oauth("alice")
    source.refresh = JSON.stringify({ ...JSON.parse(source.refresh), source: "zcode" })
    save({ zcode: source })
    const { hooks } = await plugin()
    const [id, auth] = mirrors()[0]
    const loader = await hooks.auth.loader(async () => auth, { id })
    const renewed = JSON.parse(oauth("alice", "desktop-renewal").refresh).jwt
    desktop("alice", renewed)
    let calls = serveGift()
    expect((await loader.fetch(URL, request())).status).toBe(200)
    expect(new Headers(calls.at(-1).options.headers).get("authorization")).toBe("Bearer " + renewed)
    const other = JSON.parse(oauth("bob").refresh).jwt
    desktop("bob", other)
    calls = serveGift()
    expect((await loader.fetch(URL, request())).status).toBe(200)
    expect(new Headers(calls.at(-1).options.headers).get("authorization")).toBe("Bearer " + JSON.parse(source.refresh).jwt)
    // ZCode's user_info.id is not the core's user_id: the JWT subject must still distinguish namesakes.
    desktop("bob", other, source.accountId)
    calls = serveGift()
    expect((await loader.fetch(URL, request())).status).toBe(200)
    expect(new Headers(calls.at(-1).options.headers).get("authorization")).toBe("Bearer " + JSON.parse(source.refresh).jwt)
    desktop("unknown", "session-with-no-subject", source.accountId)
    calls = serveGift()
    expect((await loader.fetch(URL, request())).status).toBe(200)
    expect(new Headers(calls.at(-1).options.headers).get("authorization")).toBe("Bearer " + JSON.parse(source.refresh).jwt)
  } finally {
    files.forEach((path, i) => originals[i] ? writeFileSync(path, originals[i]) : rmSync(path, { force: true }))
    if (seed === undefined) delete process.env.ZCODE_CREDENTIAL_SECRET
    else process.env.ZCODE_CREDENTIAL_SECRET = seed
  }
})

test("an API key, malformed OAuth state and a similarly named provider cannot create Start accounts", async () => {
  save({ zcode: { type: "api", key: "paid" }, "zcode#bad": { type: "oauth", refresh: "null" },
    "zcode#blank": { type: "oauth", refresh: "{}" }, "zcode-other": oauth("other") })
  expect((await plugin()).writes).toEqual([])
  expect(mirrors()).toEqual([])
})

test("an unrelated damaged Start record does not prevent a valid source from being imported", async () => {
  save({ zcode: oauth("alice"), "zcode-start#damaged": null })
  const { hooks, writes } = await plugin()
  expect(hooks.provider.id).toBe("zcode-start")
  expect(writes).toHaveLength(1)
  expect(read()["zcode-start#damaged"]).toBeNull()
})

test("missing auth store does not create credentials or depend on a HOME fallback", async () => {
  const hooks = await entry.ZCodeStartAuthPlugin({ directory, magpie: {}, client: {} })
  expect(hooks.provider.id).toBe("zcode-start")
  expect(await hooks.provider.models({})).toEqual({})
  save({ zcode: oauth("alice") })
  const noRuntime = await entry.ZCodeStartAuthPlugin({ directory, client: {} })
  expect(await noRuntime.provider.models({}, { auth: oauth("alice") })).toEqual({})
})

test("a normal model is refused by the independent provider without any paid fallback", async () => {
  save({ zcode: oauth("alice") })
  const { hooks } = await plugin()
  const [id, auth] = mirrors()[0]
  const loader = await hooks.auth.loader(async () => auth, { id })
  expect((await loader.fetch(URL, request("GLM-5.3"))).status).toBe(400)
})

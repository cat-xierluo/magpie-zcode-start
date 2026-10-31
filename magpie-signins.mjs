import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { _internal } from "./zcode-core.mjs"

const SOURCE = "zcode"
const TARGET = "zcode-start"
const UNREAD = "Magpie's ZCode sign-ins could not be read; the saved accounts were kept"
const UNLINKED = "This Start account has no matching ZCode sign-in; sign in under ZCode and refresh providers"

function stateOf(auth) {
  if (auth?.type !== "oauth") return null
  try {
    const state = JSON.parse(auth.refresh)
    return state && typeof state === "object" && !Array.isArray(state) ? state : null
  } catch {
    return null
  }
}

const stable = (v) => typeof v === "string" ? v.trim()
  : typeof v === "number" && Number.isFinite(v) ? String(v) : ""

function jwtSubject(jwt) {
  try {
    return stable(JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")).sub)
  } catch {
    return ""
  }
}

function subject(auth) {
  const state = stateOf(auth)
  if (!state) return null
  const uid = stable(auth.uid) || jwtSubject(state.jwt)
  return uid ? { site: state.site === "bigmodel" ? "bigmodel" : "zai", uid } : null
}

const same = (a, b) => !!a && !!b && a.site === b.site && a.uid === b.uid

function reference(auth, key, who) {
  // Persist a reference, not another copy of the session or paid-plan credentials.
  return {
    type: "oauth",
    access: TARGET,
    refresh: JSON.stringify({ site: who.site }),
    expires: 0,
    ...(auth.accountId !== undefined ? { accountId: auth.accountId } : {}),
    uid: who.uid,
    zcodeStartSource: key,
  }
}

function startAuth(auth, who) {
  let state = stateOf(auth)
  if (state?.source === "zcode") {
    const live = _internal.ownSignIn()
    const uid = stable(live?.uid) || jwtSubject(live?.jwt)
    // A matching display name alone cannot identify the desktop's current person.
    if (same({ site: live?.site, uid }, who)) state = { ...state, ...live, device: state.device }
  }
  if (!state || typeof state.jwt !== "string" || !state.jwt.trim()) return null
  const refresh = { site: who.site, jwt: state.jwt, device: state.device }
  return { ...reference(auth, "", who), access: state.jwt, refresh: JSON.stringify(refresh) }
}

export function magpieSignIns({ client, directory, magpie } = {}) {
  const file = magpie && typeof directory === "string" && isAbsolute(directory)
    ? join(directory, "plugin-auth.json") : null

  const read = () => {
    if (!file) return null
    try {
      const all = JSON.parse(readFileSync(file, "utf8"))
      return all && typeof all === "object" && !Array.isArray(all) ? all : null
    } catch (e) {
      return e?.code === "ENOENT" ? {} : null
    }
  }

  const sources = (all) => {
    const out = []
    for (const key of Object.keys(all).sort()) {
      if (key !== SOURCE && !key.startsWith(SOURCE + "#")) continue
      const auth = all[key], state = stateOf(auth), who = subject(auth)
      if (!who || typeof state?.jwt !== "string" || !state.jwt.trim()) continue
      out.push({ key, auth, who })
    }
    return out
  }

  const report = async () => {
    try {
      await client?.app?.log?.({ body: { service: TARGET, level: "error",
        message: "A Start account could not be synchronized; its source ZCode account was kept" } })
    } catch {}
  }

  return {
    async sync() {
      const all = read()
      if (!all || typeof client?.auth?.set !== "function") return
      const seen = new Set()
      const saved = Object.entries(all).filter(([id, auth]) => id.startsWith(TARGET + "#") && subject(auth))
      const bound = (s) => saved.some(([, a]) => a.zcodeStartSource === s.key && same(subject(a), s.who))
      const ordered = sources(all).sort((a, b) => Number(bound(b)) - Number(bound(a)))
      for (const { key, auth, who } of ordered) {
        const group = JSON.stringify(who)
        if (seen.has(group)) continue
        seen.add(group)
        const legacy = saved.find(([, a]) => same(subject(a), who)
          && (!a.zcodeStartSource || a.zcodeStartSource === key))
        const id = legacy?.[0] ?? TARGET + "#" + createHash("sha256")
          .update(JSON.stringify({ ...who, key })).digest("hex").slice(0, 12)
        const next = reference(auth, key, who)
        const fresh = read()
        if (!fresh || JSON.stringify(fresh[key]) !== JSON.stringify(auth)) continue
        if (JSON.stringify(fresh[id]) === JSON.stringify(next)) continue
        try {
          await client.auth.set({ path: { id }, body: next })
        } catch {
          await report()
        }
      }
    },
    current(auth) {
      if (!auth) return auth
      const all = read()
      if (!all) throw new Error(UNREAD)
      const who = subject(auth)
      const candidates = sources(all).filter((s) => same(s.who, who))
      const found = auth.zcodeStartSource
        ? candidates.find((s) => s.key === auth.zcodeStartSource)
        : candidates.length === 1 ? candidates[0] : null
      const resolved = found && startAuth(found.auth, found.who)
      if (!resolved) throw new Error(UNLINKED)
      return resolved
    },
  }
}

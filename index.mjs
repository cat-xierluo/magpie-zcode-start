import { ZCodeStartAuthPlugin as startProvider } from "./zcode-core.mjs"
import { magpieSignIns } from "./magpie-signins.mjs"

export async function ZCodeStartAuthPlugin(input, options = {}) {
  const signIns = magpieSignIns(input)
  await signIns.sync()
  const hooks = await startProvider(input, options)
  const models = hooks.provider.models
  const loader = hooks.auth.loader
  const usage = hooks.auth.usage

  hooks.provider.models = async (provider, context = {}) => {
    await signIns.sync()
    let auth
    try {
      auth = signIns.current(context.auth)
    } catch {
      return {}
    }
    return models(provider, { ...context, auth })
  }
  hooks.auth.loader = (getAuth, provider) =>
    loader(async () => signIns.current(await getAuth()), provider)
  hooks.auth.usage = async (getAuth, provider) => {
    let auth
    try {
      auth = signIns.current(await getAuth())
    } catch (e) {
      return { error: e.message, signIn: "kept" }
    }
    return usage(async () => auth, provider)
  }
  return hooks
}

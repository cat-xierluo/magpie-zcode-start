# magpie-zcode-start

An unofficial [Magpie](https://usemagpie.ai) provider plugin for ZCode Coding
Plan accounts. It exposes live ZCode Start Plan / gift allowances as a separate
`zcode-start` provider lane instead of treating them as an incidental ZCode
subscription option.

The repository carries the `magpie-plugin` GitHub topic and therefore appears in
Magpie under **Plugins → Discover → Unofficial, on GitHub**. It is not reviewed
by Magpie or ZCode; install it only if you are comfortable reviewing third-party
plugin code.

## What it provides

- `zcode-start`: the product lane. It lists only active `<model>-Trial`
  allowances, so a normal paid model is not accidentally sent to a Start Plan
  bucket. It has its own provider id, rest key, account selection, queue, and
  concurrency settings in Magpie.
- `zcode`: a compatibility and sign-in bridge to the official ZCode provider
  behavior. It is retained because `zcode-start` mirrors OAuth sign-ins from
  `zcode`; the current Magpie plugin API does not let a provider enumerate and
  import another provider's accounts directly.

You can keep your existing official ZCode plugin as the permanent `zcode`
provider. This package only needs to serve `zcode` briefly while accounts are
mirrored into `zcode-start`.

## Install

From Magpie's Unofficial list, or directly:

```sh
magpie plugin add github:cat-xierluo/magpie-zcode-start
```

### Reuse an existing ZCode sign-in

Magpie stores sign-ins by provider id, so `zcode-start` cannot silently read a
sign-in stored under `zcode`. The package therefore mirrors each OAuth account
when its `zcode` provider hook reads models or usage.

If you already use the official community ZCode plugin:

1. Install this package. Magpie will report that both plugins provide `zcode`.
2. Temporarily choose this package as the provider for `zcode`, then refresh
   models or usage. This creates stable `zcode-start#...` account mirrors.
3. Switch `zcode` back to your official plugin with **Use for** in Magpie, or
   with `magpie plugin use <official-plugin> zcode`.
4. Keep this package serving `zcode-start`, and add its
   `zcode-start/<model>-Trial` entries to a routing group when you want Start
   allowance to be scheduled independently.

Run `magpie plugin list` at any time to confirm which installed package serves
each provider id.

## Scheduling boundary

The intended use is a routing group that deliberately includes `zcode-start`
members, for example a Start Trial model before paid ZCode or another provider.
Magpie owns account ordering, group ordering, rest behavior, and concurrency.
The plugin declares Magpie's normal default queue (`3`); adjust per-account or
per-provider concurrency in Magpie rather than expecting this plugin to enforce
a vendor tier limit.

The plugin does not bypass ZCode limits, does not claim a paid plan, and does
not send normal `zcode` requests through a Start Plan bucket. A `zcode-start`
request that is not a live `-Trial` model is rejected locally.

## Sign-in and privacy

Browser sign-ins and mirrored credentials are stored in Magpie's plugin auth
store. The plugin does not commit credentials, does not read your real `HOME`
during tests, and does not write ZCode's own credential store except through the
documented provider APIs.

Tests use synthetic responses only:

```sh
npm test
```

The check creates an isolated temporary `HOME` and then runs the Bun test suite.

## License

MIT. This project is independently maintained and is not affiliated with
Magpie, Z.ai, BigModel, or ZCode.

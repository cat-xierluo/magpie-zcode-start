# Changelog

## [0.3.0] - 2026-10-31

- Register only `zcode-start`; the regular `zcode` provider remains with its existing plugin.
- Reuse Magpie's existing ZCode OAuth accounts through identity-bound references, without copying JWTs or paid-plan API keys.
- Read renewed sessions from their source and stop using an account after its source is removed or changes identity.
- Validate desktop-origin renewal against both the site and stable user identity.
- Keep inherited MIT code and commit history, with the compatibility implementation in an internal module and attribution in NOTICE.
- Verify 221 offline tests and actual Magpie loading under an isolated HOME.

## [0.2.0] - 2026-10-31

- Publish the independent repository for Magpie's unofficial GitHub discovery.
- Expose a separate Start Plan provider alongside the original ZCode compatibility provider.
- Include upstream marketing/touch gift-plan discovery fixes.

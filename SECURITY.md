# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub: open the [Security tab](https://github.com/remymazmanian/ableton-control-deck/security) and choose **Report a vulnerability**. Don't open a public issue for a vulnerability.

Include your macOS, Live and Node.js versions, what you found and, if you can, steps that reproduce it. You'll get a reply within a few days, and fixes are released as soon as they're ready.

## Supported versions

Security fixes go into the latest release.

## Scope

Especially welcome:

- ways to reach the Live bridge (UDP 50711), the status service, the dashboard or OmniHost from another machine, or without the per-install secret in `data/bridge-token`
- ways around the Live API allowlist or the exact-target safeguards, such as changing a different track, device or parameter than the one named
- anything that makes the installer, the remote script or the sample indexer write outside its own folders

Problems in Ableton Live or third-party plug-ins themselves should go to their makers.

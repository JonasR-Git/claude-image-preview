# Security policy

## Supported versions

Only the latest release gets fixes. Update with `claude plugin update image-preview@jonasr-plugins`.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through
[GitHub's private vulnerability reporting](https://github.com/JonasR-Git/claude-image-preview/security/advisories/new)
with the steps to reproduce it, the platform and terminal, and the plugin and Claude Code versions
(`/image-preview status` names both).

You get an answer within a week. Once a fix is released, the advisory is published with credit to you, unless
you prefer otherwise.

## What the plugin does on your machine

The [Privacy and security](README.md#privacy-and-security) section of the README lists what the plugin reads,
writes and starts. In short: it makes no network requests, runs only programs that come with the system or that
you installed (PowerShell, `osascript`, `sips`, clipboard tools, converters), passes file paths as arguments and
never through a shell string, and on Windows runs one helper per session that reads the terminal's characters
and lays the pictures over it.

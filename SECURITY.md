# Security

DialCatz runs on your Mac with access to things that matter — it keeps your API collections, environment secrets and the tokens of your team's Den, and sends requests and runs scripts on your behalf. A security problem in it is taken seriously.

## Reporting a vulnerability

**Please do not open a public issue.** Report it privately instead:

1. Open the repository's **Security** tab → **Report a vulnerability**
   ([direct link](https://github.com/catzoidhub/DialCatz/security/advisories/new)). Only the maintainer sees it.
2. Say what is affected, how to reproduce it, and what an attacker could do with it. A proof of concept helps.

Security reports are read before anything else, as soon as the maintainer can — there is no fixed response time yet.
Together we agree on a fix and when to publish it; you are credited in the advisory and the release notes unless you
would rather not be.

## What is in scope

- The DialCatz app and its updater (the update feed and the downloaded update are checked before they install).
- Anything that would let a web page, another app or a crafted file make DialCatz do something you did not ask for —
  deep links (`dialcatz://`), imported files, the local services it runs.
- Secrets leaving your Mac: environment variable values (they never sync to a Den), Den device tokens, auth credentials saved on requests, the AI key in the "Catzoid AI" Keychain item.
- Pre-request and test scripts — anything that lets a script escape its sandbox or read what it should not.
- Talking to a DialCatz Den — anything that lets one member act as another or reach a workspace their token does not allow (server-side problems go to [DialCatz Den](https://github.com/catzoidhub/DialCatz-Den/security/advisories/new)).

Out of scope: problems that need someone who already controls your Mac or your user account, and vulnerabilities in
third-party software DialCatz installs or talks to (report those upstream — we are happy to help).

## Supported versions

Only the **latest release** gets security fixes; the app updates itself, so please stay on it.

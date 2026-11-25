# DialCatz CLI

Run [DialCatz](https://github.com/catzoidhub/DialCatz) collections from a terminal or a CI job, without the app: every request with its scripts and tests, and with `--spec` each response checked against your OpenAPI contract.

```bash
npx dialcatz run ./api-workspace --var baseUrl=https://staging.example.com --env-file .env.ci
npx dialcatz run shop.postman_collection.json -r cli -r junit=results.xml -r html=report.html
npx dialcatz run openapi.yaml --spec openapi.yaml --var baseUrl=http://localhost:3000
```

Node 20 or later. It exits 0 when everything passed, 1 when a request or a test failed, 2 when it could not start.

## What it runs

`dialcatz run <path>` takes a DialCatz workspace folder (the one with `dialcatz.yml`, kept in your repository), a collection exported from DialCatz or Postman, or an OpenAPI / Swagger file.

- **Requests** run in the order DialCatz's runner takes them, with their pre-request and test scripts (`dc.*` and the Postman-compatible `pm.*`) and the auth they inherit.
- **HTTP** in every body (JSON, form, multipart, binary, GraphQL, JSON-RPC), Server-Sent Events and **gRPC** (server reflection or `--proto` files).
- **WebSocket, Socket.IO and Pusher** requests connect, send the first message kept with the request, listen for `--ws-wait` seconds and hand what arrived to the tests as `dc.messages`.
- **OAuth 2.0**: client credentials and password grants get their token by themselves; a device code sign-in is asked for when a person is at the terminal.

## Options

| Option | |
|---|---|
| `-c, --collection <name>` | only this collection (a workspace folder may hold several) |
| `-f, --folder <name>` | only the requests under this folder, or one request of this name |
| `-v, --var <name=value>` | a variable's value; repeat for more |
| `--env-file <file>` | variables from `NAME=value` lines (a `.env` file) |
| `-d, --data <file>` | run once per row of a CSV (header row) or a JSON array of objects |
| `--file <field=path>` | the file for a multipart field, or `body=<path>` for a binary body |
| `--spec <file>` | check every response against this OpenAPI file (status, content type, body schema) |
| `--proto <file>` | `.proto` files for gRPC servers without reflection |
| `--ws-wait <seconds>` | how long a WebSocket request listens (default 2) |
| `--cert`, `--key`, `--pfx` | a client certificate (mutual TLS); the passphrase from `--passphrase` or `DIALCATZ_CERT_PASSPHRASE`; `--cert-host` limits it to one host |
| `--bail` | stop at the first failure |
| `--insecure` | skip TLS certificate checks |
| `--timeout <seconds>` | per request (default 30) |
| `--retries <n>`, `--retry-delay <s>` | try a failed request again, up to n times (default 0), waiting s seconds (default 1) |
| `-r, --reporter <kind>` | `cli` (default), `github`, `html`, `json` or `junit`; repeat for more than one; `html=report.html` says where it goes |
| `-o, --output <file>` | where the report is written |
| `--details` | the HTML report also holds headers and bodies, credentials hidden |
| `--no-github` | no GitHub summary by itself on GitHub Actions |
| `--verbose` | passed tests and script logs too |

## Variables and secrets

A `{{name}}` takes its value from `--var`, then `--env-file`, then an environment variable of the same name, then what the file itself defines (an OpenAPI server as `baseUrl`, a Postman collection's variables). Workspace folders never hold values, so secrets come from your CI's secret store. A variable without a value fails its request before anything is sent.

Reports hide the values of variables named like a secret (token, key, password …), generated-looking values, OAuth tokens, a login answer's tokens, and credential headers and query parameters. What a script logs on the terminal is yours to keep clean.

A request fails when it gets no answer, one of its tests fails, or its response does not match `--spec`. Without tests, an error 500 is an answer too.

## In CI

The app writes the workflow for you: a collection's menu → **Run in CI…** By hand, on GitHub Actions (the run's page gets a summary and an error per failed request):

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 22 }
- run: npx --yes dialcatz@1 run ./api-workspace --spec openapi.yaml --retries 1 -r cli -r github -r html=report.html
  env:
    baseUrl: https://staging.example.com
    clientSecret: ${{ secrets.API_CLIENT_SECRET }}
```

or with the [DialCatz action](https://github.com/catzoidhub/DialCatz-Action). On GitLab CI, `-r junit=results.xml` as `artifacts: reports: junit`.

GPL-3.0-only. Part of [Catzoid](https://catzoid.com).

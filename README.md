# Maintenance Manager

Control maintenance mode and HTTP Basic Auth per hostname from a dashboard. A Cloudflare Worker handles incoming requests, and a SQLite-backed Durable Object stores the live settings and the change history for each hostname. The dashboard shows the latest 50 changes.

## Architecture

```text
              Visitor                                Operator
                  │ app.example.com                      │ admin login
                  │ app-preview.example.com              │
                  ▼                                      ▼
┌───────────────────────────────────┐  ┌───────────────────────────────────┐
│ Cloudflare Worker routes          │  │ Dashboard and API                 │
│ hostname/* runs the manager       │  │ maintenance.example.com           │
└─────────────────┬─────────────────┘  └─────────────────┬─────────────────┘
                  │                                      │
                  ▼                                      ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                        maintenance-manager Worker                        │
│                                                                          │
│ find the domain  →  read its policy  →  decide:                          │
│   managed off or allowed IP   → forward to the app                       │
│   maintenance on              → maintenance page, HTTP 503               │
│   Basic Auth on, or preview   → ask for the login                        │
│ dashboard requests  →  save settings, add or remove domains              │
└────────┬──────────────────┬──────────────────┬──────────────────┬────────┘
         │                  │                  │                  │
         ▼                  ▼                  ▼                  ▼
┌────────────────┐ ┌────────────────┐ ┌────────────────┐ ┌─────────────────┐
│ DomainRegistry │ │  DomainPolicy  │ │  App Workers   │ │  Cloudflare API │
│  domain list   │ │ one per domain │ │  via service   │ │    routes and   │
│   one object   │ │ settings, IPs  │ │    bindings    │ │   preview DNS   │
└────────────────┘ └────────────────┘ └────────────────┘ └─────────────────┘
```

| Part | Role |
| --- | --- |
| Worker routes | A route such as `app.example.com/*` runs the manager before the app Worker's own custom domain. |
| maintenance-manager | Checks every request, serves the maintenance page or asks for a login when needed, and forwards allowed requests. It also serves the dashboard on the admin hostname. |
| DomainRegistry | One SQLite-backed Durable Object that stores the domain list: hostnames, aliases, previews and app Workers. |
| DomainPolicy | One SQLite-backed Durable Object per domain that stores its live settings, the preview login digest, allowed IPs and change history. Each change and its history entry are saved together. |
| Service bindings | Fixed connections to the app Workers, set at deploy time with `npm run app:add`. |
| Cloudflare API | Used only by the dashboard, with a token limited to routes and DNS in your zones. It never changes Worker code. |

How a public request is handled:

1. Cloudflare matches the route and runs the manager.
2. The manager finds the domain for the hostname, including aliases.
3. It applies the domain's policy in this order:
   - **Managed off:** the request goes to the app.
   - **Allowed IP:** the request goes to the app.
   - **Maintenance on:** the visitor gets the maintenance page with HTTP `503`.
   - **Basic Auth on:** the visitor must sign in. The manager removes the login header before forwarding.
4. The manager forwards the request to the app Worker, which sees the original hostname.

Preview hostnames always require the login and skip maintenance, so you can check a release while the public site shows the maintenance page.

## Requirements

- A Cloudflare account. The free plan works.
- A domain whose DNS is on Cloudflare. If it is registered elsewhere, change its nameservers to Cloudflare; you can keep the registrar. Worker routes only work on Cloudflare-proxied zones.
- Apps that run as Cloudflare Workers. The manager forwards requests to them through service bindings.
- Node.js 22 or later.

## Try it locally

```sh
npm ci
cp .env.example .env
npm run dev
```

The project uses two env files, both ignored by Git:

| File | Used by | Contents |
| --- | --- | --- |
| `.env` | `npm run dev` only, never uploaded | Throwaway local logins |
| `.env.production` | `wrangler secret bulk`, only when you run it | Real logins and the Cloudflare API token |

Keep them separate so local testing never uses real passwords or changes real Cloudflare routes.

| Local hostname | Access |
| --- | --- |
| `http://localhost:8787` | Admin dashboard. Use `admin` / `local-admin`. |
| `http://app.localhost:8787` | Demo app with the public policy applied. |
| `http://preview.localhost:8787` | Protected preview. Use `preview` / `local-preview` until you save a different login in the dashboard. The same login applies if you enable Basic Auth on the public hostname. |

Change settings in the dashboard and select **Save changes**. Reload the public app to check the new policy. Public maintenance takes precedence over the public Basic Auth switch and returns HTTP `503`. The preview remains protected and available during maintenance. The values in `.env.example` are local test credentials. To reset local settings, logins and history, stop the server and delete `.wrangler/state`.

```sh
npm test
npm run check
```

The runtime test exercises request forwarding against another Worker and uses a real SQLite-backed Durable Object. `npm run check` bundles the Worker and assets with Wrangler’s dry-run deployment.

## Deploy to one test subdomain

1. Choose a test app Worker and two hostnames in your Cloudflare zone: one for the public app and one for the dashboard. Attach the public hostname to the **app Worker** as a custom domain first.
2. Copy `wrangler.production.example.jsonc` to `wrangler.production.jsonc`. Set the dashboard hostname in `routes` and `ADMIN_HOST`, your zone in `ZONES`, and the app Worker in `services` and `APPS`. `DOMAINS` is empty, so the manager starts with no managed domains and you add them in the dashboard. Optionally, list domains in `DOMAINS` to seed the list. It is read only the first time the manager runs. After that, the dashboard owns the list, and editing `DOMAINS` has no effect.
3. Copy `.env.production.example` to `.env.production` and set separate, unique credentials. Each value must use the `username:password` form, or the gateway treats it as unavailable and returns `503`. Generate long passwords, for example with `openssl rand -base64 24`, and keep a copy in a password manager. Git ignores `.env.production`.

```sh
cp .env.production.example .env.production
```

```dotenv
ADMIN_BASIC=admin-user:long-random-admin-password
APP_BASIC=preview:different-long-random-password
CLOUDFLARE_API_TOKEN=scoped-api-token
```

The dashboard uses `CLOUDFLARE_API_TOKEN` to create and delete the routes and preview DNS records for each domain. In the Cloudflare dashboard, open **My Profile > API Tokens > Create Token > Create Custom Token** and grant only these permissions:

| Permission | Access |
| --- | --- |
| Zone > Zone | Read |
| Zone > Workers Routes | Edit |
| Zone > DNS | Edit |

Under **Zone Resources**, include only the specific zones in `ZONES`. The token cannot change Worker code or other zones. Without it, the dashboard still manages settings, but Add, Remove and Connect are unavailable.

4. Sign in to Wrangler, deploy the manager, and upload the credentials. Then open the dashboard and select **Add domain**. If you seeded `DOMAINS`, select **Connect all** instead to create their routes.

```sh
npx wrangler login
npx wrangler deploy --config wrangler.production.jsonc
npx wrangler secret bulk .env.production --config wrangler.production.jsonc
```

Secrets apply to the live Worker immediately, and later deployments keep them. To change a secret, edit `.env.production` and run `secret bulk` again. Editing the file alone has no effect. Use `ADMIN_BASIC` to sign in to the dashboard and `APP_BASIC` for the preview hostname until you set a preview login in the dashboard. If the browser offers an old saved login, update or remove it. You can also run `npx wrangler deploy --config wrangler.production.jsonc --secrets-file .env.production` to deploy and upload in one step.

`.env` serves only `npm run dev` and is never uploaded. `.env.production` is used only when you upload it.

Check the app, preview, and dashboard before onboarding a production hostname. Keep any direct app hostnames, including the app Worker’s own `workers.dev` or preview URLs, private, disabled, or covered by the same policy. Confirm that the preview works with the app’s redirects, cookies, and asset URLs. The gateway removes its Basic Auth header before forwarding. For apps that use bearer tokens in `Authorization`, use a separate Basic Auth preview for browser checks and leave the public Basic Auth switch off for that API. Already-open connections and responses served from browser caches may continue after a switch.

## Manage domains

**Add domain** creates the routes for the hostname and its aliases, and for the optional preview hostname. It also adds an AAAA `100::` DNS record for the preview, labeled `Managed by maintenance-manager`. The preview defaults to `<name>-preview.<zone>`, or `preview.<zone>` for the zone apex. If any step fails, the dashboard undoes the changes it made. If another Worker already owns one of the routes, the dashboard stops without changing it. Keep the app Worker's own custom domain for each public hostname, because the manager's route sits in front of it.

**Remove** is in the domain's **Manage** dialog. Type the hostname to confirm. The dashboard deletes this Worker's routes for the domain and the preview DNS record it created, then removes the domain from the list. The site keeps running on the app Worker. It leaves records it did not create, such as a Worker custom domain, and reports them. The domain's settings and history remain stored and return if you add it again. The release domain cannot be removed while `RELEASE_DOMAIN` points to it.

**Connect** recreates any missing routes, for example after the first deploy or after a route is deleted in Cloudflare. The domain list marks domains whose routes are missing, and **Connect all** fixes them together.

The domain list offers only app Workers that the manager has a service binding for. Service bindings are fixed at deploy time, so connect a new app Worker from the terminal first:

```sh
npm run app:add -- blog-app --deploy
```

`npm run app:remove -- blog-app --deploy` disconnects one. Remove its domains in the dashboard first. The script rewrites the config as plain JSON, so comments in it are removed.

Everything else happens in the **Manage** dialog and applies without a deploy:

- **Preview login.** Set a username and a password of at least 16 characters, or select **Generate**. The login protects the preview hostname and public Basic Auth. Only a salted digest is stored, so copy the password before saving. History records the username, never the password. A dashboard login replaces the domain's `credential` secret. The `credential` setting is optional for new domains.
- **Allowed IPs.** Visitors from listed addresses skip the maintenance page and Basic Auth on the public hostname and its aliases. Add single IPv4 or IPv6 addresses or ranges such as `198.51.100.0/24`, each with an optional label. You can also select **Add my current IP**, paste a list with one address per line, or copy a list to other domains. Each domain allows up to 200 entries. To prevent accidental exposure, ranges broader than `/8` for IPv4 or `/32` for IPv6 are rejected. History records each addition and removal. The preview hostname still requires its login.
- **Managed.** Turn this off to send the domain and its aliases straight to the app with no maintenance page or Basic Auth, while keeping it listed. The preview stays protected. Turn it on again to restore the saved settings.

Aliases share the primary hostname's settings and history, and the app receives requests under the alias hostname.

## API and release automation

Use the admin hostname and admin Basic Auth for the following endpoints.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/domains` | List managed domains with their aliases, preview and app Worker. |
| `POST /api/domains` | Add a domain and create its routes. Send `{"hostname":"blog.example.com","service":"BLOG_APP","aliases":[],"preview":"blog-preview.example.com"}`. Set `preview` to `null` to skip it. |
| `DELETE /api/domains/<hostname>` | Delete the domain's routes and its managed preview DNS record, then remove it from the list. |
| `POST /api/domains/<hostname>/connect` | Create any missing routes for the domain. |
| `GET /api/route-status` | Report which domains have all their routes. |
| `GET /api/apps` | List the app Workers that domains can use, and whether the Cloudflare API token is set. |
| `GET /api/domains/<hostname>` | Get the policy and its current revision. |
| `PATCH /api/domains/<hostname>` | Update one or more policy fields. Send JSON and optionally `If-Match: "<revision>"` to reject conflicting edits. |
| `PUT /api/domains/<hostname>/login` | Set the preview login. Send JSON with `username` and `password`. |
| `PUT /api/domains/<hostname>/allowlist` | Replace the allowed IPs. Send `{"entries":[{"ip":"203.0.113.7","label":"Office"}]}` and optionally `If-Match`. |
| `GET /api/client-ip` | Get your current address and the suggested entry for it. IPv6 suggestions use the address's `/64` network. |
| `GET /api/domains/<hostname>/audit` | Get the latest policy changes. |

Policy fields are `managed`, `maintenanceEnabled`, `basicAuthEnabled`, `maintenanceMessage`, and `retryAfterAt`. Responses also include `allowlist`, `login` (username and change time, or `null`), and `loginSource` (`dashboard`, `secret`, or `none`). Send the recovery estimate in UTC ISO format with milliseconds, such as `2027-01-15T18:30:00.000Z`, or send `null` to clear it. A recovery estimate sets a `Retry-After` header while the estimate is in the future. The operator or release job explicitly reopens the site.

For automation, add `"RELEASE_DOMAIN": "<hostname>"` to `vars`, add a separate `RELEASE_TOKEN` line to `.env.production`, then run `secret bulk` again. The token can only set `maintenanceEnabled` for that domain. Store the token in your CI secret store and send this request before deploying.

```sh
curl --fail-with-body --silent --show-error \
  --request PATCH \
  --header "Authorization: Bearer ${RELEASE_TOKEN}" \
  --header 'Content-Type: application/json' \
  --data '{"maintenanceEnabled":true}' \
  "https://maintenance.example.com/api/domains/test.example.com"
```

After deploying, verify the release through the protected preview. Send the same request with `false` after the check passes. If the check fails, leave maintenance enabled until a verified rollback or fix. Repeating the same setting leaves the policy and history unchanged.

## License

[MIT](LICENSE)

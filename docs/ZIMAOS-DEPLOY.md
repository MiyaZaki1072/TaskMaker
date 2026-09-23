# Deploying Problem Studio on ZimaOS

Everything the deployment needs is in this repository:
`Dockerfile`, `docker-compose.yml`, `.env.example`.

The stack is two containers:

| Container | What it is | Durable? |
| --- | --- | --- |
| `app` | the studio itself (Express + Chromium for PDF export) | no — rebuilt from the image every time |
| `db` | Postgres 16 | **yes** — the `studio-db` volume is the only thing to back up |

Problems and images live in Postgres. The copy on the `app` container's filesystem is scratch
space that is rebuilt from the database on every boot, which is why restarting or updating the
studio never loses anything.

---

## 1. Check your architecture

Not needed for the install — the image builds for whatever the box is — but useful to know:

```sh
uname -m
```

`x86_64` is a ZimaBoard/ZimaCube or mini-PC; `aarch64` is ARM. Both work.

## 2. Get the files onto the box

SSH into ZimaOS, then:

```sh
git clone <this repo> /DATA/AppData/problem-studio
cd /DATA/AppData/problem-studio
```

`/DATA/AppData/` is where ZimaOS keeps app data, so the checkout survives ZimaOS updates. Any
path works.

## 3. Set the two passwords

```sh
cp .env.example .env
nano .env
```

Fill in:

```
STUDIO_PASSWORD=<the password you will type to sign in>
POSTGRES_PASSWORD=<a long random string you never type>
PUBLIC_ORIGIN=https://studio.rywcc.org
```

Generate them with:

```sh
openssl rand -base64 24   # STUDIO_PASSWORD — the one you type
openssl rand -hex 24      # POSTGRES_PASSWORD — hex, see below
```

`POSTGRES_PASSWORD` must be hex rather than base64. `docker-compose.yml` builds the connection
string by pasting it into `postgres://studio:<password>@db:5432/studio`, and base64 output
contains `/` and `+`, which terminate the userinfo part of a URL early. The failure looks like the
app cannot find the database host, so it is an annoying one to diagnose.

`PUBLIC_ORIGIN` is your real public URL — it is what lets the studio reject form posts coming from
other sites.

## 4. Start it

```sh
docker compose up -d --build
```

The first build takes a few minutes (it installs Chromium and Thai fonts). After that:

```sh
docker compose ps          # both containers should be "healthy"
docker compose logs -f app # should end with "Problem Studio is listening on 0.0.0.0:4322"
```

Open `http://<box-ip>:4322` — you should get the login page.

## 5. Point the Cloudflare tunnel at it

In the Cloudflare Zero Trust dashboard, add a public hostname to your tunnel:

| Field | Value |
| --- | --- |
| Subdomain | e.g. `studio` |
| Domain | `rywcc.org` |
| Service type | HTTP |
| URL | `<box-ip>:4322` |

If `cloudflared` runs as a container on the same box, `http://<box-ip>:4322` still works because
the port is published on all interfaces. To keep it off the LAN entirely, set
`STUDIO_BIND=127.0.0.1` in `.env` — but only if `cloudflared` runs on the host, not in its own
container, since a container cannot reach another container's loopback.

## 6. Add the tile to ZimaOS (optional)

ZimaOS → Apps → **Install a customized app** → **Import** `docker-compose.yml`. The `x-casaos`
block in that file supplies the title, icon and "open" link. The stack is already running from
step 4; importing only gives it a tile on the dashboard.

---

## Day-to-day

```sh
# Update after pulling new code
git pull && docker compose up -d --build

# Back up (this is the only thing worth backing up)
docker compose exec -T db pg_dump -U studio studio > backup-$(date +%F).sql

# Restore into a new stack: start only the database, restore, then start the studio.
# If the studio boots first it initialises the empty database itself, and the restore then
# collides with those rows instead of filling the tables.
docker compose up -d --wait db
docker compose exec -T db psql -U studio -d studio < backup-2026-09-21.sql
docker compose up -d

# Change the studio password — this also signs everyone out, by design
nano .env && docker compose up -d
```

---

## When something is wrong

**The login page appears again after typing the right password.**
The session cookie is being dropped. It is marked `Secure`, so the browser refuses it on a plain
`http://` page. Either reach the studio through the HTTPS tunnel, or set `SECURE_COOKIES=0` in
`.env` and `docker compose up -d` if you genuinely want to use it over HTTP on the LAN.

**PDF export fails, or the PDF is full of empty boxes where Thai text should be.**
Empty boxes mean the Thai fonts are missing from the image — rebuild with
`docker compose build --no-cache app`. For a failure to launch at all:

```sh
docker compose exec app ls -l /usr/bin/chromium   # must exist
docker compose logs app | grep -i chromium
```

**`docker compose ps` shows `app` as unhealthy.**
The health probe (`/healthz`) reports the database as unreachable. Check `docker compose logs db`,
and that `POSTGRES_PASSWORD` in `.env` matches what the volume was first created with — changing
that value after the fact does **not** change the password inside an existing volume.

**"Studio is not configured: set STUDIO_PASSWORD".**
`.env` is missing, empty, or not next to `docker-compose.yml`. The app refuses to serve without a
password rather than exposing every problem to anyone who finds the URL.

**Too many sign-in attempts.**
Ten failures in fifteen minutes per IP. Wait it out, or `docker compose restart app` to clear the
counter.

---

## Configuration reference

Everything below is set in `.env` and read by `docker-compose.yml`.

| Variable | Default | What it does |
| --- | --- | --- |
| `STUDIO_PASSWORD` | *(required)* | The password on the login page |
| `POSTGRES_PASSWORD` | *(required)* | Postgres password; only reachable inside the Docker network |
| `PUBLIC_ORIGIN` | *(unset)* | Your public URL — used to reject cross-site form posts |
| `STUDIO_BIND` | `0.0.0.0` | Which host interface to publish the port on |
| `STUDIO_PORT` | `4322` | Host port |
| `SECURE_COOKIES` | `1` | Set `0` only when serving over plain HTTP |
| `TRUST_PROXY` | `1` | Proxy hops in front of the app (1 = cloudflared) |
| `SESSION_SECRET` | *(auto)* | Generated once and kept in Postgres; set it only to force everyone out |
| `SESSION_TTL_HOURS` | `720` | How long a login lasts (30 days) |
| `POSTGRES_USER` / `POSTGRES_DB` | `studio` | Database user and name |

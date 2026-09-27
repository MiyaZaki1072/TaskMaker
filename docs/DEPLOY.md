# Deploying Problem Studio with Docker

This guide runs the studio on any Linux machine with Docker — a VPS, a home server, a NAS, a
Raspberry Pi. Everything it needs is in this repository: `Dockerfile`, `docker-compose.yml` and
`.env.example`.

The stack is two containers:

| Container | What it is | Durable? |
| --- | --- | --- |
| `app` | the studio itself (Express + Chromium for PDF export) | no — rebuilt from the image every time |
| `db` | Postgres 16 | **yes** — the `studio-db` volume is the only thing to back up |

Problems and images live in Postgres. The copy on the `app` container's filesystem is scratch
space that is rebuilt from the database on every boot, which is why restarting or updating the
studio never loses anything. Postgres is never published outside Docker's private network — the
only way to the data is through the studio.

---

## 1. Requirements

- **Linux, x86_64 or ARM64.** The image builds for whatever machine it is built on (`uname -m`
  prints `x86_64` or `aarch64`; both work).
- **Docker Engine with the Compose plugin.** Install it from your distribution's packages or by
  following <https://docs.docker.com/engine/install/>, then check:

  ```sh
  docker compose version
  ```

  If that fails with a permission error, either prefix the commands below with `sudo` or add
  yourself to the `docker` group (`sudo usermod -aG docker $USER`, then log out and back in).
- **Git**, to fetch the code.

## 2. Get the code

```sh
git clone https://github.com/MiyaZaki1072/RYWCC-Task-Maker.git problem-studio
cd problem-studio
```

Any directory works — `/opt/problem-studio` or your home directory are common choices. Every
command below runs from inside it.

## 3. Set the passwords

```sh
cp .env.example .env
nano .env        # or any editor
```

Fill in at least these two:

```sh
STUDIO_PASSWORD=     # the password you will type on the sign-in page
POSTGRES_PASSWORD=   # a long random string you never type
```

Generate them with:

```sh
openssl rand -base64 24   # STUDIO_PASSWORD
openssl rand -hex 24      # POSTGRES_PASSWORD — must be hex, see below
```

**`POSTGRES_PASSWORD` must be hex, not base64.** `docker-compose.yml` builds the connection string
by pasting it into `postgres://studio:<password>@db:5432/studio`, and base64 output contains `/`
and `+`, which end that part of a URL early. The resulting error blames the database *host*, not
the password, so it is an annoying one to track down.

`.env` is gitignored and never copied into the image. Keep it readable only by you:
`chmod 600 .env`.

## 4. Start it

```sh
docker compose up -d --build
```

The first build takes a few minutes — it installs Chromium and the Thai fonts into the image. Later
builds reuse that layer and take seconds. Then check:

```sh
docker compose ps          # both containers should become "healthy"
docker compose logs -f app # should end with "Problem Studio is listening on 0.0.0.0:4322"
```

Both containers restart automatically after a crash or a reboot (`restart: unless-stopped`), as
long as the Docker service itself starts on boot — it does by default on most distributions
(`sudo systemctl enable docker` if not).

## 5. Make it reachable

The studio listens on port `4322`. How people reach it decides a few settings in `.env`, so pick
the case that matches yours:

| You reach it through… | `STUDIO_BIND` | `SECURE_COOKIES` | `TRUST_PROXY` | `PUBLIC_ORIGIN` |
| --- | --- | --- | --- | --- |
| **A. A reverse proxy with HTTPS** on the same machine (recommended) | `127.0.0.1` | `1` | `1` | your `https://` URL |
| **B. A Cloudflare Tunnel** | see below | `1` | `1` | your `https://` URL |
| **C. Plain HTTP on your local network** only | `0.0.0.0` | `0` | `0` | leave unset |

After changing `.env`, apply it with `docker compose up -d`.

Why these matter:

- **`SECURE_COOKIES`** — the sign-in cookie is marked `Secure`, and browsers drop a `Secure` cookie
  on a plain `http://` page. Leave it at `1` whenever people use `https://`; set `0` only for
  case C, otherwise signing in appears to do nothing.
- **`TRUST_PROXY`** — how many proxies sit in front of the app. With a proxy, it lets the sign-in
  rate limit see each visitor's real IP. *Without* one (case C), set it to `0`: otherwise anyone
  can fake their IP in a header and dodge the limit.
- **`STUDIO_BIND`** — `127.0.0.1` means only programs on this machine (your proxy) can reach the
  port, so nobody can bypass HTTPS by going to `http://<server>:4322` directly.
- **`PUBLIC_ORIGIN`** — the address people type, e.g. `https://studio.example.org`. The studio uses
  it to reject form posts that come from other websites.

### A. Reverse proxy with HTTPS

Point your domain's DNS at the server, then put a reverse proxy in front of the studio. With
[Caddy](https://caddyserver.com/), which fetches and renews the HTTPS certificate by itself, the
whole configuration (`/etc/caddy/Caddyfile`) is:

```text
studio.example.org {
    reverse_proxy 127.0.0.1:4322
}
```

With **nginx**, the important parts are the forwarded headers and the upload size — nginx's
default 1 MB limit would break image uploads and ZIP import (the studio accepts ZIPs up to 50 MB):

```nginx
server {
    server_name studio.example.org;
    # listen 443 ssl; + your certificate lines (e.g. from certbot)

    client_max_body_size 60m;

    location / {
        proxy_pass http://127.0.0.1:4322;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;   # a large booklet export can take a while
    }
}
```

If the proxy itself runs in Docker rather than on the host, it cannot reach the host's
`127.0.0.1`. Either leave `STUDIO_BIND=0.0.0.0` and block port 4322 in your firewall, or attach the
proxy to the stack's Docker network and point it at `app:4322`.

### B. Cloudflare Tunnel

A tunnel gives you HTTPS without opening any port on your router. In the Cloudflare Zero Trust
dashboard, add a public hostname to your tunnel with service type **HTTP** and URL
`<server-ip>:4322` (or `localhost:4322` if `cloudflared` runs directly on the host — then you can
also set `STUDIO_BIND=127.0.0.1`). If `cloudflared` runs in its own container, keep
`STUDIO_BIND=0.0.0.0`, since a container cannot reach the host's loopback.

### C. Local network only

Open `http://<server-ip>:4322` from another machine on the network. Anyone who can reach that
address sees the sign-in page, so do not forward the port to the internet in this mode — use A or
B for that.

### Firewall

If the server runs a firewall, allow only what you actually use — typically ports 80 and 443 for
case A, nothing extra for B, and 4322 from your local network for C. For example, with `ufw`:

```sh
sudo ufw allow 80,443/tcp                                        # case A
sudo ufw allow from 192.168.1.0/24 to any port 4322 proto tcp    # case C
```

Be aware that Docker publishes ports by editing iptables directly, which can bypass `ufw` rules.
`STUDIO_BIND=127.0.0.1` is the reliable way to keep the port private.

---

## Day-to-day

```sh
# Update after pulling new code
git pull && docker compose up -d --build

# Back up — the database is the only thing worth backing up
docker compose exec -T db pg_dump -U studio studio > backup-$(date +%F).sql

# Watch the logs
docker compose logs -f app

# Stop / start
docker compose down        # keeps the database volume
docker compose up -d

# Change the studio password — this also signs everyone out, by design
nano .env && docker compose up -d
```

Never run `docker compose down -v` unless you mean it: `-v` deletes the database volume, and with
it every problem.

### Automatic backups

A nightly backup at 03:00, keeping the last 14 days — add it with `crontab -e` (adjust the path):

```cron
0 3 * * * cd /opt/problem-studio && docker compose exec -T db pg_dump -U studio studio | gzip > backups/backup-$(date +\%F).sql.gz && find backups -name '*.sql.gz' -mtime +14 -delete
```

Create the folder first with `mkdir backups`. Copy the backups off the machine now and then — a
backup on the same disk does not survive that disk failing.

### Restoring a backup

Restore into a fresh stack: start only the database, load the backup, then start the studio. If the
studio boots first it initialises the empty database itself, and the restore then collides with
those rows instead of filling the tables.

```sh
docker compose up -d --wait db
docker compose exec -T db psql -U studio -d studio < backup-2026-09-21.sql
# for a gzipped backup:  gunzip -c backup-2026-09-21.sql.gz | docker compose exec -T db psql -U studio -d studio
docker compose up -d
```

### Moving to another server

Back up on the old server, copy the backup and your `.env` across, clone the repository on the new
server, then follow **Restoring a backup** above. Keep the same `POSTGRES_PASSWORD` in `.env`, or
use a new one — the new database volume is created with whatever `.env` says at that moment.

---

## When something is wrong

**The sign-in page comes back after typing the right password.**
The session cookie is being dropped. It is marked `Secure`, so the browser refuses it on a plain
`http://` page. Reach the studio over `https://`, or — for local-network-only use — set
`SECURE_COOKIES=0` in `.env` and run `docker compose up -d`.

**PDF export fails, or the PDF shows empty boxes where Thai text should be.**
Empty boxes mean the Thai fonts are missing from the image — rebuild with
`docker compose build --no-cache app`. If export fails outright:

```sh
docker compose exec app ls -l /usr/bin/chromium   # must exist
docker compose logs app | grep -i chromium
```

**`docker compose ps` shows `app` as unhealthy.**
The health check (`/healthz`) reports the database as unreachable. Check `docker compose logs db`,
and that `POSTGRES_PASSWORD` in `.env` still matches the one the volume was created with — changing
it in `.env` afterwards does **not** change the password inside an existing database.

**"Studio is not configured: set STUDIO_PASSWORD".**
`.env` is missing, empty, or not in the same directory as `docker-compose.yml`. The studio refuses
to run without a password rather than exposing every problem to whoever finds the URL.

**Uploads or ZIP imports fail behind a proxy with "413 Request Entity Too Large".**
The proxy's upload limit is too small — see `client_max_body_size` in the nginx example above.

**Too many sign-in attempts.**
Ten failures in fifteen minutes per IP. Wait it out, or `docker compose restart app` to clear the
counter.

**The build fails or runs out of memory on a small machine.**
Building installs Chromium, which needs a few hundred MB free. On a machine with little RAM, add
swap, or build the image elsewhere and copy it over with `docker save` / `docker load`.

---

## Configuration reference

Everything below is set in `.env` and read by `docker-compose.yml`.

| Variable | Default | What it does |
| --- | --- | --- |
| `STUDIO_PASSWORD` | *(required)* | The password on the sign-in page |
| `POSTGRES_PASSWORD` | *(required)* | Postgres password (hex); only reachable inside the Docker network |
| `PUBLIC_ORIGIN` | *(unset)* | The address people type, e.g. `https://studio.example.org` — used to reject cross-site form posts |
| `STUDIO_BIND` | `0.0.0.0` | Host interface to publish the port on; `127.0.0.1` keeps it private to this machine |
| `STUDIO_PORT` | `4322` | Host port |
| `SECURE_COOKIES` | `1` | Set `0` only when people use plain `http://` |
| `TRUST_PROXY` | `1` | Number of proxies in front of the app; `0` when there is none |
| `SESSION_SECRET` | *(auto)* | Generated once and kept in Postgres; set it only to force everyone to sign in again |
| `SESSION_TTL_HOURS` | `720` | How long a sign-in lasts (30 days) |
| `POSTGRES_USER` / `POSTGRES_DB` | `studio` | Database user and name |

# Servers, Docker and databases

InfraTicket is one Node.js process (Node 20.11 or newer) serving the web app and the API on one port. Pick a database and a way to run it.

| | SQLite (built in) | PostgreSQL | MySQL / MariaDB |
| --- | --- | --- | --- |
| Setup | None | A database and user | A `utf8mb4` database and user |
| Servers | One | One or many | One or many |
| Good for | Laptop, lab, small teams | Production, serverless | Existing MySQL estates |

All three run the same schema, created and upgraded automatically on start.

## From source

```bash
npm ci
npm run build
npm start           # http://localhost:3000
```

`npm run build` produces `dist/client` and `dist/server/index.mjs`; `npm start` serves both. For development, `npm run dev` hot-reloads, `npm run seed` loads demo data (sign in as `avery@example.com` / `ChangeMe123!`), and `npm run reset` starts over.

## Docker

```bash
docker compose up -d          # app + PostgreSQL 16
docker compose up -d app      # app alone, on SQLite
```

The image includes `pg_dump` 17, `mysqldump` and `ping`, so PostgreSQL, MySQL and SQLite backups and ping monitors work out of the box. MongoDB and SQL Server tools are not packaged for Alpine; mount them and set `BACKUP_TOOLS_DIR`. Data lives in the `app_data` volume at `/app/data`. The container has a health check on `/health`.

Settings go in a `.env` next to `docker-compose.yml`:

```bash
SESSION_SECRET=...
SECRET_KEY=...
SETUP_TOKEN=...
APP_URL=https://tickets.example.com
SESSION_COOKIE_SECURE=true
POSTGRES_PASSWORD=...
```

## PostgreSQL

```bash
DATABASE_URL=postgresql://infraticket:secret@db.internal:5432/infraticket npm start
```

```sql
CREATE DATABASE infraticket;
CREATE USER infraticket WITH PASSWORD '…';
ALTER DATABASE infraticket OWNER TO infraticket;
```

- TLS follows `sslmode` in the URL. Managed providers use private CAs, so the connection is encrypted without verifying the certificate unless you set `PGSSLROOTCERT` to the provider's CA.
- **Supabase**: use the pooler string. For serverless the *transaction* pooler (port 6543); `DB_SCHEMA` needs the *session* pooler or a direct connection.
- To share a database with another application, use `DB_SCHEMA=infraticket`.

## MySQL / MariaDB

MySQL 8.0.13+ or MariaDB 10.2+; older versions are refused at start with the reason.

```sql
CREATE DATABASE infraticket CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'infraticket'@'localhost' IDENTIFIED BY '<long random password>';
GRANT ALL PRIVILEGES ON infraticket.* TO 'infraticket'@'localhost';
```

```bash
DATABASE_URL=mysql://infraticket:<password>@127.0.0.1:3306/infraticket
```

`utf8mb4` is required (emoji and accented characters). Grant to `'localhost'` when connecting to `127.0.0.1`. After the first start you can narrow the grant to `SELECT, INSERT, UPDATE, DELETE`, keeping `ALTER` and `INDEX` for upgrades.

## Running as a service (Linux)

```bash
sudo useradd --system --home /opt/infraticket --shell /usr/sbin/nologin infraticket
sudo git clone <this repository> /opt/infraticket && cd /opt/infraticket
sudo -u infraticket npm ci && sudo -u infraticket npm run build
sudo cp deploy/systemd/infraticket.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now infraticket
curl -s localhost:3000/health
```

The unit runs as the `infraticket` user, binds to `127.0.0.1:3000`, reads `/opt/infraticket/.env` (make it mode `0640`), and may write only to `/opt/infraticket/data`. Check that `/health` reports the database you expect; `"database":"sqlite"` means the `.env` was not read.

## Reverse proxy

Put Apache, nginx or IIS in front to terminate HTTPS. The app trusts one proxy hop (`X-Forwarded-For`, `X-Forwarded-Proto`), so the proxy **must** set them: without them the audit log records the proxy's address and secure cookies are refused. Set `SESSION_COOKIE_SECURE=true` behind HTTPS.

### Apache

`deploy/apache/infraticket.conf` in the repository is complete. The essentials:

```apache
<VirtualHost *:443>
    ServerName tickets.example.com
    SSLEngine on
    SSLCertificateFile    /etc/ssl/certs/tickets.example.com.crt
    SSLCertificateKeyFile /etc/ssl/private/tickets.example.com.key
    ProxyPreserveHost On
    ProxyPass        / http://127.0.0.1:3000/ timeout=120 retry=0
    ProxyPassReverse / http://127.0.0.1:3000/
    RequestHeader set X-Forwarded-Proto "https"
    RequestHeader set X-Forwarded-Port  "443"
    LimitRequestBody 26214400
</VirtualHost>
```

```bash
sudo a2enmod proxy proxy_http headers ssl rewrite
sudo cp deploy/apache/infraticket.conf /etc/apache2/sites-available/ && sudo a2ensite infraticket
sudo apachectl configtest && sudo systemctl reload apache2
```

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name tickets.example.com;
    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;
    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 120s;
    }
}
```

Keep the body limit above `MAX_UPLOAD_MB` (15 MB by default) or uploads fail at the proxy.

## Cloudflare Tunnel (no open ports)

The compose file has a `tunnel` profile:

1. Cloudflare Zero Trust → **Networks → Tunnels** → create a tunnel; add a public hostname (e.g. `tickets.example.com`) pointing at `http://app:3000`.
2. In `.env`: `CLOUDFLARE_TUNNEL_TOKEN=…`, `SESSION_COOKIE_SECURE=true`, `APP_URL=https://tickets.example.com`, and `SETUP_TOKEN`.
3. `docker compose --profile tunnel up -d`.

To publish only the webhook paths, see [Exposing only the webhook paths](lab-server.md#exposing-only-the-webhook-paths). Add **Cloudflare Access** in front of the hostname for SSO or MFA.

> **Note** Cloudflare **Workers** cannot run InfraTicket (no filesystem, no native modules, no background jobs). Use the tunnel.

## Serverless (Vercel)

`vercel.json` and `api/index.ts` are ready. Required: `DATABASE_URL` (a **pooled** PostgreSQL string), `SESSION_SECRET`, `SECRET_KEY`, `CRON_SECRET`, `SETUP_TOKEN`, `SESSION_COOKIE_SECURE=true`. Attachments are stored in the database (6 MB per file), and monitors, paging and backups need `/api/cron/ops` called every minute; see [Scheduled jobs on serverless](environment-variables.md#scheduled-jobs-on-serverless). Vercel's free plan allows one cron run per day, so use an external scheduler for the rest.

## Several servers

Run as many as you like behind a load balancer, on PostgreSQL or MySQL, with the **same** `SESSION_SECRET` and `SECRET_KEY`. Sessions, rate limits and the job lease are in the database: one server runs the scheduled work and another takes over within 30 seconds if it stops. Attachments on disk must be on shared storage, or use `ATTACHMENT_STORE=database`.

## Health check

```bash
curl -s https://tickets.example.com/health
# {"status":"ok","database":"postgres","uptime":4231}
```

`503` with `"status":"degraded"` means the database is unreachable; the body includes the reason.

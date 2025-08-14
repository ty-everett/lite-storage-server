# UHRP Storage Lite

UHRP Storage Lite is a minimal storage host for the
[Universal Hash Resolution Protocol (UHRP)](https://brc.dev/26). It
provides a small Express.js server that advertises hosted files on the BSV
blockchain and serves them from a local `public/cdn` directory. Pricing and
authentication are handled with the BSV SDK and payment middleware.

## How it works

- Requests are logged and routed through Express with CORS enabled and static
  files served from the `public` directory【F:src/index.ts†L19-L38】
- Auth and payment middleware calculate the price for uploads and renewals and
  attach UHRP advertisements to the blockchain【F:src/index.ts†L96-L134】
- The `/upload` route returns a pre-signed `put` URL for file uploads and quotes
  the cost based on file size and retention period【F:src/routes/upload.ts†L29-L89】
- Pricing is determined by `getPriceForFile`, which converts retention time and
  file size into satoshis using a USD per‑GB/month rate and current BSV exchange
  rate【F:src/utils/getPriceForFile.ts†L1-L55】

## Environment variables

Create a `.env` file (see `.env.example`) with the following values:

| Variable | Purpose |
| --- | --- |
| `HTTP_PORT` | Port for the HTTP server (default `8080`) |
| `HOSTING_DOMAIN` | Public domain name of the server (e.g. `storage.example.com`) |
| `SERVER_PRIVATE_KEY` | Hex-encoded private key identifying the host |
| `WALLET_STORAGE_URL` | URL for wallet storage service |
| `BSV_NETWORK` | `mainnet` or `testnet` |
| `PRICE_PER_GB_MO` | USD price per GB-month used for quoting storage |
| `MIN_HOSTING_MINUTES` | Minimum retention period for uploaded files |

## Getting started on Debian

The following steps describe deploying the server on a Debian box (for example
on a DigitalOcean droplet) for production use.

1. **Create a Debian droplet** – Provision a Debian 12 instance with at least
   1 GB RAM and a public IP address. SSH into the machine:

   ```bash
   ssh root@your.server.ip
   ```

2. **Install Node.js, Git and PM2**:

   ```bash
   apt update && apt install -y curl git
   curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
   apt install -y nodejs
   npm install -g pm2
   ```

3. **Clone and build the project**:

   ```bash
   git clone https://github.com/ty-everett/lite-storage-server.git
   cd uhrp-storage-server
   cp .env.example .env    # then edit .env with your settings
   npm install
   npm run build
   ```

4. **Run the server with PM2**:

   ```bash
   pm2 start out/src/index.js --name uhrp-lite
   pm2 save
   pm2 startup   # follow the printed instructions
   ```

5. **Configure nginx and HTTPS**:

   ```bash
   apt install -y nginx certbot python3-certbot-nginx
   ```

   Create `/etc/nginx/sites-available/uhrp-lite`:

   ```nginx
   server {
       listen 80;
       server_name example.com;

       location / {
           proxy_pass http://localhost:8080;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }
   }
   ```

   Enable the site and obtain a certificate:

   ```bash
   ln -s /etc/nginx/sites-available/uhrp-lite /etc/nginx/sites-enabled/
   nginx -t && systemctl reload nginx
   certbot --nginx -d example.com
   ```

The server will now restart on boot and proxy through nginx with HTTPS. Files
placed in `public/cdn` will be accessible at
`https://example.com/cdn/<objectId>` and advertised via UHRP.

## Development

Install dependencies and start the server in watch mode:

```bash
npm install
npm run dev
```

## License

See [LICENSE.txt](LICENSE.txt) for licensing information.


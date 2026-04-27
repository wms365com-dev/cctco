# Commercial Cleaning Website

Railway-ready commercial cleaning site with:

- Quote requests saved to PostgreSQL
- Worker applications saved to PostgreSQL
- Resume, ID, SIN, and certification uploads saved to a persistent volume
- Admin JSON endpoints protected by `ADMIN_TOKEN`

## Local setup

```bash
npm install
npm start
```

Open `http://localhost:3000`.

Without `DATABASE_URL`, the page will load but form submissions return a database configuration message.

## Railway setup

1. Create a Railway project from this folder/repository.
2. Add a PostgreSQL service.
3. Railway should provide `DATABASE_URL` to the web service. If it does not, add it manually from the PostgreSQL variables.
4. Add a Railway Volume mounted at `/data`.
5. Add these web service variables:

```env
UPLOAD_DIR=/data/uploads
ADMIN_TOKEN=use-a-long-random-secret
```

6. Deploy. The app creates the SQL tables automatically on startup.

## Admin endpoints

Use the `ADMIN_TOKEN` value as the `x-admin-token` header.

```bash
curl -H "x-admin-token: YOUR_TOKEN" https://YOUR-RAILWAY-APP.up.railway.app/api/admin/quotes
curl -H "x-admin-token: YOUR_TOKEN" https://YOUR-RAILWAY-APP.up.railway.app/api/admin/applications
```

## Sensitive hiring documents

ID and SIN documents are sensitive. Keep Railway access limited, use a strong `ADMIN_TOKEN`, and only request full SIN/ID when necessary for hiring or onboarding.

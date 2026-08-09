# Vercel Production Environment Checklist

Set these in Vercel Production scope for each project.

## Frontend project (gtcollectibles-web)
- VITE_API_BASE_URL (optional): https://api.gtcollectibles.io
- VITE_CARDSYNC_API_BASE_URL (recommended): https://cardsync-api.vercel.app (or your cardsync custom domain)
- VITE_AUTH0_DOMAIN: your Auth0 tenant domain (for example `your-tenant.us.auth0.com`)
- VITE_AUTH0_CLIENT_ID: Auth0 SPA client id
- VITE_AUTH0_AUDIENCE (optional): API audience if requesting Auth0 API tokens
- VITE_AUTH0_ADMIN_EMAILS: comma-separated admin bootstrap emails (first owner account)
- VITE_STRIPE_CONNECTED_ACCOUNT (optional): Stripe Connect account id (`acct_...`) if charging to connected LLC account

## API project (gtcollectibles-api)
- DATABASE_URL: Postgres connection string
- TCG_API_KEY: Key for https://api.tcgapi.dev
- LOG_LEVEL: info
- EBAY_CLIENT_ID (if integration enabled)
- EBAY_CLIENT_SECRET (if integration enabled)
- OCR_API_KEY (if integration enabled)
- SHOPIFY_STORE_DOMAIN (if integration enabled)
- SHOPIFY_ADMIN_ACCESS_TOKEN (if integration enabled)
- AUTH_BASE_URL (if auth/session enabled): https://gtcollectibles.io
- AUTH_CALLBACK_URL (if auth/session enabled): https://gtcollectibles.io/auth/callback

## CardSync API project (cardsync-api)
- STRIPE_SECRET_KEY: Stripe secret key (use test key in development)
- STRIPE_CONNECTED_ACCOUNT (optional): default Stripe Connect account id (`acct_...`)

## Notes
- Keep secrets only in Vercel envs, never in repo files.
- Add Preview/Development values separately if needed.

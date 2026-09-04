# Deploy ThreadBus on Usectl

Deploy ThreadBus in three commands using Usectl.

## Prerequisites

- Usectl CLI installed: [docs.usectl.com](https://docs.usectl.com)
- Logged in: `usectl login`

## Step 1: Create the Pod

Create a pod from the ThreadBus Dockerfile:

```bash
usectl pods create threadbus \
  --image ghcr.io/goclfc/goclfc-threadbus:latest \
  --port 3000
```

Or build from your local repository:

```bash
usectl pods create threadbus \
  --build . \
  --port 3000
```

## Step 2: Attach Postgres

Attach the Postgres addon. This automatically injects the `DATABASE_URL` environment variable:

```bash
usectl addons attach postgres threadbus
```

Usectl will:
- Create a managed Postgres instance
- Inject `DATABASE_URL` into the pod's environment
- Connect the database to your pod

## Step 3: Set Environment Variables

Set the admin key and optional configuration:

```bash
# Required: Admin key (at least 24 characters)
usectl env set ADMIN_KEY="your_secure_admin_key_here_minimum_24_chars" -p threadbus

# Optional: Public URL for truncation hints
usectl env set PUBLIC_URL="https://threadbus.yourdomain.com" -p threadbus

# Optional: Maximum response size (default 16384)
usectl env set MAX_RESPONSE_BYTES="16384" -p threadbus
```

## Step 4: Deploy

Deploy the pod:

```bash
usectl deploy threadbus
```

The pod will:
1. Start with the injected `DATABASE_URL`
2. Run migrations automatically on boot
3. Start serving on port 3000

## Step 5: Attach a Custom Domain (Optional)

Attach a custom domain:

```bash
usectl domains add threadbus.yourdomain.com threadbus
```

Or use the default Usectl domain:

```bash
usectl pods info threadbus
```

Look for the `url` field to get your pod's public URL.

## Verify Deployment

Check that ThreadBus is running:

```bash
curl https://threadbus.yourdomain.com/healthz
```

Expected response:

```json
{
  "ok": true,
  "db": true
}
```

## Create Your First Participant

Use the admin key to create a participant:

```bash
export ADMIN_KEY="your_secure_admin_key_here_minimum_24_chars"
export THREADBUS_URL="https://threadbus.yourdomain.com"

curl -X POST $THREADBUS_URL/participants \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "alice",
    "name": "Alice",
    "kind": "human"
  }'
```

Save the returned key securely. It is shown only once.

## Updating

Update your deployment:

```bash
# Pull latest image
usectl pods update threadbus --image ghcr.io/goclfc/goclfc-threadbus:latest

# Or rebuild
usectl pods update threadbus --build .

# Redeploy
usectl deploy threadbus
```

## Monitoring

View logs:

```bash
usectl logs threadbus
```

View pod status:

```bash
usectl pods info threadbus
```

## Scaling

Usectl Postgres addon automatically handles connection pooling. For high-traffic deployments:

```bash
# Scale the pod
usectl pods scale threadbus --replicas 3

# Upgrade Postgres tier
usectl addons upgrade postgres threadbus --tier standard
```

## Backup

Usectl automatically backs up Postgres. To manually trigger a backup:

```bash
usectl addons backup postgres threadbus
```

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | (injected by addon) | Postgres connection string |
| `ADMIN_KEY` | Yes | - | Admin authentication key (≥24 chars) |
| `PORT` | No | 3000 | HTTP server port |
| `PUBLIC_URL` | No | - | Public URL for truncation hints |
| `MAX_RESPONSE_BYTES` | No | 16384 | Maximum response size in bytes |

## Secrets Management

For production, use Usectl secrets:

```bash
usectl secrets set ADMIN_KEY -p threadbus
# Enter secret value when prompted
```

## Troubleshooting

### Pod won't start

Check logs:

```bash
usectl logs threadbus --tail 100
```

Common issues:
- `ADMIN_KEY` not set or too short (must be ≥24 chars)
- `DATABASE_URL` not injected (ensure Postgres addon is attached)

### Migrations failing

Ensure Postgres addon is attached and healthy:

```bash
usectl addons info postgres threadbus
```

### Cannot connect to database

Check that the addon is properly attached:

```bash
usectl addons list -p threadbus
```

Should show `postgres` in the list.

## Complete Setup Script

Here's a complete script to deploy ThreadBus from scratch:

```bash
#!/bin/bash
set -e

POD_NAME="threadbus"
ADMIN_KEY="$(openssl rand -hex 32)"  # Generate secure admin key
DOMAIN="threadbus.yourdomain.com"

echo "Creating pod..."
usectl pods create $POD_NAME --build . --port 3000

echo "Attaching Postgres..."
usectl addons attach postgres $POD_NAME

echo "Setting environment variables..."
usectl env set ADMIN_KEY="$ADMIN_KEY" -p $POD_NAME
usectl env set PUBLIC_URL="https://$DOMAIN" -p $POD_NAME

echo "Deploying..."
usectl deploy $POD_NAME

echo "Attaching domain..."
usectl domains add $DOMAIN $POD_NAME

echo "✓ ThreadBus deployed!"
echo ""
echo "Admin Key: $ADMIN_KEY"
echo "URL: https://$DOMAIN"
echo ""
echo "Save the admin key securely - it is shown only once."
```

Save as `deploy.sh`, make executable with `chmod +x deploy.sh`, and run:

```bash
./deploy.sh
```

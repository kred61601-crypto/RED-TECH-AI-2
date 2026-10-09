# Railway setup

Create a MongoDB service in the same Railway project as the Firebox Bot panel. In the panel service's Variables page, add a reference variable named `MONGO_URL` with the value `${{Mongo.MONGO_URL}}`, replacing `Mongo` with the exact name of the MongoDB service if it differs. The application also accepts `MONGO_PUBLIC_URL` or `MONGODB_URI` when the database is outside the Railway project, but the private `MONGO_URL` reference is preferred for services in the same project.

Add the following optional values to the panel service:

```env
MONGODB_DATABASE=firebox
MONGODB_SERVERS_COLLECTION=servers
```

The same MongoDB service is also used for Firebox token records and Baileys authentication state. The bot stores the token, protected phone number, credentials, and signal keys under the bot's stable token namespace in MongoDB, so replacing the Railway container no longer requires WhatsApp pairing again. Set a stable `SESSION_SECRET` (and optionally `FIREBOX_TOKEN_SECRET`) and keep those values unchanged. During a deliberate secret rotation, temporarily set `FIREBOX_TOKEN_SECRET_PREVIOUS` (or `SESSION_SECRET_PREVIOUS`) to the old value while the new value is active; the token registry will try both keys. If neither current nor previous secret can decrypt a record, the admin overview remains available and marks that record as unavailable, but the original token cannot be recovered without the old secret.

After deploying this version, pair each existing bot once more. That first
connection migrates its live Baileys credentials into MongoDB. Later Railway
redeploys restore those credentials automatically. Do not delete the
`BaileysAuth` collection or change the bot token identity.

After saving the variables, redeploy the panel service. The `/admin` server registry will then save server name, hub URL, bot ID, bot key, public URL, active state, and creation time in the Railway MongoDB service.

The webhook hub URL is not the MongoDB URL. Each actual bot deployment still uses `FIREBOX_HUB_URL`, `FIREBOX_BOT_ID`, `FIREBOX_BOT_KEY`, and `FIREBOX_PUBLIC_URL` for event delivery and pairing.

## Paystack access plans

Add `PAYSTACK_SECRET_KEY` to the panel service using a Paystack **test** secret key first, then set `PAYSTACK_ENABLED=true`. The secret key stays server-side and is also used to verify Paystack's `x-paystack-signature` webhook header. Do not put it in the browser or commit it to the repository.

In the Paystack Dashboard, configure the webhook URL as `https://<your-public-panel-domain>/api/paystack/webhook` and enable the `charge.success` event. The checkout supports M-PESA, Airtel Money, and Paystack-hosted Visa/Mastercard checkout. Set `PAYSTACK_CALLBACK_URL=https://<your-public-panel-domain>/token` so card customers return to the token page after checkout. Paystack uses the webhook to confirm asynchronous mobile-money authorization and card payments; the application also verifies each transaction with Paystack before issuing access. Test the complete flow with Paystack test credentials before changing to a live secret key. Set `PAYSTACK_ENABLED=false` to turn the purchase flow off without removing the secret.

The existing plans remain KSh 29 / 7 days, KSh 49 / 14 days, and KSh 99 / 30 days. A valid payment creates or extends the corresponding phone's expiring token. New tokens can be created before payment, but remain locked from pairing until a plan is paid. Pre-existing non-expiring tokens remain usable and do not need a paid plan.

## Administrator access

Add this variable to the Firebox Bot panel service in Railway:

```env
FIREBOX_ADMIN_PASSCODE=replace-with-a-long-random-passcode
```

The passcode is checked only on the server and is never sent to the browser. After a successful passcode login, the browser receives the normal signed session cookie and can open `/admin`, add or remove bot servers, or read the users-and-bots overview. Use a long random value and keep it private.

## Automatic bot registration from the Webhook Hub

To register each bot only once in the Webhook Hub and have it appear automatically in this panel, add these variables to the Webhook Hub service:

```env
FIREBOX_PANEL_URL=https://your-firebox-panel.up.railway.app
FIREBOX_PANEL_SYNC_SECRET=one-long-random-secret
FIREBOX_HUB_URL=https://your-webhook-hub.up.railway.app
```

Add the same sync secret to the Firebox panel service:

```env
FIREBOX_PANEL_SYNC_SECRET=one-long-random-secret
```

After both services are redeployed, every new or updated Webhook Hub registration is upserted into the panel by Bot ID. The panel’s `/admin` page no longer needs a duplicate manual server entry for synchronized bots.

## Token and pairing access lifecycle
New visitors can generate a Firebox token without payment. The token is intentionally marked `payment_required` and cannot generate a WhatsApp pairing code. A successful M-PESA, Airtel Money, or card plan payment activates that same token for 7, 14, or 30 days. After `expiresAt`, pairing-code requests are rejected until another verified payment extends the token. Existing legacy non-expiring tokens remain compatible and do not require a new payment unless they are replaced.

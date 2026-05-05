# Klaviyo -> GMD Ping webhook

Ovaj projekat sadrzi Vercel serverless funkciju:

```text
api/ping-hook.js
```

Klaviyo salje webhook na ovu funkciju, a funkcija zatim prosledjuje poruku na GMD Ping Messaging API.

## 1. Sta treba da imas

- GitHub nalog
- Vercel nalog
- GMD API token
- GMD SMS sender name
- GMD Viber sender name

## 2. Env varijable u Vercel-u

U Vercel projektu dodaj ove env varijable:

```text
GMD_API_TOKEN
GMD_SMS_SENDER_NAME
GMD_VIBER_SENDER_NAME
KLAVIYO_WEBHOOK_SECRET
```

Primer:

```text
GMD_API_TOKEN=xxxxxxxxxxxxxxxx
GMD_SMS_SENDER_NAME=Promo_info
GMD_VIBER_SENDER_NAME=GMD SOLUTIONS
KLAVIYO_WEBHOOK_SECRET=duga_nasumicna_tajna_koju_znaju_samo_klaviyo_i_vercel
```

Nemoj stavljati pravi token u GitHub repo.
Nemoj stavljati pravi `KLAVIYO_WEBHOOK_SECRET` u GitHub repo.

## 3. Webhook URL

Kada deploy prodje, Vercel ce ti dati domen. Klaviyo webhook URL ce biti:

```text
https://tvoj-vercel-domen.vercel.app/api/ping-hook
```

## 4. Klaviyo payload

U Klaviyo webhook-u dodaj header:

```text
x-webhook-secret: ista_vrednost_kao_KLAVIYO_WEBHOOK_SECRET
```

Zatim salji JSON:

```json
{
  "phone_number": "+3816XXXXXXX",
  "channel_preference": "viber-fallback",
  "message": "Sadrzaj poruke"
}
```

`channel_preference` moze biti:

```text
sms
viber
viber-fallback
```

## 5. Lokalni test, ako imas instaliran Node.js

Prvo napravi `.env.local` fajl po uzoru na `.env.example`.

Zatim pokreni:

```bash
npm install
npm run dev
```

Test zahtev:

```bash
curl -X POST http://localhost:3000/api/ping-hook \
  -H "x-webhook-secret: tvoja_test_tajna" \
  -H "Content-Type: application/json" \
  -d "{\"phone_number\":\"+3816XXXXXXX\",\"channel_preference\":\"sms\",\"message\":\"Test poruka\"}"
```

## 6. Ocekivan odgovor

Ako je sve u redu:

```json
{
  "success": true,
  "messageId": "generated-message-id"
}
```

Ako fali broj telefona ili kanal:

```json
{
  "error": "Bad Request",
  "message": "Missing required fields: phone_number and channel_preference."
}
```

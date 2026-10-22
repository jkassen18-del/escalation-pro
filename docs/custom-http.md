# Custom HTTP

Send ticket events to any URL: an internal dashboard, a CMDB, n8n, Power Automate, a script. You choose the method, headers and body, and each request can be signed so the receiver can check it came from InfraTicket.

[Open Integrations](/integrations)

## Set up

*Integrations → Custom HTTP → New*:

| Field | Meaning |
| --- | --- |
| **Name** | For you |
| **Method** | `POST`, `PUT` or `PATCH` |
| **URL** | Where to send. https, and not a private or internal address, unless the next box is ticked |
| **Allow private and internal addresses** | For a system on your own network (10.x, 192.168.x, plain http). Cloud metadata addresses stay blocked |
| Headers (**Header name** / **Header value**) | Up to 20, e.g. `Authorization: Bearer …`. Values are stored encrypted and never shown again |
| **Use my own body template** | Otherwise the body is the default JSON below |
| **Signing secret** | Optional; adds the signature headers below |
| **Send when…** | Ticket created, Ticket assigned, Status changed, Escalated, New comment, SLA breached |
| **Only for these teams** | Leave all unticked to send for every team |
| **Enabled** | |

**Test** sends a sample event and shows the status code and the first 500 characters of the response. Deliveries appear under **Recent deliveries**.

Requests time out after 10 seconds and do not follow redirects (a redirect could point somewhere the URL check refused). They are not retried. Internal notes are never sent.

## The default body

```json
{
  "event": "ticketCreated",
  "headline": "New ticket ESC-1042",
  "detail": "",
  "actor": "Avery Moore",
  "ticket": {
    "id": "…",
    "reference": "ESC-1042",
    "subject": "Checkout returns 502 for EU customers",
    "description": "…",
    "status": "open",
    "priority": "urgent",
    "type": "incident",
    "severity": "sev2",
    "source": "web",
    "teamId": "…",
    "teamName": "Engineering",
    "assigneeName": null,
    "requesterName": "Avery Moore",
    "tags": ["payments", "eu"],
    "dueAt": "2026-10-22T15:40:00.000Z",
    "createdAt": "2026-10-22T09:40:00.000Z",
    "url": "https://tickets.example.com/tickets/…"
  },
  "sentAt": "2026-10-22T09:40:01.000Z"
}
```

`event` is one of `ticketCreated`, `ticketAssigned`, `ticketStatusChanged`, `ticketEscalated`, `ticketCommented`, `slaBreached`.

## Body templates

Any `{{path}}` from the document above is replaced, for example `{{ticket.reference}}` or `{{actor}}`. Unknown paths become empty.

- A template starting with `{` or `[` is sent as `application/json`, and each value is escaped as JSON string content, so a subject with quotes or a newline cannot break the document or inject keys.
- Anything else is sent as `text/plain`.

A Microsoft Teams Workflows card, for example:

```json
{
  "type": "message",
  "text": "{{headline}}: {{ticket.subject}} ({{ticket.priority}}) {{ticket.url}}"
}
```

## Verifying the signature

With a signing secret, every request carries:

```text
X-InfraTicket-Timestamp: 1792662001
X-InfraTicket-Signature: sha256=<hex>
```

The signature is the HMAC-SHA256, keyed with the secret, of the timestamp, a dot, and the raw body: `<timestamp>.<body>`. Check it against the **raw** bytes before parsing, compare in constant time, and reject old timestamps to stop replays.

### Node.js (Express)

```js
import crypto from 'node:crypto';
import express from 'express';

const SECRET = process.env.INFRATICKET_SECRET;
const app = express();

app.post('/infraticket', express.raw({ type: '*/*' }), (req, res) => {
  const timestamp = req.get('X-InfraTicket-Timestamp') ?? '';
  const signature = req.get('X-InfraTicket-Signature') ?? '';
  const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(`${timestamp}.${req.body}`).digest('hex');

  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
  const valid =
    signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!fresh || !valid) return res.status(401).end();

  const event = JSON.parse(req.body.toString('utf8'));
  console.log(event.event, event.ticket.reference);
  res.sendStatus(204);
});

app.listen(8081);
```

### Python (Flask)

```python
import hashlib, hmac, os, time
from flask import Flask, abort, request

SECRET = os.environ["INFRATICKET_SECRET"].encode()
app = Flask(__name__)

@app.post("/infraticket")
def infraticket():
    timestamp = request.headers.get("X-InfraTicket-Timestamp", "")
    signature = request.headers.get("X-InfraTicket-Signature", "")
    body = request.get_data()  # raw bytes, before any parsing
    expected = "sha256=" + hmac.new(SECRET, timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()

    if not timestamp.isdigit() or abs(time.time() - int(timestamp)) > 300:
        abort(401)
    if not hmac.compare_digest(signature, expected):
        abort(401)

    event = request.get_json()
    print(event["event"], event["ticket"]["reference"])
    return "", 204
```

## Reserved headers

`Host`, `Content-Length`, `Transfer-Encoding`, `Connection` and the two `X-InfraTicket-*` headers are set by InfraTicket and cannot be overridden. Requests send `User-Agent: InfraTicket-Webhook/2.0`.

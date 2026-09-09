# Miller Courtside backend

Turns the prototype into something that sends real texts. The frontend
artifact would call this API instead of `window.storage`.

## What it does

- Stores the roster, court state, and which phone numbers are subscribed
  to which players, in Postgres.
- Sends texts through Twilio for the three PRD message types: assigned,
  warming up, reassigned.
- Pushes live court updates to any connected browser over
  Server-Sent Events (`GET /events`), so the manager and parent screens
  update instantly instead of polling.
- Handles `STOP` replies automatically so you stay compliant with SMS
  opt-out rules.

## One-time setup

1. **Database.** Any managed Postgres works (Railway, Render, Supabase,
   Neon all have free tiers). Create a database, then run:
   ```
   psql "$DATABASE_URL" -f schema.sql
   ```
   Then load your roster:
   ```sql
   insert into players (name, grade) values
     ('Hadden Irwin', 12),
     ('Joey Beahrs', 12);
     -- ...one row per player
   ```

2. **Twilio.** Sign up, buy a phone number capable of SMS (~$1/month),
   and grab the Account SID, Auth Token, and the number itself. In the
   Twilio console, set that number's "A message comes in" webhook to
   `https://your-backend-url/sms/inbound` so STOP/HELP replies get
   processed.

3. **Environment.** Copy `.env.example` to `.env` and fill in the values.

4. **Install and run:**
   ```
   npm install
   npm start
   ```

## Deploying

Any Node host works — Railway or Render are the simplest for a small
app like this: connect the repo, set the environment variables in
their dashboard, and it builds automatically. Keep the database and
the backend in the same region to keep things fast on match night.

## API

| Method | Path | Body | What it does |
|---|---|---|---|
| GET | `/players` | — | Full roster |
| GET | `/courts` | — | Current state of all 12 courts |
| GET | `/events` | — | SSE stream; emits `courts-updated` |
| POST | `/subscribe` | `{ phone, playerNames }` | Parent opts a phone number into alerts |
| POST | `/courts/:num/assign` | `{ playerNames, est }` | Assign or reassign a court |
| POST | `/courts/:num/status` | `{ status }` | `warming`, `inprogress`, or `open` (clears) |
| POST | `/sms/inbound` | Twilio webhook | Handles STOP replies |

## Wiring the frontend to this instead of window.storage

Swap the `loadShared`/`saveCourts`/`pushNotifications` functions in the
artifact for `fetch` calls to these endpoints, and open an
`EventSource('/events')` to replace the 3-second polling loop with
instant updates. Everything else in the UI stays the same.

## Before match night

- Get explicit opt-in from parents (the QR code flow already does
  this) — unsolicited texts risk TCPA complaints even for a school
  team.
- Test with a real phone on the actual courts' wifi/cell signal before
  the first match.
- Keep the Twilio trial number's daily message limit in mind if you're
  still on a trial account; upgrade before the season starts.

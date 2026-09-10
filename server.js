import "dotenv/config";
import express from "express";
import cors from "cors";
import pkg from "pg";
import twilio from "twilio";

const { Pool } = pkg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ---- live updates (Server-Sent Events) ----
const clients = new Set();

app.get("/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}

// ---- helpers ----
async function getCourtsState() {
  const courts = (await pool.query("select * from courts order by number")).rows;
  const links = (await pool.query(
    `select cp.court_number, p.name from court_players cp join players p on p.id = p.id and cp.player_id = p.id`
  )).rows;
  const byCourt = {};
  for (const c of courts) byCourt[c.number] = { ...c, players: [] };
  for (const l of links) byCourt[l.court_number].players.push(l.name);
  return byCourt;
}

async function sendSms(phone, message) {
  if (!FROM_NUMBER) {
    console.log(`[dev] would text ${phone}: ${message}`);
    return;
  }
  await twilioClient.messages.create({ from: FROM_NUMBER, to: phone, body: message });
}

async function notifyPlayer(playerId, courtNumber, type, message) {
  await pool.query(
    "insert into notifications (player_id, court_number, type, message) values ($1,$2,$3,$4)",
    [playerId, courtNumber, type, message]
  );
  const subs = (await pool.query("select phone from subscriptions where player_id=$1", [playerId])).rows;
  await Promise.all(subs.map((s) => sendSms(s.phone, message)));
}

// ---- roster ----
app.get("/players", async (req, res) => {
  const rows = (await pool.query("select id, name, grade from players order by grade desc, name")).rows;
  res.json(rows);
});

// ---- parent subscribes a phone number to one or more players ----
app.post("/subscribe", async (req, res) => {
  const { phone, playerNames } = req.body;
  if (!phone || !Array.isArray(playerNames) || playerNames.length === 0) {
    return res.status(400).json({ error: "phone and playerNames are required" });
  }
  const players = (
    await pool.query("select id, name from players where name = any($1::text[])", [playerNames])
  ).rows;
  for (const p of players) {
    await pool.query(
      "insert into subscriptions (player_id, phone) values ($1,$2) on conflict do nothing",
      [p.id, phone]
    );
  }
  await sendSms(
    phone,
    `You're signed up for court alerts for ${players.map((p) => p.name).join(", ")}. Reply STOP to opt out.`
  );
  res.json({ ok: true, subscribed: players.map((p) => p.name) });
});

// ---- current board ----
app.get("/courts", async (req, res) => {
  res.json(await getCourtsState());
});

// ---- notification history, optionally filtered to specific players ----
app.get("/notifications", async (req, res) => {
  const playersParam = req.query.players;
  let rows;
  if (playersParam) {
    const names = String(playersParam).split(",").map((s) => s.trim()).filter(Boolean);
    rows = (
      await pool.query(
        `select n.id, n.court_number, n.type, n.message, n.sent_at, p.name as player
         from notifications n join players p on p.id = n.player_id
         where p.name = any($1::text[])
         order by n.sent_at desc limit 100`,
        [names]
      )
    ).rows;
  } else {
    rows = (
      await pool.query(
        `select n.id, n.court_number, n.type, n.message, n.sent_at, p.name as player
         from notifications n join players p on p.id = n.player_id
         order by n.sent_at desc limit 100`
      )
    ).rows;
  }
  res.json(rows);
});

// ---- manager assigns or reassigns a court ----
app.post("/courts/:num/assign", async (req, res) => {
  const num = Number(req.params.num);
  const { playerNames, est } = req.body;
  if (!Array.isArray(playerNames) || playerNames.length === 0 || playerNames.length > 2) {
    return res.status(400).json({ error: "assign 1 or 2 players" });
  }

  const current = (await pool.query("select status from courts where number=$1", [num])).rows[0];
  const isReassign = current && current.status !== "open";

  const players = (
    await pool.query("select id, name from players where name = any($1::text[])", [playerNames])
  ).rows;

  await pool.query("delete from court_players where court_number=$1", [num]);
  for (const p of players) {
    await pool.query("insert into court_players (court_number, player_id) values ($1,$2)", [num, p.id]);
  }
  await pool.query(
    "update courts set status='assigned', est=$2, assigned_at=now() where number=$1",
    [num, est || null]
  );

  for (const p of players) {
    const message = isReassign
      ? `${p.name} has been reassigned to Court ${num}. They will begin warming up soon.`
      : `${p.name} has been assigned to Court ${num}. They will begin warming up soon.`;
    await notifyPlayer(p.id, num, isReassign ? "reassign" : "assign", message);
  }

  broadcast("courts-updated", await getCourtsState());
  res.json({ ok: true });
});

// ---- manager updates status: warming | inprogress | open (cleared) ----
app.post("/courts/:num/status", async (req, res) => {
  const num = Number(req.params.num);
  const { status } = req.body;
  if (!["warming", "inprogress", "open"].includes(status)) {
    return res.status(400).json({ error: "invalid status" });
  }

  if (status === "open") {
    await pool.query("delete from court_players where court_number=$1", [num]);
    await pool.query("update courts set status='open', est=null, assigned_at=null where number=$1", [num]);
  } else {
    await pool.query("update courts set status=$2 where number=$1", [num, status]);
  }

  if (status === "warming") {
    const players = (
      await pool.query(
        "select p.id, p.name from court_players cp join players p on p.id=cp.player_id where cp.court_number=$1",
        [num]
      )
    ).rows;
    for (const p of players) {
      await notifyPlayer(p.id, num, "reminder", `${p.name} is warming up on Court ${num}.`);
    }
  }

  broadcast("courts-updated", await getCourtsState());
  res.json({ ok: true });
});

// ---- Twilio inbound webhook: handles STOP / HELP automatically, ----
// ---- but also removes the phone from our own subscriptions table ----
app.post("/sms/inbound", async (req, res) => {
  const body = (req.body.Body || "").trim().toUpperCase();
  const from = req.body.From;
  if (body === "STOP") {
    await pool.query("delete from subscriptions where phone=$1", [from]);
  }
  res.set("Content-Type", "text/xml");
  res.send("<Response></Response>");
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Courtside backend listening on ${port}`));
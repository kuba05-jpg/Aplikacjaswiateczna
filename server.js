const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const nodemailer = require("nodemailer");

const PORT = Number(process.env.PORT) || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const USERS = [
  ["asia", "Asia", 0],
  ["kacper", "Kacper", 0],
  ["ada", "Ada", 0],
  ["mama", "Mama", 0],
  ["tata", "Tata", 0],
  ["kuba", "Kuba", 1],
];
const LEGACY_DEFAULT_INSTRUCTIONS =
  "Przygotuj prezent z sercem. Nie zdradzaj, kogo wylosowałeś/aś, i przynieś podpisany prezent na nasze rodzinne Mikołajki.";
const DEFAULT_INSTRUCTIONS =
  "Przygotuj prezent z sercem. Nie zdradzaj, kogo wylosowałeś/aś, i przynieś podpisany prezent na nasze Święta na Czapli.";

if (!DATABASE_URL) {
  console.error("Brak zmiennej DATABASE_URL. Podłącz bazę PostgreSQL.");
  process.exit(1);
}

const db = new Pool({ connectionString: DATABASE_URL, max: 5 });

async function initializeDatabase() {
  await db.query(`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    login TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    is_admin BOOLEAN NOT NULL DEFAULT FALSE,
    must_change_password BOOLEAN NOT NULL DEFAULT TRUE
  );
  CREATE TABLE IF NOT EXISTS wishlist_items (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS assignments (
    giver_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `);

  for (const [login, name, isAdmin] of USERS) {
    const existing = await db.query("SELECT 1 FROM users WHERE login = $1", [login]);
    if (!existing.rowCount) {
      const password = crypto.randomBytes(6).toString("base64url");
      await db.query(
        `INSERT INTO users (login, name, password_hash, is_admin)
         VALUES ($1, $2, $3, $4) ON CONFLICT (login) DO NOTHING`,
        [login, name, bcrypt.hashSync(password, 12), Boolean(isAdmin)],
      );
      console.log(`Konto startowe — login: ${login.padEnd(7)} hasło: ${password}`);
    }
  }
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('instructions', $1)
     ON CONFLICT (key) DO NOTHING`,
    [DEFAULT_INSTRUCTIONS],
  );
  await db.query(
    `UPDATE settings SET value = $1 WHERE key = 'instructions' AND value = $2`,
    [DEFAULT_INSTRUCTIONS, LEGACY_DEFAULT_INSTRUCTIONS],
  );
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

const loginAttempts = new Map();
const sseClients = new Map();

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, decodeURIComponent(value)]),
  );
}

async function sessionUser(req) {
  const token = cookies(req).session;
  if (!token) return null;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const result = await db.query(
    `SELECT u.id, u.login, u.name, u.email, u.is_admin AS "isAdmin",
            u.must_change_password AS "mustChangePassword"
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > $2`,
    [tokenHash, Date.now()],
  );
  return result.rows[0] || null;
}

async function requireAuth(req, res, next) {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: "Zaloguj się ponownie." });
  req.user = user;
  next();
}

function requireReady(req, res, next) {
  if (req.user.mustChangePassword) {
    return res.status(403).json({ error: "Najpierw ustaw własne hasło." });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user.isAdmin) return res.status(403).json({ error: "Brak uprawnień." });
  next();
}

function notify(userId, event = "update") {
  for (const response of sseClients.get(userId) || []) {
    response.write(`event: ${event}\ndata: {}\n\n`);
  }
}

function notifyAll(event = "update") {
  for (const userId of sseClients.keys()) notify(userId, event);
}

function publicUser(user) {
  return {
    id: user.id,
    login: user.login,
    name: user.name,
    email: user.email,
    isAdmin: Boolean(user.isAdmin),
    mustChangePassword: Boolean(user.mustChangePassword),
  };
}

app.post("/api/login", async (req, res) => {
  const login = String(req.body.login || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const key = `${req.ip}:${login}`;
  const attempt = loginAttempts.get(key);
  if (attempt?.blockedUntil > Date.now()) {
    return res.status(429).json({ error: "Za dużo prób. Spróbuj ponownie za 15 minut." });
  }

  const user = (await db.query("SELECT * FROM users WHERE login = $1", [login])).rows[0];
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    const count = (attempt?.count || 0) + 1;
    loginAttempts.set(key, {
      count,
      blockedUntil: count >= 10 ? Date.now() + 15 * 60 * 1000 : 0,
    });
    return res.status(401).json({ error: "Nieprawidłowy login lub hasło." });
  }

  loginAttempts.delete(key);
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  await db.query("DELETE FROM sessions WHERE expires_at <= $1", [Date.now()]);
  await db.query(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
    [tokenHash, user.id, Date.now() + 30 * 24 * 60 * 60 * 1000],
  );
  res.setHeader(
    "Set-Cookie",
    `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${
      process.env.NODE_ENV === "production" ? "; Secure" : ""
    }`,
  );
  res.json({ user: publicUser({ ...user, isAdmin: user.is_admin, mustChangePassword: user.must_change_password }) });
});

app.post("/api/logout", requireAuth, async (req, res) => {
  const token = cookies(req).session;
  await db.query("DELETE FROM sessions WHERE token_hash = $1", [
    crypto.createHash("sha256").update(token).digest("hex"),
  ]);
  res.setHeader("Set-Cookie", "session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  res.status(204).end();
});

app.get("/api/me", requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

app.put("/api/password", requireAuth, async (req, res) => {
  const currentPassword = String(req.body.currentPassword || "");
  const newPassword = String(req.body.newPassword || "");
  if (newPassword.length < 10 || newPassword.length > 128) {
    return res.status(400).json({ error: "Nowe hasło musi mieć co najmniej 10 znaków." });
  }
  const current = (
    await db.query("SELECT password_hash FROM users WHERE id = $1", [req.user.id])
  ).rows[0];
  if (!bcrypt.compareSync(currentPassword, current.password_hash)) {
    return res.status(400).json({ error: "Obecne hasło jest nieprawidłowe." });
  }
  await db.query(
    "UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2",
    [bcrypt.hashSync(newPassword, 12), req.user.id],
  );
  res.status(204).end();
});

app.put("/api/profile", requireAuth, requireReady, async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Podaj poprawny adres e-mail." });
  }
  if (email.length > 254) return res.status(400).json({ error: "Adres e-mail jest za długi." });
  await db.query("UPDATE users SET email = $1 WHERE id = $2", [email, req.user.id]);
  notifyAll("status");
  res.json({ email });
});

app.get("/api/wishlist", requireAuth, requireReady, async (req, res) => {
  const items = (
    await db.query("SELECT id, content FROM wishlist_items WHERE user_id = $1 ORDER BY id", [
      req.user.id,
    ])
  ).rows;
  res.json({ items });
});

app.post("/api/wishlist", requireAuth, requireReady, async (req, res) => {
  const content = String(req.body.content || "").trim();
  if (!content || content.length > 300) {
    return res.status(400).json({ error: "Wpisz życzenie (maksymalnie 300 znaków)." });
  }
  if (
    Number(
      (
        await db.query("SELECT COUNT(*) AS count FROM wishlist_items WHERE user_id = $1", [
          req.user.id,
        ])
      ).rows[0].count,
    ) >= 30
  ) {
    return res.status(400).json({ error: "Lista może mieć maksymalnie 30 pozycji." });
  }
  const result = await db.query(
    "INSERT INTO wishlist_items (user_id, content) VALUES ($1, $2) RETURNING id",
    [req.user.id, content],
  );
  const item = { id: result.rows[0].id, content };
  const giver = (
    await db.query("SELECT giver_id FROM assignments WHERE receiver_id = $1", [req.user.id])
  ).rows[0];
  if (giver) notify(giver.giver_id, "assignment");
  notifyAll("status");
  res.status(201).json({ item });
});

app.delete("/api/wishlist/:id", requireAuth, requireReady, async (req, res) => {
  await db.query("DELETE FROM wishlist_items WHERE id = $1 AND user_id = $2", [
    Number(req.params.id),
    req.user.id,
  ]);
  const giver = (
    await db.query("SELECT giver_id FROM assignments WHERE receiver_id = $1", [req.user.id])
  ).rows[0];
  if (giver) notify(giver.giver_id, "assignment");
  notifyAll("status");
  res.status(204).end();
});

app.get("/api/assignment", requireAuth, requireReady, async (req, res) => {
  const assignment = (
    await db.query(
      `SELECT u.id, u.name
       FROM assignments a JOIN users u ON u.id = a.receiver_id
       WHERE a.giver_id = $1`,
      [req.user.id],
    )
  ).rows[0];
  if (!assignment) return res.json({ assignment: null });
  const items = (
    await db.query("SELECT id, content FROM wishlist_items WHERE user_id = $1 ORDER BY id", [
      assignment.id,
    ])
  ).rows;
  const instructions = (
    await db.query("SELECT value FROM settings WHERE key = 'instructions'")
  ).rows[0].value;
  res.json({ assignment: { name: assignment.name, items, instructions } });
});

app.get("/api/admin/status", requireAuth, requireReady, requireAdmin, async (req, res) => {
  const users = (
    await db.query(
      `SELECT u.id, u.login, u.name, u.email,
              COUNT(w.id)::INTEGER AS "itemCount"
       FROM users u LEFT JOIN wishlist_items w ON w.user_id = u.id
       GROUP BY u.id ORDER BY u.id`,
    )
  ).rows;
  const drawn =
    Number((await db.query("SELECT COUNT(*) AS count FROM assignments")).rows[0].count) ===
    USERS.length;
  const instructions = (
    await db.query("SELECT value FROM settings WHERE key = 'instructions'")
  ).rows[0].value;
  res.json({ users, drawn, instructions });
});

app.put("/api/admin/instructions", requireAuth, requireReady, requireAdmin, async (req, res) => {
  const instructions = String(req.body.instructions || "").trim();
  if (!instructions || instructions.length > 2000) {
    return res.status(400).json({ error: "Instrukcja musi mieć od 1 do 2000 znaków." });
  }
  await db.query("UPDATE settings SET value = $1 WHERE key = 'instructions'", [instructions]);
  notifyAll("assignment");
  res.status(204).end();
});

function shuffled(values) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const other = crypto.randomInt(index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

app.post("/api/admin/draw", requireAuth, requireReady, requireAdmin, async (req, res) => {
  if (Number((await db.query("SELECT COUNT(*) AS count FROM assignments")).rows[0].count)) {
    return res.status(409).json({ error: "Losowanie zostało już przeprowadzone." });
  }
  const users = (await db.query("SELECT id, name, email FROM users ORDER BY id")).rows;
  if (users.some((user) => !user.email)) {
    return res.status(400).json({ error: "Każdy uczestnik musi najpierw podać e-mail." });
  }

  const givers = shuffled(users);
  const receivers = [...givers.slice(1), givers[0]];
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (let index = 0; index < givers.length; index++) {
      await client.query("INSERT INTO assignments (giver_id, receiver_id) VALUES ($1, $2)", [
        givers[index].id,
        receivers[index].id,
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  notifyAll("assignment");

  const delivery = await sendAllEmails().catch((error) => {
    console.error("Błąd wysyłki maili:", error.message);
    return { sent: 0, failed: users.length };
  });
  res.json({ ok: true, delivery });
});

app.delete("/api/admin/draw", requireAuth, requireReady, requireAdmin, async (req, res) => {
  await db.query("DELETE FROM assignments");
  notifyAll("assignment");
  res.status(204).end();
});

app.post(
  "/api/admin/users/:id/reset-password",
  requireAuth,
  requireReady,
  requireAdmin,
  async (req, res) => {
    const target = (
      await db.query("SELECT id, login FROM users WHERE id = $1", [Number(req.params.id)])
    ).rows[0];
    if (!target) return res.status(404).json({ error: "Nie znaleziono użytkownika." });
    const password = crypto.randomBytes(6).toString("base64url");
    await db.query(
      "UPDATE users SET password_hash = $1, must_change_password = TRUE WHERE id = $2",
      [bcrypt.hashSync(password, 12), target.id],
    );
    await db.query("DELETE FROM sessions WHERE user_id = $1", [target.id]);
    res.json({ login: target.login, password });
  },
);

function mailTransport() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function sendResult(userId) {
  const transport = mailTransport();
  if (!transport) throw new Error("SMTP nie jest skonfigurowane.");
  const result = (
    await db.query(
      `SELECT giver.email, giver.name AS giver_name, receiver.name AS receiver_name
       FROM assignments a
       JOIN users giver ON giver.id = a.giver_id
       JOIN users receiver ON receiver.id = a.receiver_id
       WHERE giver.id = $1`,
      [userId],
    )
  ).rows[0];
  if (!result?.email) throw new Error("Brak adresu e-mail lub wyniku losowania.");
  const instructions = (
    await db.query("SELECT value FROM settings WHERE key = 'instructions'")
  ).rows[0].value;
  const items = (
    await db.query(
      `SELECT w.content FROM wishlist_items w
       JOIN assignments a ON a.receiver_id = w.user_id WHERE a.giver_id = $1 ORDER BY w.id`,
      [userId],
    )
  ).rows;
  const list = items.length ? items.map((item) => `• ${item.content}`).join("\n") : "Lista jest jeszcze pusta.";
  await transport.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: result.email,
    subject: "🎅 Twój wynik rodzinnych Mikołajek",
    text: `Cześć ${result.giver_name}!\n\nWylosowana osoba: ${result.receiver_name}\n\nWishlista:\n${list}\n\nInstrukcja:\n${instructions}\n\nHo, ho, ho!`,
  });
}

async function sendAllEmails() {
  const ids = (await db.query("SELECT giver_id FROM assignments")).rows;
  let sent = 0;
  let failed = 0;
  for (const { giver_id: id } of ids) {
    try {
      await sendResult(id);
      sent++;
    } catch (error) {
      failed++;
      console.error(`Nie udało się wysłać maila użytkownikowi ${id}:`, error.message);
    }
  }
  return { sent, failed };
}

app.post("/api/assignment/email", requireAuth, requireReady, async (req, res) => {
  try {
    await sendResult(req.user.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
});

app.get("/api/events", requireAuth, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const clients = sseClients.get(req.user.id) || new Set();
  clients.add(res);
  sseClients.set(req.user.id, clients);
  res.write("event: connected\ndata: {}\n\n");
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(res);
    if (!clients.size) sseClients.delete(req.user.id);
  });
});

app.get("/{*splat}", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: "Wystąpił nieoczekiwany błąd." });
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Święta na Czapli działają na http://0.0.0.0:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Nie udało się uruchomić bazy danych:", error);
    process.exit(1);
  });

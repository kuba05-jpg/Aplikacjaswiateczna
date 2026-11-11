const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const nodemailer = require("nodemailer");

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const USERS = [
  ["asia", "Asia", 0],
  ["kacper", "Kacper", 0],
  ["ada", "Ada", 0],
  ["mama", "Mama", 0],
  ["tata", "Tata", 0],
  ["kuba", "Kuba", 1],
];
const DEFAULT_INSTRUCTIONS =
  "Przygotuj prezent z sercem. Nie zdradzaj, kogo wylosowałeś/aś, i przynieś podpisany prezent na nasze rodzinne Mikołajki.";

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "mikolajki.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    login TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    is_admin INTEGER NOT NULL DEFAULT 0,
    must_change_password INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS wishlist_items (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS assignments (
    giver_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const addUser = db.prepare(
  "INSERT OR IGNORE INTO users (login, name, password_hash, is_admin) VALUES (?, ?, ?, ?)",
);
for (const [login, name, isAdmin] of USERS) {
  if (!db.prepare("SELECT 1 FROM users WHERE login = ?").get(login)) {
    const password = crypto.randomBytes(6).toString("base64url");
    addUser.run(login, name, bcrypt.hashSync(password, 12), isAdmin);
    console.log(`Konto startowe — login: ${login.padEnd(7)} hasło: ${password}`);
  }
}
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('instructions', ?)").run(
  DEFAULT_INSTRUCTIONS,
);

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

function sessionUser(req) {
  const token = cookies(req).session;
  if (!token) return null;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  return (
    db
      .prepare(
        `SELECT u.id, u.login, u.name, u.email, u.is_admin AS isAdmin,
                u.must_change_password AS mustChangePassword
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(tokenHash, Date.now()) || null
  );
}

function requireAuth(req, res, next) {
  const user = sessionUser(req);
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

app.post("/api/login", (req, res) => {
  const login = String(req.body.login || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const key = `${req.ip}:${login}`;
  const attempt = loginAttempts.get(key);
  if (attempt?.blockedUntil > Date.now()) {
    return res.status(429).json({ error: "Za dużo prób. Spróbuj ponownie za 15 minut." });
  }

  const user = db.prepare("SELECT * FROM users WHERE login = ?").get(login);
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
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(
    tokenHash,
    user.id,
    Date.now() + 30 * 24 * 60 * 60 * 1000,
  );
  res.setHeader(
    "Set-Cookie",
    `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${
      process.env.NODE_ENV === "production" ? "; Secure" : ""
    }`,
  );
  res.json({ user: publicUser({ ...user, isAdmin: user.is_admin, mustChangePassword: user.must_change_password }) });
});

app.post("/api/logout", requireAuth, (req, res) => {
  const token = cookies(req).session;
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(
    crypto.createHash("sha256").update(token).digest("hex"),
  );
  res.setHeader("Set-Cookie", "session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  res.status(204).end();
});

app.get("/api/me", requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

app.put("/api/password", requireAuth, (req, res) => {
  const currentPassword = String(req.body.currentPassword || "");
  const newPassword = String(req.body.newPassword || "");
  if (newPassword.length < 10 || newPassword.length > 128) {
    return res.status(400).json({ error: "Nowe hasło musi mieć co najmniej 10 znaków." });
  }
  const current = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.user.id);
  if (!bcrypt.compareSync(currentPassword, current.password_hash)) {
    return res.status(400).json({ error: "Obecne hasło jest nieprawidłowe." });
  }
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(
    bcrypt.hashSync(newPassword, 12),
    req.user.id,
  );
  res.status(204).end();
});

app.put("/api/profile", requireAuth, requireReady, (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Podaj poprawny adres e-mail." });
  }
  if (email.length > 254) return res.status(400).json({ error: "Adres e-mail jest za długi." });
  db.prepare("UPDATE users SET email = ? WHERE id = ?").run(email, req.user.id);
  notifyAll("status");
  res.json({ email });
});

app.get("/api/wishlist", requireAuth, requireReady, (req, res) => {
  const items = db
    .prepare("SELECT id, content FROM wishlist_items WHERE user_id = ? ORDER BY id")
    .all(req.user.id);
  res.json({ items });
});

app.post("/api/wishlist", requireAuth, requireReady, (req, res) => {
  const content = String(req.body.content || "").trim();
  if (!content || content.length > 300) {
    return res.status(400).json({ error: "Wpisz życzenie (maksymalnie 300 znaków)." });
  }
  if (
    db.prepare("SELECT COUNT(*) AS count FROM wishlist_items WHERE user_id = ?").get(req.user.id)
      .count >= 30
  ) {
    return res.status(400).json({ error: "Lista może mieć maksymalnie 30 pozycji." });
  }
  const result = db
    .prepare("INSERT INTO wishlist_items (user_id, content) VALUES (?, ?)")
    .run(req.user.id, content);
  const item = { id: Number(result.lastInsertRowid), content };
  const giver = db.prepare("SELECT giver_id FROM assignments WHERE receiver_id = ?").get(req.user.id);
  if (giver) notify(giver.giver_id, "assignment");
  notifyAll("status");
  res.status(201).json({ item });
});

app.delete("/api/wishlist/:id", requireAuth, requireReady, (req, res) => {
  db.prepare("DELETE FROM wishlist_items WHERE id = ? AND user_id = ?").run(
    Number(req.params.id),
    req.user.id,
  );
  const giver = db.prepare("SELECT giver_id FROM assignments WHERE receiver_id = ?").get(req.user.id);
  if (giver) notify(giver.giver_id, "assignment");
  notifyAll("status");
  res.status(204).end();
});

app.get("/api/assignment", requireAuth, requireReady, (req, res) => {
  const assignment = db
    .prepare(
      `SELECT u.id, u.name
       FROM assignments a JOIN users u ON u.id = a.receiver_id
       WHERE a.giver_id = ?`,
    )
    .get(req.user.id);
  if (!assignment) return res.json({ assignment: null });
  const items = db
    .prepare("SELECT id, content FROM wishlist_items WHERE user_id = ? ORDER BY id")
    .all(assignment.id);
  const instructions = db.prepare("SELECT value FROM settings WHERE key = 'instructions'").get().value;
  res.json({ assignment: { name: assignment.name, items, instructions } });
});

app.get("/api/admin/status", requireAuth, requireReady, requireAdmin, (req, res) => {
  const users = db
    .prepare(
      `SELECT u.id, u.login, u.name, u.email,
              COUNT(w.id) AS itemCount
       FROM users u LEFT JOIN wishlist_items w ON w.user_id = u.id
       GROUP BY u.id ORDER BY u.id`,
    )
    .all();
  const drawn = db.prepare("SELECT COUNT(*) AS count FROM assignments").get().count === USERS.length;
  const instructions = db.prepare("SELECT value FROM settings WHERE key = 'instructions'").get().value;
  res.json({ users, drawn, instructions });
});

app.put("/api/admin/instructions", requireAuth, requireReady, requireAdmin, (req, res) => {
  const instructions = String(req.body.instructions || "").trim();
  if (!instructions || instructions.length > 2000) {
    return res.status(400).json({ error: "Instrukcja musi mieć od 1 do 2000 znaków." });
  }
  db.prepare("UPDATE settings SET value = ? WHERE key = 'instructions'").run(instructions);
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
  if (db.prepare("SELECT COUNT(*) AS count FROM assignments").get().count) {
    return res.status(409).json({ error: "Losowanie zostało już przeprowadzone." });
  }
  const users = db.prepare("SELECT id, name, email FROM users ORDER BY id").all();
  if (users.some((user) => !user.email)) {
    return res.status(400).json({ error: "Każdy uczestnik musi najpierw podać e-mail." });
  }

  const givers = shuffled(users);
  const receivers = [...givers.slice(1), givers[0]];
  const save = db.transaction(() => {
    const insert = db.prepare("INSERT INTO assignments (giver_id, receiver_id) VALUES (?, ?)");
    givers.forEach((giver, index) => insert.run(giver.id, receivers[index].id));
  });
  save();
  notifyAll("assignment");

  const delivery = await sendAllEmails().catch((error) => {
    console.error("Błąd wysyłki maili:", error.message);
    return { sent: 0, failed: users.length };
  });
  res.json({ ok: true, delivery });
});

app.delete("/api/admin/draw", requireAuth, requireReady, requireAdmin, (req, res) => {
  db.prepare("DELETE FROM assignments").run();
  notifyAll("assignment");
  res.status(204).end();
});

app.post("/api/admin/users/:id/reset-password", requireAuth, requireReady, requireAdmin, (req, res) => {
  const target = db.prepare("SELECT id, login FROM users WHERE id = ?").get(Number(req.params.id));
  if (!target) return res.status(404).json({ error: "Nie znaleziono użytkownika." });
  const password = crypto.randomBytes(6).toString("base64url");
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?").run(
    bcrypt.hashSync(password, 12),
    target.id,
  );
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(target.id);
  res.json({ login: target.login, password });
});

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
  const result = db
    .prepare(
      `SELECT giver.email, giver.name AS giver_name, receiver.name AS receiver_name
       FROM assignments a
       JOIN users giver ON giver.id = a.giver_id
       JOIN users receiver ON receiver.id = a.receiver_id
       WHERE giver.id = ?`,
    )
    .get(userId);
  if (!result?.email) throw new Error("Brak adresu e-mail lub wyniku losowania.");
  const instructions = db.prepare("SELECT value FROM settings WHERE key = 'instructions'").get().value;
  const items = db
    .prepare(
      `SELECT w.content FROM wishlist_items w
       JOIN assignments a ON a.receiver_id = w.user_id WHERE a.giver_id = ? ORDER BY w.id`,
    )
    .all(userId);
  const list = items.length ? items.map((item) => `• ${item.content}`).join("\n") : "Lista jest jeszcze pusta.";
  await transport.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: result.email,
    subject: "🎅 Twój wynik rodzinnych Mikołajek",
    text: `Cześć ${result.giver_name}!\n\nWylosowana osoba: ${result.receiver_name}\n\nWishlista:\n${list}\n\nInstrukcja:\n${instructions}\n\nHo, ho, ho!`,
  });
}

async function sendAllEmails() {
  const ids = db.prepare("SELECT giver_id FROM assignments").all();
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Mikołajki działają na http://0.0.0.0:${PORT}`);
});

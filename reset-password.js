const crypto = require("node:crypto");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");

const login = String(process.argv[2] || "").trim().toLowerCase();
if (!login) {
  console.error("Użycie: node reset-password.js <login>");
  process.exit(1);
}

const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const db = new Database(path.join(dataDir, "mikolajki.db"));
const user = db.prepare("SELECT id FROM users WHERE login = ?").get(login);
if (!user) {
  console.error(`Nie istnieje konto: ${login}`);
  process.exit(1);
}

const password = crypto.randomBytes(6).toString("base64url");
db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?").run(
  bcrypt.hashSync(password, 12),
  user.id,
);
db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
console.log(`login: ${login}   nowe hasło: ${password}`);
db.close();

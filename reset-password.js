const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const login = String(process.argv[2] || "").trim().toLowerCase();
if (!login) {
  console.error("Użycie: node reset-password.js <login>");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("Brak zmiennej DATABASE_URL.");
  process.exit(1);
}

const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

async function resetPassword() {
  const user = (await db.query("SELECT id FROM users WHERE login = $1", [login])).rows[0];
  if (!user) throw new Error(`Nie istnieje konto: ${login}`);

  const password = crypto.randomBytes(6).toString("base64url");
  await db.query(
    "UPDATE users SET password_hash = $1, must_change_password = TRUE WHERE id = $2",
    [bcrypt.hashSync(password, 12), user.id],
  );
  await db.query("DELETE FROM sessions WHERE user_id = $1", [user.id]);
  console.log(`login: ${login}   nowe hasło: ${password}`);
}

resetPassword()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => db.end());

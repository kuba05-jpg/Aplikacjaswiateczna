# 🎅 Rodzinne Mikołajki

Prywatna aplikacja dla sześciu osób: Asia, Kacper, Ada, Mama, Tata i Kuba (administrator).

## Możliwości

- logowanie bez publicznej rejestracji i hasła zabezpieczone bcrypt,
- osobna wishlista każdej osoby, aktualizowana na żywo,
- bezpieczne losowanie, w którym nikt nie trafi na siebie i każdy zostanie wylosowany raz,
- wynik widoczny wyłącznie dla osoby kupującej prezent,
- wysyłka wyniku przez SMTP,
- panel administratora bez podglądu wyników innych osób,
- reset haseł i wyników losowania.

## Uruchomienie lokalne

Wymagany jest Node.js 20 lub nowszy.

```bash
npm install
npm start
```

Otwórz `http://localhost:3000`. Przy pierwszym uruchomieniu tymczasowe hasła sześciu kont zostaną wypisane w konsoli. Każdy użytkownik musi zmienić hasło po pierwszym logowaniu.

Bez konfiguracji SMTP wszystkie funkcje poza wysyłką wiadomości działają normalnie.

## Wysyłka e-maili

Ustaw następujące zmienne środowiskowe:

```text
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=login-smtp
SMTP_PASS=klucz-smtp
MAIL_FROM=Mikołajki <potwierdzony@adres.pl>
```

## Wdrożenie na Fly.io

1. Zainstaluj `flyctl` i zaloguj się poleceniem `fly auth login`.
2. Utwórz aplikację: `fly apps create unikalna-nazwa`.
3. Wpisz tę samą nazwę w polu `app` w `fly.toml`.
4. Utwórz dysk:

   ```bash
   fly volumes create mikolajki_data --region waw --size 1
   ```

5. Dodaj sekrety:

   ```bash
   fly secrets set \
     SMTP_HOST=smtp-relay.brevo.com \
     SMTP_PORT=587 \
     SMTP_USER=login-smtp \
     SMTP_PASS=klucz-smtp \
     MAIL_FROM="Mikołajki <potwierdzony@adres.pl>"
   ```

6. Wdróż jedną maszynę, ponieważ SQLite używa jednego dysku:

   ```bash
   fly deploy --ha=false
   ```

Hasła startowe znajdziesz w `fly logs`. Awaryjny reset hasła:

```bash
fly ssh console -C "node /app/reset-password.js kuba"
```

Baza danych znajduje się w `/data/mikolajki.db`. Można pobrać jej kopię poleceniem:

```bash
fly ssh sftp get /data/mikolajki.db
```

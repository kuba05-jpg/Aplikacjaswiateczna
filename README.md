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

## Wdrożenie na Render

Plik `render.yaml` zawiera gotową konfigurację serwisu, testu zdrowia i trwałego dysku dla bazy SQLite.

> Render pobiera kod wyłącznie z GitHub, GitLab albo Bitbucket. Repozytorium musi być dostępne u jednego z tych dostawców. Trwały dysk wymaga płatnego serwisu; wariant bez dysku utraci konta, wishlisty i wyniki po restarcie.

1. Umieść repozytorium na GitHubie, GitLabie albo Bitbucket.
2. Otwórz [Render Dashboard](https://dashboard.render.com/), wybierz **New → Blueprint** i połącz repozytorium.
3. Render odczyta `render.yaml`. Podczas tworzenia wpisz wartości sekretów SMTP:
   - `SMTP_HOST` — np. `smtp-relay.brevo.com`,
   - `SMTP_PORT` — np. `587`,
   - `SMTP_USER`,
   - `SMTP_PASS`,
   - `MAIL_FROM` — np. `Mikołajki <potwierdzony@adres.pl>`.
4. Zatwierdź Blueprint i poczekaj, aż test `/api/health` uzyska status `healthy`.
5. Otwórz logi pierwszego uruchomienia i bezpiecznie zapisz wygenerowane hasła startowe.

Nie ustawiaj ręcznie `PORT` — Render przekazuje go automatycznie, a aplikacja już nasłuchuje na `0.0.0.0:$PORT`.

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

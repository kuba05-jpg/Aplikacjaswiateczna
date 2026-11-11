# 🎅 Święta na Czapli

Prywatna aplikacja dla pięciu osób: Asia, Kacper, Mama, Tata i Kuba (administrator).

## Możliwości

- logowanie bez publicznej rejestracji i hasła zabezpieczone bcrypt,
- osobna wishlista każdej osoby z opcjonalnymi linkami i zdjęciami, aktualizowana na żywo,
- bezpieczne losowanie, w którym nikt nie trafi na siebie i każdy zostanie wylosowany raz,
- wynik dostępny na koncie wyłącznie dla osoby kupującej prezent,
- panel administratora bez podglądu wyników innych osób,
- reset haseł i wyników losowania.

## Uruchomienie lokalne

Wymagany jest Node.js 20 lub nowszy.

```bash
npm install
DATABASE_URL=postgresql://uzytkownik:haslo@localhost:5432/mikolajki npm start
```

Otwórz `http://localhost:3000`. Aplikacja automatycznie utworzy tabele w podłączonej bazie PostgreSQL. Przy pierwszym uruchomieniu tymczasowe hasła pięciu kont zostaną wypisane w konsoli. Każdy użytkownik musi zmienić hasło po pierwszym logowaniu.

## Wdrożenie na Render

Plik `render.yaml` zawiera gotową konfigurację darmowego serwisu, testu zdrowia i darmowej bazy PostgreSQL.

> Render pobiera kod wyłącznie z GitHub, GitLab albo Bitbucket. Repozytorium musi być dostępne u jednego z tych dostawców. Darmowy serwis usypia po 15 minutach bezczynności, a darmowa baza Render wygasa po 30 dniach.

1. Umieść repozytorium na GitHubie, GitLabie albo Bitbucket.
2. Otwórz [Render Dashboard](https://dashboard.render.com/), wybierz **New → Blueprint** i połącz repozytorium.
3. Render odczyta `render.yaml` i utworzy serwis oraz bazę.
4. Zatwierdź Blueprint i poczekaj, aż test `/api/health` uzyska status `healthy`.
5. Otwórz logi pierwszego uruchomienia i bezpiecznie zapisz wygenerowane hasła startowe.

Nie ustawiaj ręcznie `PORT` — Render przekazuje go automatycznie, a aplikacja już nasłuchuje na `0.0.0.0:$PORT`.

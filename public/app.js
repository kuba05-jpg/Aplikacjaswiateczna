const state = { user: null, wishlist: [], assignment: null, admin: null, events: null };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && state.user) showLogin();
    throw new Error(data.error || "Nie udało się wykonać operacji.");
  }
  return data;
}

function toast(message, bad = false) {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast show${bad ? " bad" : ""}`;
  clearTimeout(toast.timeout);
  toast.timeout = setTimeout(() => (element.className = "toast"), 3500);
}

function setView(name) {
  ["login", "password", "app"].forEach((view) => {
    $(`#${view}-view`).classList.toggle("hidden", view !== name);
  });
}

function showLogin() {
  state.events?.close();
  state.user = null;
  setView("login");
}

async function boot() {
  try {
    const { user } = await api("/api/me");
    state.user = user;
    if (user.mustChangePassword) setView("password");
    else await enterApp();
  } catch {
    showLogin();
  }
}

async function enterApp() {
  setView("app");
  const user = state.user;
  $("#sidebar-name").textContent = user.name;
  $("#sidebar-avatar").textContent = user.name[0];
  $("#sidebar-role").textContent = user.isAdmin ? "Administrator" : "Uczestnik";
  $("#home-name").textContent = user.name;
  $("#admin-nav").classList.toggle("hidden", !user.isAdmin);
  connectEvents();
  await Promise.all([loadWishlist(), loadAssignment(), user.isAdmin ? loadAdmin() : null]);
  showPage("home");
}

function showPage(name) {
  $$(".page").forEach((page) => page.classList.toggle("active", page.id === `page-${name}`));
  $$(".nav-link").forEach((link) => link.classList.toggle("active", link.dataset.page === name));
  $(".sidebar").classList.remove("open");
  if (name === "wishlist") loadWishlist();
  if (name === "assignment") loadAssignment();
  if (name === "admin" && state.user.isAdmin) loadAdmin();
}

function connectEvents() {
  state.events?.close();
  state.events = new EventSource("/api/events");
  state.events.addEventListener("assignment", () => {
    loadAssignment();
    if (state.user?.isAdmin) loadAdmin();
  });
  state.events.addEventListener("status", () => {
    if (state.user?.isAdmin) loadAdmin();
  });
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = $("#login-error");
  error.textContent = "";
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    const { user } = await api("/api/login", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    state.user = user;
    if (user.mustChangePassword) setView("password");
    else await enterApp();
    form.reset();
  } catch (failure) {
    error.textContent = failure.message;
  } finally {
    button.disabled = false;
  }
});

$("#password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  const error = $("#password-error");
  error.textContent = "";
  if (values.newPassword !== values.confirmPassword) {
    error.textContent = "Nowe hasła nie są takie same.";
    return;
  }
  try {
    await api("/api/password", {
      method: "PUT",
      body: JSON.stringify({ newPassword: values.newPassword }),
    });
    state.user.mustChangePassword = false;
    event.currentTarget.reset();
    await enterApp();
    toast("Hasło zostało ustawione.");
  } catch (failure) {
    error.textContent = failure.message;
  }
});

$("#logout-button").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => null);
  showLogin();
});

$$(".nav-link").forEach((button) =>
  button.addEventListener("click", () => showPage(button.dataset.page)),
);
$$("[data-go]").forEach((button) =>
  button.addEventListener("click", () => showPage(button.dataset.go)),
);
$("#menu-button").addEventListener("click", () => $(".sidebar").classList.toggle("open"));

async function loadWishlist() {
  try {
    const { items } = await api("/api/wishlist");
    state.wishlist = items;
    renderWishlist();
    $("#home-item-count").textContent = `${items.length} ${
      items.length === 1 ? "pomysł" : items.length > 1 && items.length < 5 ? "pomysły" : "pomysłów"
    } na prezent`;
  } catch (failure) {
    toast(failure.message, true);
  }
}

function renderWishlist() {
  const target = $("#wishlist-list");
  if (!state.wishlist.length) {
    target.innerHTML = `<div class="empty-state"><span>🎁</span><h3>Lista jest jeszcze pusta</h3><p>Dodaj pierwszy pomysł — duży lub całkiem mały.</p></div>`;
    return;
  }
  target.innerHTML = state.wishlist
    .map(
      (item, index) => `<article class="wish-item">
        <span class="wish-number">${index + 1}</span>
        <p>${escapeHtml(item.content)}</p>
        <button class="delete-button" data-delete="${item.id}" aria-label="Usuń pozycję">✕</button>
      </article>`,
    )
    .join("");
  $$("[data-delete]").forEach((button) =>
    button.addEventListener("click", async () => {
      try {
        await api(`/api/wishlist/${button.dataset.delete}`, { method: "DELETE" });
        await loadWishlist();
        toast("Usunięto z listy.");
      } catch (failure) {
        toast(failure.message, true);
      }
    }),
  );
}

$("#wishlist-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const content = form.elements.content.value;
  try {
    await api("/api/wishlist", { method: "POST", body: JSON.stringify({ content }) });
    form.reset();
    await loadWishlist();
    $("#wishlist-message").textContent = "Dodano do Twojej listy.";
  } catch (failure) {
    $("#wishlist-message").textContent = failure.message;
    $("#wishlist-message").classList.add("error");
  }
});

async function loadAssignment() {
  try {
    const { assignment } = await api("/api/assignment");
    state.assignment = assignment;
    renderAssignment();
    $("#home-draw-status").textContent = assignment ? "Twój los już na Ciebie czeka" : "Jeszcze nie wylosowano";
    $("#draw-badge").textContent = assignment ? "● LOSOWANIE ZAKOŃCZONE" : "● PRZED LOSOWANIEM";
    $("#hero-title").textContent = assignment ? "Świąteczna tajemnica odkryta!" : "Twoja lista marzeń czeka";
    $("#hero-text").textContent = assignment
      ? "Twój tajny los już czeka. Zajrzyj do wishlisty i wybierz prezent od serca."
      : "Dodaj kilka pomysłów, aby Twój Mikołaj dokładnie wiedział, co sprawi Ci radość.";
  } catch (failure) {
    toast(failure.message, true);
  }
}

function renderAssignment() {
  const target = $("#assignment-content");
  if (!state.assignment) {
    target.innerHTML = `<div class="empty-state"><span>🔒</span><h3>Jeszcze chwila cierpliwości</h3><p>Administrator nie przeprowadził jeszcze losowania. Gdy to zrobi, wynik pojawi się tutaj.</p></div>`;
    return;
  }
  const items = state.assignment.items.length
    ? `<ul class="recipient-list">${state.assignment.items.map((item) => `<li>♡ &nbsp;${escapeHtml(item.content)}</li>`).join("")}</ul>`
    : `<p class="muted">Ta osoba nie dodała jeszcze żadnych pomysłów. Wróć tu później — lista aktualizuje się na żywo.</p>`;
  target.innerHTML = `<article class="assignment-card">
    <div class="assignment-reveal"><p class="eyebrow">Przygotowujesz prezent dla</p><h2 class="assignment-name">${escapeHtml(state.assignment.name)}</h2><p>Niech to pozostanie między nami 🤫</p></div>
    <div class="assignment-body">
      <div><h3>Wishlista</h3>${items}</div>
      <div><h3>Instrukcja</h3><div class="instructions">${escapeHtml(state.assignment.instructions)}</div></div>
    </div>
  </article>`;
}

$("#change-password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = $("#change-password-message");
  try {
    await api("/api/password", {
      method: "PUT",
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    form.reset();
    message.textContent = "Hasło zostało zmienione.";
    message.className = "form-message";
  } catch (failure) {
    message.textContent = failure.message;
    message.className = "form-message error";
  }
});

async function loadAdmin() {
  try {
    state.admin = await api("/api/admin/status");
    renderAdmin();
  } catch (failure) {
    toast(failure.message, true);
  }
}

function renderAdmin() {
  const { users, drawn, instructions } = state.admin;
  $("#admin-content").innerHTML = `<div class="admin-grid">
    <section class="admin-card"><h2>Gotowość uczestników</h2>
      ${users
        .map(
          (user) => `<div class="participant-row">
            <div><strong>${escapeHtml(user.name)}</strong><small>${user.itemCount} poz. na liście</small></div>
            <button class="mini-button" data-reset="${user.id}" data-login="${escapeHtml(user.login)}">Reset hasła</button>
          </div>`,
        )
        .join("")}
    </section>
    <div class="admin-actions">
      <section class="admin-card"><h2>Losowanie</h2>
        <div class="draw-state"><strong>${drawn ? "✓ Losowanie zakończone" : `${users.length} uczestników`}</strong><small>${drawn ? "Wyniki są widoczne tylko dla uczestników." : "Wyniki pojawią się na kontach uczestników."}</small></div>
        ${
          drawn
            ? `<button id="reset-draw-button" class="button button-danger">Usuń wyniki losowania</button>`
            : `<button id="draw-button" class="button button-primary">🎲 Przeprowadź losowanie</button>`
        }
      </section>
      <form id="instructions-form" class="admin-card"><h2>Instrukcja</h2>
        <textarea name="instructions" maxlength="2000" required>${escapeHtml(instructions)}</textarea>
        <button class="button button-secondary" type="submit">Zapisz instrukcję</button>
      </form>
    </div>
  </div>`;

  $("#instructions-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/admin/instructions", {
        method: "PUT",
        body: JSON.stringify({ instructions: event.currentTarget.elements.instructions.value }),
      });
      toast("Instrukcja została zapisana.");
    } catch (failure) {
      toast(failure.message, true);
    }
  });

  $("#draw-button")?.addEventListener("click", async (event) => {
    if (!confirm("Przeprowadzić losowanie? Wyniki pojawią się na kontach uczestników.")) return;
    event.currentTarget.disabled = true;
    try {
      await api("/api/admin/draw", { method: "POST" });
      await loadAdmin();
      toast("Losowanie zakończone. Wyniki są dostępne na kontach uczestników.");
    } catch (failure) {
      toast(failure.message, true);
      event.currentTarget.disabled = false;
    }
  });

  $("#reset-draw-button")?.addEventListener("click", async () => {
    if (!confirm("Na pewno usunąć wszystkie wyniki losowania?")) return;
    try {
      await api("/api/admin/draw", { method: "DELETE" });
      await loadAdmin();
      toast("Wyniki losowania zostały usunięte.");
    } catch (failure) {
      toast(failure.message, true);
    }
  });

  $$("[data-reset]").forEach((button) =>
    button.addEventListener("click", async () => {
      if (!confirm(`Wygenerować nowe hasło startowe dla konta ${button.dataset.login}?`)) return;
      try {
        const result = await api(`/api/admin/users/${button.dataset.reset}/reset-password`, {
          method: "POST",
        });
        alert(`Nowe dane logowania:\n\nlogin: ${result.login}\nhasło: ${result.password}\n\nPrzekaż je tej osobie prywatnie.`);
      } catch (failure) {
        toast(failure.message, true);
      }
    }),
  );
}

boot();

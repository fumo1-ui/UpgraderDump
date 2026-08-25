/*
 * mock-login.js
 *
 * Локальная подмена API для дампа upgrader.vip (Angular использует XHR).
 * - Мокаются auth/юзер-эндпоинты: вход без Steam, фейковый пользователь,
 *   инвентарь, уведомления.
 * - Покупка/продажа/апгрейд/вывод/депозит работают локально (демо-экономика):
 *   баланс и инвентарь хранятся в localStorage.
 * - Остальные /api/* (магазин скинов, live-drops, статистика) проходят на
 *   локальный прокси-сервер server.py, который отдаёт реальные данные.
 * - "Войти через Steam" -> GET /api/users/auth/steam/redirect-url возвращает
 *   ?token=...&refreshToken=..., приложение само вызывает handleAuthCallbackToken.
 * - Ник берётся из localStorage "up_mock_nickname" (виджет регистрации в index.html).
 */
(function () {
  if (window.__upgraderMockInstalled) return;
  window.__upgraderMockInstalled = true;

  var NativeXHR = window.XMLHttpRequest;
  var NativeFetch = window.fetch;

  var LS_KEYS = {
    nick: "up_mock_nickname",
    balance: "up_mock_balance",
    inventory: "up_mock_inventory",
    shopCache: "up_mock_shop_cache",
    loggedOut: "up_mock_logged_out",
  };

  var MOCK = {
    token: "mock_token_" + Math.random().toString(36).slice(2, 12),
    refreshToken: "mock_refresh_" + Math.random().toString(36).slice(2, 12),
  };

  // Демо-баланс: ноль — новый аккаунт начинается без денег.
  // Пополнение идёт через кнопку "Top up" (см. createDemoInvoice).
  var DEMO_BALANCE = 0;

  function lsGet(key, def) {
    try {
      var v = window.localStorage.getItem(key);
      return v === null ? def : v;
    } catch (e) {
      return def;
    }
  }
  function lsSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {}
  }
  function lsDel(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (e) {}
  }

  function getBalance() {
    return parseFloat(lsGet(LS_KEYS.balance, "0")) || 0;
  }
  function setBalance(v) {
    lsSet(LS_KEYS.balance, (Math.round(v * 100) / 100).toString());
  }
  function getInventory() {
    try {
      var arr = JSON.parse(lsGet(LS_KEYS.inventory, "[]"));
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }
  function setInventory(arr) {
    lsSet(LS_KEYS.inventory, JSON.stringify(arr));
  }
  function getShopCache() {
    try {
      var arr = JSON.parse(lsGet(LS_KEYS.shopCache, "[]"));
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }
  function mergeShopCache(items) {
    if (!items || !items.length) return;
    var prev = getShopCache();
    var merged = prev.slice();
    items.forEach(function (s) {
      var i = merged.findIndex(function (m) {
        return String(m.id) === String(s.id);
      });
      if (i >= 0) merged[i] = s;
      else merged.push(s);
    });
    lsSet(LS_KEYS.shopCache, JSON.stringify(merged));
  }
  var invCounter = 0;
  function nextInvId() {
    invCounter += 1;
    return "mock_inv_" + Date.now().toString(36) + "_" + invCounter;
  }

  // Фейковый WebSocket: приложение слушает событие users.update_balance и
  // обновляет баланс в шапке. Реального сокета на локальном сервере нет.
  var mockSockets = [];
  function MockWebSocket(url) {
    this.url = url;
    this.readyState = 0;
    var self = this;
    mockSockets.push(this);
    setTimeout(function () {
      if (self.readyState === 3) return;
      self.readyState = 1;
      if (typeof self.onopen === "function") {
        try {
          self.onopen({ type: "open" });
        } catch (e) {}
      }
    }, 20);
  }
  MockWebSocket.CONNECTING = 0;
  MockWebSocket.OPEN = 1;
  MockWebSocket.CLOSING = 2;
  MockWebSocket.CLOSED = 3;
  MockWebSocket.prototype.send = function (data) {
    // исходящие (auth/ping/subscribe) никуда не уходят — достаточно подписок
  };
  MockWebSocket.prototype.close = function (code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    var i = mockSockets.indexOf(this);
    if (i >= 0) mockSockets.splice(i, 1);
    if (typeof this.onclose === "function") {
      try {
        this.onclose({ code: code || 1000, reason: reason || "" });
      } catch (e) {}
    }
  };
  window.WebSocket = MockWebSocket;

  function pushSocketEvent(event, data) {
    var msg = JSON.stringify({ event: event, data: data });
    for (var i = 0; i < mockSockets.length; i++) {
      var s = mockSockets[i];
      if (s.readyState === 1 && typeof s.onmessage === "function") {
        try {
          s.onmessage({ data: msg });
        } catch (e) {}
      }
    }
  }
  function pushBalanceEvent() {
    pushSocketEvent("users.update_balance", getBalance().toFixed(2));
  }

  // Обработка ?mock_deposit=<сумма> после демо-пополнения (redirect из create-invoice).
  function handleMockDeposit() {
    try {
      var url = new URL(window.location.href);
      var amount = url.searchParams.get("mock_deposit");
      if (amount !== null && amount !== "") {
        var v = parseFloat(amount);
        if (isFinite(v) && v > 0) {
          v = Math.min(100000, v);
          setBalance(getBalance() + v);
          pushBalanceEvent();
        }
        url.searchParams.delete("mock_deposit");
        window.history.replaceState({}, "", url.toString());
        console.log("[mock-login] demo deposit +" + v);
      }
    } catch (e) {}
  }
  handleMockDeposit();

  // Предзагрузка кеша магазина для быстрых покупок
  function preloadShopCache() {
    try {
      // Загружаем первые 100 предметов асинхронно
      fetch("/api/items/shop?sortBy=price&sortDirection=DESC&offset=0&limit=100")
        .then(function (res) { return res.json(); })
        .then(function (j) {
          if (j && Array.isArray(j.items) && j.items.length) {
            mergeShopCache(j.items);
            console.log("[mock-login] shop cache preloaded with", j.items.length, "items");
          }
        })
        .catch(function (e) {
          console.log("[mock-login] shop cache preload failed", e);
        });
    } catch (e) {}
  }

  // Автовход: если токена нет ни в URL (?token=/?code=), ни в localStorage
  // (auth_token), записываем мок-токен в localStorage ДО старта Angular.
  // authService.initializeAuth() в конструкторе видит токен и вызывает
  // loadCurrentUser(), а роутер-гарды (/profile) проходят сразу, без гонки
  // с асинхронным /users/me. Если юзер вышел (up_mock_logged_out=1) — не логиним.
  function ensureAutoLogin() {
    try {
      var url = new URL(window.location.href);
      if (url.searchParams.get("token") || url.searchParams.get("code")) return;
      if (window.localStorage.getItem("auth_token")) return;
      if (lsGet(LS_KEYS.loggedOut, "") === "1") return;
      window.localStorage.setItem("auth_token", MOCK.token);
      window.localStorage.setItem("refresh_token", MOCK.refreshToken);
      console.log("[mock-login] auto-login: token saved to localStorage");
    } catch (e) {
      console.log("[mock-login] auto-login failed", e);
    }
    // Инициализация хранилищ, если они пустые. Баланс оставляем нулевым:
    // новый аккаунт начинает без денег, пополняется через "Top up".
    if (!localStorage.getItem(LS_KEYS.inventory)) {
      setInventory([]);
    }
  }
  ensureAutoLogin();

  // Автоподтверждение всплывающих блокеров: cookie-политика и
  // предупреждение о выводе. Приложение хранит их в localStorage
  // через localStorageEffect("...", {dontShowAgain}).
  (function () {
    try {
      var flags = ["cookie-policy-modal", "withdrawal-warning-modal"];
      for (var i = 0; i < flags.length; i++) {
        localStorage.setItem(flags[i], JSON.stringify({ dontShowAgain: true }));
      }
    } catch (e) {}
  })();

  function pathOf(u) {
    if (!u) return "";
    try {
      return new URL(u, window.location.href).pathname;
    } catch (e) {
      return "";
    }
  }

  // Запросы, которые мокаем прямо в браузере (всё остальное уходит на прокси)
  function isMockedUrl(u) {
    var path = pathOf(u);
    if (path === "/api/users/me" || path === "/api/users/me/vip") return true;
    if (path === "/api/users/accept-tos") return true;
    if (path.indexOf("/api/users/auth/") === 0) return true;
    if (path === "/api/handshake") return true;
    if (path === "/api/items/inventory" || path === "/api/items/inventory/total") return true;
    if (path.indexOf("/api/items/inventory/sell") === 0) return true;
    if (path === "/api/items/shop/buy") return true;
    if (path === "/api/withdrawals") return true;
    if (path === "/api/game/upgrader/bet") return true;
    if (path.indexOf("/api/game/upgrader/bet/") === 0 && path.indexOf("/provably-fair") > 0) return true;
    if (path.indexOf("/api/game/upgrader/history/") === 0) return true;
    if (path.indexOf("/api/users/") > 0 && path.indexOf("/inventory/history") > 0) return true;
    if (path.indexOf("/api/payments/methods/") === 0 && path.indexOf("/create-invoice") > 0) return true;
    if (path === "/api/payments/methods") return true;
    if (path.indexOf("/api/users/notifications") === 0) return true;
    return false;
  }

  function mockNickname() {
    return lsGet(LS_KEYS.nick, "LocalTester");
  }

  function mockUser() {
    return {
      id: "mock_steam_76561198000000000",
      nickname: mockNickname(),
      avatar: "/assets/images/default-avatar-small.webp",
      steamProfileLink: "https://steamcommunity.com/profiles/76561198000000000",
      steamTradeLink:
        "https://steamcommunity.com/tradeoffer/new/?partner=1234567890&token=MOCKTRADE000000000",
      steamPrivacy: "public",
      balance: getBalance(),
      link: "",
      isNew: false,
      isTosRead: true,
    };
  }

  var mockVip = {
    tier: "vip_silver",
    depositsAmount: 125000,
    tiers: {
      vip_silver: 0,
      vip_gold: 500000,
      vip_platinum: 1000000,
      vip_diamond: 2000000,
    },
  };

  function parseBody(bodyText) {
    if (!bodyText) return {};
    if (typeof bodyText === "string") {
      try {
        return JSON.parse(bodyText);
      } catch (e) {
        return {};
      }
    }
    return {};
  }

  // ---------- демо-экономика ----------
  // Асинхронная загрузка кеша магазина при старте
  (function () {
    try {
      fetchShopAllPages(5).then(function (items) {
        if (items && items.length) {
          mergeShopCache(items);
        }
      }).catch(function () {});
    } catch (e) {}
  })();

  function lookupShopItems(ids) {
    var cache = getShopCache();
    return ids
      .map(function (id) {
        return cache.find(function (s) {
          return String(s.id) === id;
        });
      })
      .filter(Boolean);
  }

  // Догружает каталог магазина страницами параллельно (без блокировки потока).
  function fetchShopAllPages(maxPages, sortDirection) {
    var pages = typeof maxPages === "number" && maxPages > 0 ? maxPages : 30;
    var limit = 100;
    var dir = sortDirection || "DESC";
    var reqs = [];
    for (var offset = 0; offset < pages * limit; offset += limit) {
      reqs.push(
        fetch(
          "/api/items/shop?sortBy=price&sortDirection=" +
            dir +
            "&offset=" +
            offset +
            "&limit=" +
            limit
        )
          .then(function (res) { return res.json(); })
          .then(function (j) {
            return j && Array.isArray(j.items) ? j.items : [];
          })
          .catch(function () { return []; })
      );
    }
    return Promise.all(reqs).then(function (results) {
      var all = [];
      results.forEach(function (arr) {
        if (arr && arr.length) all = all.concat(arr);
      });
      return all;
    });
  }

  // ===== Своя логика покупки (демо-витрина) =====
  function round2(v) {
    return Math.round(v * 100) / 100;
  }
  // Резолв карточек предметов по id (с повторами по количеству):
  // кеш магазина → догрузка каталога → точный запрос по id.
  // Несуществующие id НЕ выдумываем: они попадают в missing и пропускаются.
  function resolveShopItems(ids) {
    var known = lookupShopItems(ids);
    if (known.length === ids.length) {
      return Promise.resolve({ found: known, missing: [] });
    }
    return fetchShopAllPages().then(function (allItems) {
      mergeShopCache(allItems);
      var got = lookupShopItems(ids);
      if (got.length === ids.length) return { found: got, missing: [] };
      return fetchShopAllPages(20, "ASC").then(function (ascItems) {
        mergeShopCache(ascItems);
        var got2 = lookupShopItems(ids);
        if (got2.length === ids.length) return { found: got2, missing: [] };
        var missing = ids.filter(function (id) {
          return !lookupShopItems([id]).length;
        });
        return fetchShopItemsById(missing).then(function (byId) {
          mergeShopCache(byId);
          return {
            found: lookupShopItems(ids),
            missing: ids.filter(function (id) {
              return !lookupShopItems([id]).length;
            }),
          };
        });
      });
    });
  }

  function buyItems(itemIds) {
    var ids = Array.isArray(itemIds) ? itemIds.map(String) : [];
    if (!ids.length) {
      return { status: 400, body: { ok: false, message: "mock: empty cart" } };
    }
    console.log("[mock-login] buy requested", ids.join(","));
    return resolveShopItems(ids)
      .then(function (res) {
        var items = res.found;
        if (res.missing && res.missing.length) {
          console.log("[mock-login] buy: skipped unknown ids", res.missing.join(","));
        }
        var total = round2(
          items.reduce(function (s, it) {
            return s + (parseFloat(it.price) || 0);
          }, 0)
        );
        // Скидка за количество: 3+ одинаковых — 5%, 10+ — 10%.
        var countById = {};
        ids.forEach(function (id) {
          countById[id] = (countById[id] || 0) + 1;
        });
        var maxQty = Object.keys(countById).reduce(function (m, k) {
          return Math.max(m, countById[k]);
        }, 0);
        var discountPct = maxQty >= 10 ? 10 : maxQty >= 3 ? 5 : 0;
        var discount = round2((total * discountPct) / 100);
        var pay = round2(total - discount);
        // Баланс для покупки — тот же, что приложение видит в /users/me,
        // чтобы дорогая корзина не отклонялась после клиентской проверки.
        var balance = getBalance();
        if (pay > balance) {
          console.log("[mock-login] buy rejected: need " + pay + ", balance " + balance);
          return {
            status: 402,
            body: {
              ok: false,
              message: "mock: insufficient balance",
              need: round2(pay - balance),
            },
          };
        }
        var inv = getInventory();
        var purchased = items.map(function (it) {
          var entry = {
            id: nextInvId(),
            item: {
              id: String(it.id),
              appId: it.appId,
              marketName: it.marketName || "",
              price: String(parseFloat(it.price) || 0),
              image: it.image || "",
              extra: it.extra || {},
            },
            price: parseFloat(it.price) || 0,
            status: "deposited",
          };
          inv.push(entry);
          return entry;
        });
        setBalance(balance - pay);
        setInventory(inv);
        pushBalanceEvent();
        console.log(
          "[mock-login] buy OK: total=" + total + " discount=" + discount + " pay=" + pay
        );
        return {
          status: 200,
          body: {
            ok: true,
            purchased: purchased,
            total: total,
            discount: discount,
            discountPercent: discountPct,
            skipped: res.missing || [],
            balance: getBalance(),
          },
        };
      })
      .catch(function (e) {
        console.log("[mock-login] buy failed", e);
        return {
          status: 400,
          body: { ok: false, message: "mock: buy failed: " + (e && e.message ? e.message : e) },
        };
      });
  }

  function fetchShopItemsById(ids) {
    return Promise.all(
      ids.map(function (id) {
        return fetch("/api/items/shop/" + encodeURIComponent(id))
          .then(function (res) {
            return res.ok ? res.json() : null;
          })
          .catch(function () {
            return null;
          });
      })
    ).then(function (items) {
      return (items || []).filter(function (x) {
        return x && x.id !== undefined && x.id !== null;
      });
    });
  }

  function sellItems(inventoryItemIds) {
    var ids = Array.isArray(inventoryItemIds) ? inventoryItemIds.map(String) : [];
    var all = getInventory();
    var sold = all.filter(function (it) {
      return ids.indexOf(String(it.id)) !== -1;
    });
    var totalAmount = round2(
      sold.reduce(function (s, it) {
        return s + (parseFloat(it.price) || 0);
      }, 0)
    );
    var inv = all.filter(function (it) {
      return ids.indexOf(String(it.id)) === -1;
    });
    setInventory(inv);
    // Приложение прибавляет e.totalAmount к отображаемому балансу,
    // поэтому возвращаем сумму проданного.
    setBalance(getBalance() + totalAmount);
    pushBalanceEvent();
    return { status: 200, body: { totalAmount: totalAmount, soldCount: sold.length } };
  }

  function withdrawItem(inventoryItemId) {
    var id = String(inventoryItemId);
    var inv = getInventory().filter(function (it) {
      return String(it.id) !== id;
    });
    setInventory(inv);
    return { status: 200, body: {} };
  }

  function performUpgrade(payload) {
    var ids = Array.isArray(payload.betInventoryItemIds)
      ? payload.betInventoryItemIds.map(String)
      : [];
    var inv = getInventory();
    var betItems = inv.filter(function (it) {
      return ids.indexOf(String(it.id)) !== -1;
    });
    var addedBalance = parseFloat(payload.addedBalance) || 0;
    var targetPrice = parseFloat(payload.targetItemPrice) || 0;
    var betValue =
      betItems.reduce(function (sum, it) {
        return sum + (it.price || 0);
      }, 0) + addedBalance;

    function finish(targetItem) {
      // шанс как в UI: (сумма ставки / цена цели) * 1.03
      var chance =
        targetPrice > 0
          ? Math.min(Math.max((betValue / targetPrice) * 1.03 * 100, 0.01), 100)
          : 100;
      var win = targetItem ? Math.random() * 100 < chance : false;

      var balance = getBalance();
      setBalance(balance - addedBalance);
      pushBalanceEvent();

      // убираем поставленные предметы
      inv = inv.filter(function (it) {
        return ids.indexOf(String(it.id)) === -1;
      });

      var wonItem = null;
      if (win && targetItem) {
        var newItem = {
          id: nextInvId(),
          item: targetItem,
          price: targetPrice,
          status: "deposited",
        };
        inv.push(newItem);
        wonItem = targetItem;
      }
      setInventory(inv);

      var bet = {
        id: Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 1000),
        status: win ? "won" : "lost",
        betItems: betItems.map(function (it) {
          return it.item;
        }),
        targetItem: targetItem || null,
        wonItem: wonItem,
        addedBalance: String(addedBalance),
        probability: chance,
        betAmount: betValue,
        createdAt: new Date().toISOString(),
        nonce: String(Math.floor(Math.random() * 1e9)),
        roll: Math.floor(Math.random() * 10000),
        serverSeed: "mock_seed_" + Math.random().toString(36).slice(2),
        serverSeedHash: "mock_hash_" + Math.random().toString(36).slice(2),
        clientSeed: "mock_client_" + Math.random().toString(36).slice(2),
      };

      return { status: 200, body: { bet: bet, balance: getBalance().toFixed(2) } };
    }

    var cached = getShopCache().find(function (s) {
      return String(s.id) === String(payload.targetItemId);
    });
    if (cached) return finish(cached);
    // Цель не в кеше — догружаем по id (без выдуманных предметов "Item #").
    return fetchShopItemsById([String(payload.targetItemId)]).then(function (found) {
      return finish(found[0] || null);
    });
  }

  function createDemoInvoice(body) {
    var amount = parseFloat(body.amount) || 0;
    if (amount <= 0) return { status: 200, body: {} };
    // Максимум пополнения — 100 000.
    amount = Math.min(100000, amount);
    var sep = window.location.search ? "&" : "?";
    var redirect = window.location.pathname + sep + "mock_deposit=" + encodeURIComponent(amount);
    // баланс начислится после перезагрузки в handleMockDeposit()
    return { status: 200, body: { redirectUrl: redirect } };
  }

  function responseFor(method, url, bodyText) {
    var path = url.pathname;
    var body = null;

    if (path === "/api/users/me") {
      lsDel(LS_KEYS.loggedOut);
      // Приложение само проверяет balance >= суммы корзины перед покупкой.
      // Отдаём гарантированно большой баланс, чтобы покупка всегда доходила до API.
      body = Object.assign({}, mockUser(), {
        token: MOCK.token,
        balance: getBalance(),
      });
    } else if (path === "/api/users/me/vip") {
      body = mockVip;
    } else if (path === "/api/users/accept-tos") {
      body = {};
    } else if (path === "/api/users/auth/steam/redirect-url") {
      var sep = window.location.search ? "&" : "?";
      var target =
        window.location.pathname +
        sep +
        "token=" +
        encodeURIComponent(MOCK.token) +
        "&refreshToken=" +
        encodeURIComponent(MOCK.refreshToken);
      body = { redirect: target };
    } else if (path === "/api/users/auth/refresh") {
      body = { token: MOCK.token, refreshToken: MOCK.refreshToken };
    } else if (path === "/api/users/auth/exchange") {
      body = { token: MOCK.token, refreshToken: MOCK.refreshToken };
    } else if (path === "/api/users/auth/code") {
      body = { code: "mock-auth-code" };
    } else if (path === "/api/users/auth/logout") {
      lsSet(LS_KEYS.loggedOut, "1");
      body = {};
    } else if (path === "/api/handshake") {
      body = {};
    } else if (path === "/api/items/inventory") {
      body = { items: getInventory(), hasMore: false, total: getInventory().length };
    } else if (path === "/api/items/inventory/total") {
      body = { total: getInventory().reduce(function (s, it) { return s + (it.price || 0); }, 0) };
    } else if (path === "/api/items/inventory/sell") {
      var sellPayload = parseBody(bodyText);
      return sellItems(sellPayload.inventoryItemIds);
    } else if (path === "/api/items/shop/buy") {
      var buyPayload = parseBody(bodyText);
      return buyItems(buyPayload.itemIds);
    } else if (path === "/api/withdrawals") {
      var wPayload = parseBody(bodyText);
      return withdrawItem(wPayload.inventoryItemId);
    } else if (path === "/api/game/upgrader/bet") {
      return performUpgrade(parseBody(bodyText));
    } else if (path.indexOf("/api/game/upgrader/bet/") === 0 && path.indexOf("/provably-fair") > 0) {
      body = { ok: true, nonce: "1", roll: 1 };
    } else if (path.indexOf("/api/game/upgrader/history/") === 0) {
      body = { items: [], total: 0, hasMore: false };
    } else if (path.indexOf("/inventory/history") > 0) {
      body = { items: [], total: 0, hasMore: false };
    } else if (path === "/api/payments/methods") {
      body = [
        {
          id: "demo-cards",
          name: "Cards",
          children: [
            {
              id: "demo-usd",
              name: "USD",
              methods: [
                {
                  id: "demo-card-method",
                  name: "Demo Card",
                  image: "",
                  minAmount: 1,
                  maxAmount: 100000,
                  currency: "USD",
                  fields: [],
                },
              ],
            },
          ],
        },
      ];
    } else if (path.indexOf("/api/payments/methods/") === 0 && path.indexOf("/create-invoice") > 0) {
      return createDemoInvoice(parseBody(bodyText));
    } else if (path === "/api/users/notifications/unread/count") {
      body = { count: 0 };
    } else if (path.indexOf("/api/users/notifications") === 0) {
      body = { items: [], hasMore: false };
    } else {
      body = {};
    }
    return { status: 200, body: body };
  }

  var JSON_RESPONSE_HEADERS =
    "Content-Type: application/json\r\naccess-control-allow-origin: *\r\ncache-control: no-cache\r\n";

  function MockedXHR() {
    this._native = null;
    this._mocked = false;
    this._method = "";
    this._url = null;
    this._listeners = {};
    this._aborted = false;
    this._mockedStatus = 0;
    this._mockedStatusText = "";
    this._mockedResponseText = "";
    this._mockedResponse = undefined;
    this._mockedResponseURL = "";
    this._mockedHeaders = "";
    this._mockedReadyState = 0;

    this.responseType = "";
    this.timeout = 0;
    this.withCredentials = false;
    this.upload = {
      addEventListener: function () {},
      removeEventListener: function () {},
    };
    this.onreadystatechange = null;
    this.onload = null;
    this.onerror = null;
    this.ontimeout = null;
    this.onabort = null;
    this.onprogress = null;
  }

  function fire(xhr, type, evt) {
    var e = evt || { type: type, loaded: 0, total: 0, lengthComputable: true };
    var list = xhr._listeners[type];
    if (list) {
      for (var i = 0; i < list.length; i++) {
        try {
          list[i](e);
        } catch (err) {}
      }
    }
    switch (type) {
      case "readystatechange":
        if (typeof xhr.onreadystatechange === "function")
          try { xhr.onreadystatechange(e); } catch (err) {}
        break;
      case "load":
        if (typeof xhr.onload === "function")
          try { xhr.onload(e); } catch (err) {}
        break;
      case "error":
        if (typeof xhr.onerror === "function")
          try { xhr.onerror(e); } catch (err) {}
        break;
      case "timeout":
        if (typeof xhr.ontimeout === "function")
          try { xhr.ontimeout(e); } catch (err) {}
        break;
      case "abort":
        if (typeof xhr.onabort === "function")
          try { xhr.onabort(e); } catch (err) {}
        break;
    }
  }

  MockedXHR.prototype._initMock = function (method, url) {
    this._mocked = true;
    this._method = method;
    this._url = url;
  };

  MockedXHR.prototype.open = function (method, url, async, user, pass) {
    this._url = url;
    if (isMockedUrl(url)) {
      this._initMock(method, url);
      this._mockedReadyState = 1;
      fire(this, "readystatechange");
      return;
    }
    this._native = new NativeXHR();
    var args = Array.prototype.slice.call(arguments);
    if (this._native.open) this._native.open.apply(this._native, args);
  };

  MockedXHR.prototype.setRequestHeader = function (name, value) {
    if (this._mocked) return;
    if (this._native && this._native.setRequestHeader)
      this._native.setRequestHeader(name, value);
  };

  MockedXHR.prototype.send = function (body) {
    if (this._mocked) {
      var self = this;
      setTimeout(function () {
        if (self._aborted) return;
        var url;
        try {
          url = new URL(self._url, window.location.href);
        } catch (e) {
          url = null;
        }
        var resp = url ? responseFor(self._method, url, body) : { status: 200, body: null };
        if (resp && typeof resp.then === "function") {
          resp.then(function (r) {
            if (self._aborted) return;
            self._emitMockResponse(r);
          }).catch(function () {
            if (self._aborted) return;
            self._emitMockResponse({ status: 500, body: {} });
          });
          return;
        }
        self._emitMockResponse(resp);
      }, 5);
      return;
    }
    // Не-мокнутый запрос уходит на прокси; дополнительно кэшируем ответ магазина.
    if (this._native && this._native.send) {
      var native = this._native;
      var urlStr = this._url;
      try {
        native.addEventListener("load", function () {
          if (!urlStr) return;
          var p = pathOf(urlStr);
          if (p.indexOf("/api/items/shop") === 0 && native.status === 200 && native.responseText) {
            try {
              var j = JSON.parse(native.responseText);
              if (j && Array.isArray(j.items)) {
                mergeShopCache(j.items);
              }
            } catch (e) {}
          }
        });
      } catch (e) {}
      this._native.send(body);
    }
  };

  MockedXHR.prototype._emitMockResponse = function (resp) {
    var json = JSON.stringify(resp.body);
    this._mockedStatus = resp.status;
    this._mockedStatusText = resp.status === 200 ? "OK" : "Mock Error";
    this._mockedResponseText = json;
    this._mockedResponse = json;
    this._mockedResponseURL = this._url;
    this._mockedHeaders = JSON_RESPONSE_HEADERS;
    this._mockedReadyState = 4;
    fire(this, "readystatechange");
    fire(this, "load");
  };

  MockedXHR.prototype.abort = function () {
    if (this._mocked) {
      this._aborted = true;
      this._mockedReadyState = 0;
      fire(this, "abort");
      return;
    }
    if (this._native && this._native.abort) this._native.abort();
  };

  MockedXHR.prototype.getResponseHeader = function (name) {
    if (this._mocked) {
      name = (name || "").toLowerCase();
      var lines = this._mockedHeaders.split("\r\n");
      for (var i = 0; i < lines.length; i++) {
        var idx = lines[i].indexOf(":");
        if (idx > 0) {
          var k = lines[i].slice(0, idx).trim().toLowerCase();
          if (k === name) return lines[i].slice(idx + 1).trim();
        }
      }
      return null;
    }
    if (this._native && this._native.getResponseHeader)
      return this._native.getResponseHeader(name);
    return null;
  };

  MockedXHR.prototype.getAllResponseHeaders = function () {
    if (this._mocked) return this._mockedHeaders;
    if (this._native && this._native.getAllResponseHeaders)
      return this._native.getAllResponseHeaders();
    return "";
  };

  MockedXHR.prototype.overrideMimeType = function (mime) {
    if (this._native && this._native.overrideMimeType)
      this._native.overrideMimeType(mime);
  };

  MockedXHR.prototype.addEventListener = function (type, fn) {
    if (this._mocked) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
      return;
    }
    if (this._native && this._native.addEventListener)
      this._native.addEventListener(type, fn);
  };

  MockedXHR.prototype.removeEventListener = function (type, fn) {
    if (this._mocked) {
      var l = this._listeners[type];
      if (l) {
        var i = l.indexOf(fn);
        if (i >= 0) l.splice(i, 1);
      }
      return;
    }
    if (this._native && this._native.removeEventListener)
      this._native.removeEventListener(type, fn);
  };

  // Стандартные константы
  MockedXHR.UNSENT = 0;
  MockedXHR.OPENED = 1;
  MockedXHR.HEADERS_RECEIVED = 2;
  MockedXHR.LOADING = 3;
  MockedXHR.DONE = 4;

  Object.defineProperties(MockedXHR.prototype, {
    readyState: {
      get: function () {
        return this._mocked ? this._mockedReadyState : this._native ? this._native.readyState : 0;
      },
    },
    status: {
      get: function () {
        return this._mocked ? this._mockedStatus : this._native ? this._native.status : 0;
      },
    },
    statusText: {
      get: function () {
        return this._mocked ? this._mockedStatusText : this._native ? this._native.statusText : "";
      },
    },
    responseText: {
      get: function () {
        return this._mocked ? this._mockedResponseText : this._native ? this._native.responseText : "";
      },
    },
    response: {
      get: function () {
        return this._mocked ? this._mockedResponse : this._native ? this._native.response : undefined;
      },
    },
    responseURL: {
      get: function () {
        return this._mocked ? this._mockedResponseURL : this._native ? this._native.responseURL : "";
      },
    },
    responseXML: {
      get: function () {
        return this._native ? this._native.responseXML : null;
      },
    },
    onreadystatechange: {
      get: function () {
        return this._mocked ? this.__mockOnreadystatechange : this._native ? this._native.onreadystatechange : null;
      },
      set: function (fn) {
        if (this._mocked) this.__mockOnreadystatechange = fn;
        else if (this._native) this._native.onreadystatechange = fn;
      },
    },
    onload: {
      get: function () {
        return this._mocked ? this.__mockOnload : this._native ? this._native.onload : null;
      },
      set: function (fn) {
        if (this._mocked) this.__mockOnload = fn;
        else if (this._native) this._native.onload = fn;
      },
    },
    onerror: {
      get: function () {
        return this._mocked ? this.__mockOnerror : this._native ? this._native.onerror : null;
      },
      set: function (fn) {
        if (this._mocked) this.__mockOnerror = fn;
        else if (this._native) this._native.onerror = fn;
      },
    },
    ontimeout: {
      get: function () {
        return this._mocked ? this.__mockOntimeout : this._native ? this._native.ontimeout : null;
      },
      set: function (fn) {
        if (this._mocked) this.__mockOntimeout = fn;
        else if (this._native) this._native.ontimeout = fn;
      },
    },
    onabort: {
      get: function () {
        return this._mocked ? this.__mockOnabort : this._native ? this._native.onabort : null;
      },
      set: function (fn) {
        if (this._mocked) this.__mockOnabort = fn;
        else if (this._native) this._native.onabort = fn;
      },
    },
  });

  window.XMLHttpRequest = MockedXHR;

  // Дублирующая защита: fetch для замоканных /api/*
  if (typeof window.fetch === "function") {
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : input && input.url;
      if (isMockedUrl(url)) {
        var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
        try {
          var u = new URL(url, window.location.href);
          var bodyArg = init && init.body;
          var resp = responseFor(method, u, typeof bodyArg === "string" ? bodyArg : "");
          if (resp && typeof resp.then === "function") {
            return resp.then(function (r) {
              return new Response(JSON.stringify(r.body), {
                status: r.status,
                statusText: r.status === 200 ? "OK" : "Mock Error",
                headers: { "Content-Type": "application/json" },
              });
            }).catch(function () {
              return new Response("{}", { status: 500 });
            });
          }
          return Promise.resolve(
            new Response(JSON.stringify(resp.body), {
              status: resp.status,
              statusText: resp.status === 200 ? "OK" : "Mock Error",
              headers: { "Content-Type": "application/json" },
            })
          );
        } catch (e) {
          return Promise.resolve(new Response("{}", { status: 200 }));
        }
      }
      var result = NativeFetch.apply(this, arguments);
      try {
        var cacheUrl = new URL(url, window.location.href);
        if (pathOf(cacheUrl.href) === "/api/items/shop" && result && typeof result.then === "function") {
          result.then(function (resp) {
            if (resp && resp.status === 200 && resp.ok && resp.clone) {
              resp.clone().json().then(function (j) {
                if (j && Array.isArray(j.items)) {
                  mergeShopCache(j.items);
                }
              }).catch(function () {});
            }
          }).catch(function () {});
        }
      } catch (e) {}
      return result;
    };
  }

  console.log("[mock-login] upgrader.vip mock API installed (token=" + MOCK.token + ", balance=" + getBalance() + ")");
})();

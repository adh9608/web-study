"use strict";
const $ = (s) => document.querySelector(s);
const storageKey = "flow-operations-v1";
const schemas = {
  products: {
    title: "제품관리",
    description: "생산부터 출고까지, 제품의 모든 정보를 관리하세요.",
    singular: "제품",
    icon: "▧",
    fields: [
      ["serial", "시리얼번호", "text", true],
      ["code", "모델명", "text", true],
      ["production", "생산일", "date", true],
      ["rail", "레일(사양)", "text"],
      ["inspection", "검사", "select", true, ["검사대기", "합격", "불합격"]],
      ["status", "상태", "select", true, ["재고", "출고"]],
      ["notes", "비고", "textarea"],
    ],
  },
  customers: {
    title: "고객관리",
    description: "고객 정보와 연락처를 한곳에서 확인하세요.",
    singular: "고객",
    icon: "♧",
    fields: [
      ["code", "고객코드", "text", true],
      ["name", "고객명", "text", true],
      ["address", "주소", "text"],
      ["phone", "연락처", "tel"],
      ["notes", "비고", "textarea"],
    ],
  },
  shipments: {
    title: "출고관리",
    description: "고객과 제품을 연결하고 출고 내역을 관리하세요.",
    singular: "출고",
    icon: "↗",
    fields: [
      ["date", "출고일", "date", true],
      ["customerId", "고객명", "customer", true],
      ["name", "제품명", "text", true],
      ["productId", "시리얼번호", "product", true],
      ["notes", "비고", "textarea"],
    ],
  },
  service: {
    title: "A/S",
    description: "접수부터 완료까지, 서비스 진행 상황을 확인하세요.",
    singular: "A/S",
    icon: "⚒",
    fields: [
      ["productId", "시리얼번호", "serviceProduct", true],
      ["model", "모델명", "text", true],
      ["received", "접수일", "date", true],
      ["symptom", "증상", "textarea", true],
      ["action", "조치", "textarea"],
      ["owner", "담당", "text"],
      ["completed", "완료일", "date"],
    ],
  },
};
let data = { products: [], customers: [], shipments: [], service: [] },
  page = "products",
  filter = "전체",
  editing = null,
  toastTimer;
const cloud = window.FlowCloud;
// Resolve both current and previous login markup during browser cache updates.
const loginInput = $('#login-form input[autocomplete="username"]');
if (loginInput) {
  loginInput.type = "text";
  loginInput.name = "username";
  loginInput.minLength = 3;
  loginInput.maxLength = 32;
  loginInput.pattern = "[A-Za-z0-9][A-Za-z0-9_\\-]{2,31}";
  loginInput.placeholder = "예: hong01";
  const label = document.querySelector('label[for="' + loginInput.id + '"]');
  if (label?.firstChild?.nodeType === Node.TEXT_NODE)
    label.firstChild.textContent = "아이디";
}

let cloudMode = false,
  role = "employee",
  busy = false,
  authGeneration = 0;
let storageFailed = false;
function loadLocal() {
  storageFailed = false;
  data = { products: [], customers: [], shipments: [], service: [] };
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const saved = JSON.parse(raw);
      if (!Object.keys(data).every((k) => Array.isArray(saved[k])))
        throw Error("저장 데이터 형식 오류");
      data = saved;
    }
  } catch {
    storageFailed = true;
  }
}
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const product = (id) => data.products.find((p) => p.id === id);
const customer = (id) => data.customers.find((c) => c.id === id);
const shipped = (id) => data.shipments.some((s) => s.productId === id);
const status = (p) => (shipped(p.id) ? "출고" : p.status);
const value = (row, key) =>
  key === "productId"
    ? (product(row[key])?.serial ?? "삭제된 제품")
    : key === "customerId"
      ? (customer(row[key])?.name ?? "삭제된 고객")
      : page === "products" && key === "status"
        ? status(row)
        : row[key];
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 3500);
}
function applySnapshot(snapshot) {
  if (
    !snapshot?.data ||
    !Object.keys(data).every((k) => Array.isArray(snapshot.data[k]))
  )
    throw Error("서버 데이터 형식을 확인해 주세요.");
  data = snapshot.data;
  role = snapshot.role;
}
async function persist(next, record, old) {
  if (cloudMode) {
    applySnapshot(await cloud.save(page, record, old?.version));
  } else {
    if (storageFailed)
      throw Error(
        "기존 저장 데이터를 읽지 못해 덮어쓰기를 중단했습니다. 브라우저 저장소를 확인해 주세요.",
      );
    localStorage.setItem(storageKey, JSON.stringify(next));
    data = next;
  }
}
function setBusy(value) {
  busy = value;
  $("#record-form")
    .querySelectorAll("button,input,select,textarea")
    .forEach((e) => (e.disabled = value));
  if (!value && page === "products" && shipped(editing) && $("#field-status"))
    $("#field-status").disabled = true;
}
function badge(v) {
  return `<span class="badge ${["재고", "합격", "완료"].includes(v) ? "green" : ["검사대기", "진행중"].includes(v) ? "amber" : ""}">${esc(v)}</span>`;
}
function stats() {
  const inventory = data.products.filter((p) => status(p) === "재고").length;
  let items;
  if (page === "products")
    items = [
      ["전체 제품", data.products.length, "등록된 모든 제품", "▧"],
      ["재고 제품", inventory, "출고 대기 중인 제품", "▤"],
      ["출고 제품", data.products.length - inventory, "출고 상태의 제품", "↗"],
      [
        "검사 대기",
        data.products.filter((p) => p.inspection === "검사대기").length,
        "검사가 필요한 제품",
        "◷",
      ],
    ];
  if (page === "customers")
    items = [
      ["전체 고객", data.customers.length, "등록된 모든 고객", "♧"],
      [
        "출고 고객",
        new Set(data.shipments.map((s) => s.customerId)).size,
        "출고 이력이 있는 고객",
        "↗",
      ],
      ["출고 내역", data.shipments.length, "누적 출고 기록", "▤"],
      [
        "연락처 등록",
        data.customers.filter((c) => c.phone).length,
        "연락처가 있는 고객",
        "☏",
      ],
    ];
  if (page === "shipments")
    items = [
      ["전체 출고", data.shipments.length, "누적 출고 기록", "↗"],
      [
        "이번 달 출고",
        data.shipments.filter((s) => s.date.startsWith(today().slice(0, 7)))
          .length,
        "이번 달 등록된 출고",
        "▤",
      ],
      [
        "출고 고객",
        new Set(data.shipments.map((s) => s.customerId)).size,
        "출고 이력이 있는 고객",
        "♧",
      ],
      ["재고 제품", inventory, "출고 가능한 재고", "▧"],
    ];
  if (page === "service")
    items = [
      ["전체 접수", data.service.length, "등록된 서비스 요청", "⚒"],
      [
        "진행 중",
        data.service.filter((s) => !s.completed).length,
        "조치 진행 중인 요청",
        "◷",
      ],
      [
        "완료",
        data.service.filter((s) => s.completed).length,
        "완료된 서비스 요청",
        "✓",
      ],
      [
        "이번 달 접수",
        data.service.filter((s) => s.received.startsWith(today().slice(0, 7)))
          .length,
        "이번 달 접수된 요청",
        "▤",
      ],
    ];
  $("#stats").innerHTML = items
    .map(
      ([label, n, note, icon]) =>
        `<article class="stat"><div class="stat-label">${label}</div><span class="stat-icon">${icon}</span><div class="stat-value">${n.toLocaleString()}<span>${page === "customers" ? "곳" : "건"}</span></div><div class="stat-note">${note}</div></article>`,
    )
    .join("");
}
function rows() {
  const q = $("#search").value.trim().toLocaleLowerCase();
  return data[page].filter((r) => {
    if (
      page === "products" &&
      filter !== "전체" &&
      (filter === "검사대기" ? r.inspection !== filter : status(r) !== filter)
    )
      return false;
    if (
      page === "service" &&
      filter !== "전체" &&
      (filter === "완료" ? !r.completed : !!r.completed)
    )
      return false;
    return (
      !q ||
      schemas[page].fields.some(([key]) =>
        String(value(r, key) ?? "")
          .toLocaleLowerCase()
          .includes(q),
      )
    );
  });
}
function render() {
  const s = schemas[page];
  $("#navigation").innerHTML = Object.entries(schemas)
    .map(
      ([key, v]) =>
        `<button data-page="${key}" class="${key === page ? "active" : ""}" ${key === page ? 'aria-current="page"' : ""}><span class="nav-icon">${v.icon}</span>${v.title}<span class="nav-count">${data[key].length}</span></button>`,
    )
    .join("");
  $("#breadcrumb").textContent = s.title;
  $("#page-title").textContent = s.title;
  $("#page-description").textContent = s.description;
  $("#add-button").textContent = "+ " + s.singular + " 등록";
  $("#list-title").textContent = s.singular + " 목록";
  $("#record-count").textContent = data[page].length;
  $("#search").placeholder = s.title + " 정보 검색";
  const filters =
    page === "products"
      ? ["전체", "재고", "출고", "검사대기"]
      : page === "service"
        ? ["전체", "진행중", "완료"]
        : ["전체"];
  $("#filter-tabs").innerHTML = filters
    .map(
      (f) =>
        `<button data-filter="${f}" class="${filter === f ? "active" : ""}" aria-pressed="${filter === f}">${f === "검사대기" ? "검사 대기" : f === "진행중" ? "진행 중" : f}</button>`,
    )
    .join("");
  stats();
  renderTable();
}
function renderTable() {
  const s = schemas[page];
  $("#table-head").innerHTML =
    "<tr>" +
    s.fields.map(([, label]) => `<th scope="col">${label}</th>`).join("") +
    (page === "service" ? '<th scope="col">상태</th>' : "") +
    '<th scope="col">관리</th></tr>';
  const visible = rows();
  $("#table-body").innerHTML = visible
    .map(
      (r) =>
        "<tr>" +
        s.fields
          .map(([key]) => {
            const v = value(r, key);
            return `<td>${["status", "inspection"].includes(key) ? badge(v) : esc(v || "—")}</td>`;
          })
          .join("") +
        (page === "service"
          ? `<td>${badge(r.completed ? "완료" : "진행중")}</td>`
          : "") +
        `<td><button class="edit" data-edit="${esc(r.id)}" aria-label="${esc(value(r, s.fields[0][0]))} 수정">수정 ↗</button></td></tr>`,
    )
    .join("");
  $("#empty-state").hidden = !!visible.length;
  $("#empty-state").innerHTML = data[page].length
    ? "<strong>검색 결과가 없습니다</strong>검색어나 필터를 변경해 주세요."
    : `<strong>아직 등록된 ${s.singular} 정보가 없습니다</strong>첫 번째 ${s.singular} 정보를 등록해 관리를 시작하세요.<br><button class="primary" data-add>+ ${s.singular} 등록</button>`;
  $("#result-count").textContent =
    `전체 ${data[page].length}건 중 ${visible.length}건 표시`;
}
function openEditor(id = null) {
  editing = id;
  const row = data[page].find((r) => r.id === id) || {};
  const s = schemas[page];
  $("#dialog-title").textContent = s.singular + (id ? " 수정" : " 등록");
  $("#form-error").textContent = "";
  $("#delete-button").hidden = !id || (cloudMode && role !== "admin");
  $("#form-fields").innerHTML = s.fields
    .map(([key, label, type, required, choices]) => {
      let control;
      if (["customer", "product", "serviceProduct", "select"].includes(type)) {
        let opts =
          type === "customer"
            ? data.customers.map((c) => [c.id, `${c.name} · ${c.code}`])
            : type === "product"
              ? data.products
                  .filter((p) => status(p) === "재고" || p.id === row.productId)
                  .map((p) => [p.id, `${p.serial} · ${p.code}`])
              : type === "serviceProduct"
                ? data.products.map((p) => [p.id, `${p.serial} · ${p.code}`])
                : choices.map((c) => [c, c]);
        control = `<select id="field-${key}" name="${key}" ${required ? "required" : ""}><option value="">선택해 주세요</option>${opts.map(([v, l]) => `<option value="${esc(v)}" ${row[key] === v || (!id && type === "select" && v === choices[0]) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
      } else if (type === "textarea")
        control = `<textarea id="field-${key}" name="${key}" ${required ? "required" : ""} maxlength="2000">${esc(row[key] || "")}</textarea>`;
      else
        control = `<input id="field-${key}" name="${key}" type="${type}" value="${esc(row[key] || (!id && type === "date" && key !== "completed" ? today() : ""))}" ${required ? "required" : ""} maxlength="200">`;
      let help =
        type === "customer"
          ? "고객관리에서 등록한 고객을 선택하세요."
          : type === "product"
            ? "재고 제품을 선택하면 저장 시 출고 상태로 변경됩니다."
            : type === "serviceProduct"
              ? "제품관리에서 등록한 시리얼번호를 선택하세요."
              : page === "products" && key === "status" && shipped(id)
                ? "출고 이력이 있는 제품은 출고 상태가 유지됩니다."
                : "";
      return `<label class="field ${type === "textarea" ? "wide" : ""}" for="field-${key}">${label}${required ? "<b>*</b>" : ""}${control}${help ? `<small>${help}</small>` : ""}</label>`;
    })
    .join("");
  if (page === "products" && shipped(id)) {
    $("#field-status").value = "출고";
    $("#field-status").disabled = true;
  }
  $("#editor").showModal();
}
$("#record-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (busy) return;
  try {
    const old = data[page].find((r) => r.id === editing);
    const record = { id: editing || crypto.randomUUID() };
    const form = new FormData(e.target);
    for (const [key, , type, required] of schemas[page].fields) {
      record[key] = String(
        form.get(key) ?? (key === "status" && old ? old.status : ""),
      ).trim();
      if (required && !record[key]) throw Error("필수 항목을 입력해 주세요.");
      if (
        type === "select" &&
        !schemas[page].fields.find((f) => f[0] === key)[4].includes(record[key])
      )
        throw Error("올바른 값을 선택해 주세요.");
    }
    if (
      page === "products" &&
      data.products.some(
        (r) =>
          r.id !== record.id &&
          r.serial.toLowerCase() === record.serial.toLowerCase(),
      )
    )
      throw Error("이미 등록된 시리얼번호입니다.");
    if (
      page === "customers" &&
      data.customers.some(
        (r) =>
          r.id !== record.id &&
          r.code.toLowerCase() === record.code.toLowerCase(),
      )
    )
      throw Error("이미 등록된 고객코드입니다.");
    if (page === "shipments") {
      if (!customer(record.customerId) || !product(record.productId))
        throw Error("고객과 제품을 먼저 등록해 주세요.");
      if (
        data.shipments.some(
          (s) => s.id !== record.id && s.productId === record.productId,
        ) ||
        ((!old || old.productId !== record.productId) &&
          status(product(record.productId)) !== "재고")
      )
        throw Error("이미 출고된 제품입니다.");
      if (record.date < product(record.productId).production)
        throw Error("출고일은 제품 생산일 이후여야 합니다.");
    }
    if (page === "service") {
      if (!product(record.productId)) throw Error("제품을 먼저 등록해 주세요.");
      if (record.completed && record.completed < record.received)
        throw Error("완료일은 접수일 이후여야 합니다.");
    }
    const next = structuredClone(data);
    const index = next[page].findIndex((r) => r.id === record.id);
    if (index < 0) next[page].unshift(record);
    else next[page][index] = record;
    setBusy(true);
    await persist(next, record, old);
    $("#editor").close();
    render();
    toast("정보가 저장되었습니다.");
  } catch (err) {
    $("#form-error").textContent =
      err.message || "저장하지 못했습니다. 연결 및 저장 공간을 확인해 주세요.";
  } finally {
    setBusy(false);
  }
});
$("#delete-button").addEventListener("click", async () => {
  if (busy) return;
  try {
    if (
      page === "products" &&
      (data.shipments.some((r) => r.productId === editing) ||
        data.service.some((r) => r.productId === editing))
    )
      throw Error("출고 또는 A/S 이력이 있는 제품은 삭제할 수 없습니다.");
    if (
      page === "customers" &&
      data.shipments.some((r) => r.customerId === editing)
    )
      throw Error("출고 이력이 있는 고객은 삭제할 수 없습니다.");
    if (
      !confirm(
        "이 정보를 삭제할까요? 삭제한 정보는 복구할 수 없습니다." +
          (page === "shipments" ? " 제품 상태는 기존 상태로 돌아갑니다." : ""),
      )
    )
      return;
    const next = structuredClone(data);
    next[page] = next[page].filter((r) => r.id !== editing);
    setBusy(true);
    if (cloudMode) {
      const old = data[page].find((r) => r.id === editing);
      applySnapshot(await cloud.remove(page, editing, old.version));
    } else {
      await persist(next);
    }
    $("#editor").close();
    render();
    toast("정보가 삭제되었습니다.");
  } catch (err) {
    $("#form-error").textContent = err.message;
  } finally {
    setBusy(false);
  }
});
$("#navigation").addEventListener("click", (e) => {
  const b = e.target.closest("[data-page]");
  if (!b) return;
  page = b.dataset.page;
  filter = "전체";
  $("#search").value = "";
  render();
});
$("#filter-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-filter]");
  if (b) {
    filter = b.dataset.filter;
    render();
  }
});
$("#table-body").addEventListener("click", (e) => {
  const b = e.target.closest("[data-edit]");
  if (b) openEditor(b.dataset.edit);
});
$("#empty-state").addEventListener("click", (e) => {
  if (e.target.closest("[data-add]")) openEditor();
});
$("#add-button").addEventListener("click", () => openEditor());
$("#search").addEventListener("input", renderTable);
for (const id of ["close-dialog", "cancel-dialog"])
  $("#" + id).addEventListener("click", () => $("#editor").close());
$("#editor").addEventListener("click", (e) => {
  if (e.target === $("#editor") && !busy) {
    const r = e.target.getBoundingClientRect();
    if (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    )
      e.target.close();
  }
});
$("#export-button").addEventListener("click", () => {
  const fields = schemas[page].fields;
  const cell = (v) =>
    '"' +
    String(v ?? "")
      .replace(/^[=+@\-\t\r]/, "'$&")
      .replace(/"/g, '""') +
    '"';
  const csv =
    "\uFEFF" +
    [
      fields.map((f) => cell(f[1])).join(","),
      ...rows().map((r) => fields.map(([k]) => cell(value(r, k))).join(",")),
    ].join("\r\n");
  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `FLOW_${schemas[page].title}_${today()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("현재 목록을 CSV로 내보냈습니다.");
});
window.addEventListener("storage", (e) => {
  if (!cloudMode && e.key === storageKey) {
    location.reload();
  }
});
$("#editor").addEventListener("cancel", (e) => {
  if (busy) e.preventDefault();
});
$("#today").textContent = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "long",
  day: "numeric",
}).format(new Date());

function showApp() {
  $("#login-screen").hidden = true;
  $("#app-content").hidden = false;
  $("#logout-button").textContent = cloudMode ? "로그아웃" : "로그인 화면";
  $("#account-label").textContent = cloudMode
    ? `${cloud.username()} · ${role === "admin" ? "관리자" : "직원"}`
    : "브라우저 모드";
  $("#storage-mode").textContent = cloudMode
    ? "클라우드 연결"
    : "브라우저 저장 모드";
  $("#storage-description").textContent = cloudMode
    ? "직원 전용 · 공유 데이터"
    : "이 브라우저에만 저장됩니다.";
  $("#storage-note").textContent = cloudMode
    ? "ⓘ 데이터는 공유 DB에 저장됩니다. 최신 변경은 새로고침으로 확인하세요."
    : "ⓘ 브라우저 모드입니다. 데이터는 현재 기기에만 저장되고 클라우드로 자동 전송되지 않습니다. CSV로 백업해 주세요.";
  render();
}
function showLogin() {
  authGeneration++;
  if ($("#editor").open) $("#editor").close();
  data = { products: [], customers: [], shipments: [], service: [] };
  $("#app-content").hidden = true;
  $("#login-screen").hidden = false;
  $("#login-password").value = "";
  page = "products";
  filter = "전체";
  $("#search").value = "";
  $("#sync-error").hidden = true;
}
async function loadCloud() {
  const generation = authGeneration;
  const snapshot = await cloud.snapshot();
  if (generation !== authGeneration || !cloud.hasSession()) return;
  applySnapshot(snapshot);
  cloudMode = true;
  showApp();
}
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = e.target.querySelector("button");
  button.disabled = true;
  button.textContent = "로그인 중…";
  $("#login-error").textContent = "";
  try {
    if (!loginInput)
      throw Error("로그인 화면을 새로고침한 뒤 다시 시도해 주세요.");
    await cloud.login(loginInput.value.trim(), $("#login-password").value);
    $("#login-password").value = "";
    await loadCloud();
  } catch (error) {
    cloud.forget();
    showLogin();
    $("#login-error").textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "로그인";
  }
});
$("#logout-button").addEventListener("click", async () => {
  if (busy) return;
  const logout = cloudMode ? cloud.logout() : Promise.resolve();
  cloudMode = false;
  showLogin();
  try {
    await logout;
  } catch {
    toast("기기에서 로그아웃했습니다. 서버 연결은 확인해 주세요.");
  }
});
$("#refresh-button").addEventListener("click", async () => {
  if (busy) return;
  const b = $("#refresh-button");
  b.disabled = true;
  try {
    if (cloudMode) await loadCloud();
    else {
      loadLocal();
      render();
    }
    $("#sync-error").hidden = true;
    toast("목록을 새로고침했습니다.");
  } catch (error) {
    if (!cloud.hasSession()) {
      showLogin();
      $("#login-error").textContent = error.message;
    } else {
      $("#sync-error").hidden = false;
      $("#sync-error").textContent = error.message;
    }
  } finally {
    b.disabled = false;
  }
});
$("#demo-button").addEventListener("click", () => {
  cloudMode = false;
  role = "admin";
  loadLocal();
  showApp();
  if (storageFailed)
    toast("기존 데이터를 읽지 못했습니다. 덮어쓰기를 중단했습니다.");
});
(async () => {
  if (!cloud.configured) {
    $("#login-form").hidden = true;
    $("#demo-button").hidden = false;
    $("#login-description").textContent =
      "클라우드 연결 설정이 아직 완료되지 않았습니다.";
    $("#login-help").textContent =
      "관리자가 Supabase DB와 연결 설정을 완료하면 직원 로그인으로 사용할 수 있습니다. 기존 브라우저 데이터는 아래 버튼으로 확인할 수 있습니다.";
    return;
  }
  if (cloud.hasSession()) {
    try {
      await loadCloud();
    } catch (error) {
      cloud.forget();
      showLogin();
      $("#login-error").textContent = error.message;
    }
  }
})();

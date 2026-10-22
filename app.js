"use strict";
const $ = (s) => document.querySelector(s);
const storageKey = "flow-operations-v1";
const schemas = {
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
  orders: {
    title: "수주관리",
    description: "고객 주문과 품목별 생산·출고 진행 상황을 관리하세요.",
    singular: "수주",
    icon: "▤",
    fields: [
      ["number", "수주번호", "text", false],
      ["received", "접수일", "date", true],
      ["customerId", "고객명", "customer", true],
      ["due", "납기일", "date", true],
      [
        "stage",
        "진행 상태",
        "select",
        true,
        ["접수", "생산중", "출고대기", "취소"],
      ],
      ["items_summary", "주문 품목", "computed"],
      ["total", "주문 수량", "computed"],
      ["delivered", "출고 수량", "computed"],
      ["remaining", "남은 수량", "computed"],
      ["notes", "비고", "textarea"],
    ],
  },
  products: {
    title: "제품관리",
    description: "생산부터 출고까지, 제품의 모든 정보를 관리하세요.",
    singular: "제품",
    icon: "▧",
    fields: [
      ["serial", "시리얼번호", "text", false],
      ["category", "제품 구분", "select", true, ["0", "1", "2"]],
      ["code", "모델명", "text", true],
      ["production", "생산일", "date", true],
      ["rail", "사양", "text"],
      ["lotId", "제조 LOT", "lot", false],
      ["inspection", "검사", "select", true, ["검사대기", "합격", "불합격"]],
      ["status", "상태", "select", true, ["재고", "출고"]],
      ["notes", "비고", "textarea"],
    ],
  },
  lots: {
    title: "제조 LOT",
    description: "생산 묶음별 제품·출고·A/S 이력을 관리하세요.",
    singular: "제조 LOT",
    icon: "▦",
    fields: [
      ["code", "제조 LOT 번호", "text", true],
      ["model", "모델명", "text", true],
      ["specification", "사양", "text", false],
      ["started", "생산 시작일", "date", true],
      ["ended", "생산 종료일", "date", false],
      ["inspection", "검사", "select", true, ["검사대기", "합격", "불합격"]],
      ["status", "상태", "select", true, ["진행중", "마감"]],
      ["productCount", "제품 수", "computed"],
      ["shipmentCount", "출고 수", "computed"],
      ["serviceCount", "A/S 건수", "computed"],
      ["notes", "비고", "textarea", false],
    ],
  },
  shipments: {
    title: "출고관리",
    description: "고객과 제품을 연결하고 출고 내역을 관리하세요.",
    singular: "출고",
    icon: "↗",
    fields: [
      ["date", "출고일", "date", true],
      ["orderItemId", "연결 수주 품목", "orderItem", false],
      ["customerId", "고객명", "customer", true],
      ["name", "제품명", "text", true],
      ["productId", "시리얼번호", "product", true],
      ["quantity", "출고 수량", "number", true],
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
      ["billingType", "유상/무상", "select", true, ["미정", "유상", "무상"]],
      ["chargeAmount", "청구금액(원)", "number", false],
      ["paidAmount", "입금액(원)", "number", false],
      ["paidDate", "입금일", "date", false],
      ["paymentStatus", "입금상태", "computed"],
      ["outstanding", "미수금(원)", "computed"],
    ],
  },
};
let data = {
    products: [],
    customers: [],
    orders: [],
    lots: [],
    shipments: [],
    service: [],
  },
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
  loginInput.placeholder = "예: admin";
  const label = document.querySelector('label[for="' + loginInput.id + '"]');
  if (label?.firstChild?.nodeType === Node.TEXT_NODE)
    label.firstChild.textContent = "아이디";
}

let cloudMode = false,
  role = "employee",
  busy = false,
  authGeneration = 0;
let storageFailed = false;
let serialAutoAvailable = false;
let serialManualAvailable = false;
let customerCodeAvailable = false;
let ordersAvailable = false;
let quantityAvailable = false;
let billingAvailable = false;
let lotsAvailable = false;
let unknownProductionAvailable = false;
let unknownShipmentAvailable = false;
const billingKeys = new Set([
  "billingType",
  "chargeAmount",
  "paidAmount",
  "paidDate",
]);
const productCategories = { 0: "레일방제기", 1: "레일리프트", 2: "미스트" };
function loadLocal() {
  storageFailed = false;
  data = {
    products: [],
    customers: [],
    orders: [],
    lots: [],
    shipments: [],
    service: [],
  };
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const saved = JSON.parse(raw);
      if (
        !["products", "customers", "shipments", "service"].every((k) =>
          Array.isArray(saved[k]),
        )
      )
        throw Error("저장 데이터 형식 오류");
      data = { ...saved, orders: saved.orders || [], lots: saved.lots || [] };
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
const shipped = (id) => !!id && data.shipments.some((s) => s.productId === id);
const status = (p) => (shipped(p.id) ? "출고" : p.status);
const orderTotals = (o) => ({
  total: (o.items || []).reduce((n, i) => n + i.quantity, 0),
  delivered: (o.items || []).reduce((n, i) => n + i.delivered, 0),
  remaining: (o.items || []).reduce((n, i) => n + i.quantity - i.delivered, 0),
});
const orderStage = (o) =>
  o.stage === "취소"
    ? "취소"
    : orderTotals(o).total > 0 && orderTotals(o).remaining === 0
      ? "완료"
      : o.stage;
function linkedItem(id) {
  for (const order of data.orders) {
    const item = order.items.find((i) => i.id === id);
    if (item) return { order, item };
  }
  return null;
}
function paymentStatus(row) {
  const type = row.billingType || "미정",
    charge = Number(row.chargeAmount || 0),
    paid = Number(row.paidAmount || 0);
  return type === "무상"
    ? "해당 없음"
    : type !== "유상"
      ? "확인 필요"
      : charge === 0
        ? "청구예정"
        : paid === 0
          ? "미입금"
          : paid < charge
            ? "부분입금"
            : "입금완료";
}
const lotProducts = (id) => data.products.filter((p) => p.lotId === id);
const lotShipments = (id) => {
  const ids = new Set(lotProducts(id).map((p) => p.id));
  return data.shipments.filter((s) => ids.has(s.productId));
};
const lotServices = (id) => {
  const ids = new Set(lotProducts(id).map((p) => p.id));
  return data.service.filter((s) => ids.has(s.productId));
};
const value = (row, key) =>
  page === "shipments" && key === "date" && !row.date
    ? "미상"
    : page === "products" && key === "production" && !row.production
      ? "미상"
      : key === "lotId"
        ? data.lots.find((l) => l.id === row.lotId)?.code || "미지정"
        : page === "lots" && key === "productCount"
          ? lotProducts(row.id).length
          : page === "lots" && key === "shipmentCount"
            ? lotShipments(row.id).length
            : page === "lots" && key === "serviceCount"
              ? lotServices(row.id).length
              : key === "paymentStatus"
                ? paymentStatus(row)
                : key === "outstanding"
                  ? (
                      Number(row.chargeAmount || 0) -
                      Number(row.paidAmount || 0)
                    ).toLocaleString("ko-KR")
                  : page === "service" && key === "billingType"
                    ? row.billingType || "미정"
                    : page === "service" &&
                        ["chargeAmount", "paidAmount"].includes(key)
                      ? Number(row[key] || 0).toLocaleString("ko-KR")
                      : page === "shipments" && key === "quantity"
                        ? row.quantity || 1
                        : page === "orders" &&
                            ["total", "delivered", "remaining"].includes(key)
                          ? orderTotals(row)[key]
                          : page === "orders" && key === "stage"
                            ? orderStage(row)
                            : key === "items_summary"
                              ? (row.items || [])
                                  .map(
                                    (i) =>
                                      `${i.model}${i.specification?.trim() ? ` / ${i.specification}` : ""} × ${i.quantity}`,
                                  )
                                  .join("; ")
                              : key === "orderItemId"
                                ? linkedItem(row[key])
                                  ? `${linkedItem(row[key]).order.number} · ${linkedItem(row[key]).item.model}`
                                  : "—"
                                : key === "category"
                                  ? productCategories[row[key]] || "미분류"
                                  : key === "productId"
                                    ? row[key]
                                      ? (product(row[key])?.serial ??
                                        "삭제된 제품")
                                      : "시리얼 없음"
                                    : key === "customerId"
                                      ? (customer(row[key])?.name ??
                                        "삭제된 고객")
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
    !["products", "customers", "shipments", "service"].every((k) =>
      Array.isArray(snapshot.data[k]),
    )
  )
    throw Error("서버 데이터 형식을 확인해 주세요.");
  data = {
    ...snapshot.data,
    orders: snapshot.data.orders || [],
    lots: snapshot.data.lots || [],
  };
  serialAutoAvailable = snapshot.serial_auto === true;
  serialManualAvailable = snapshot.serial_manual === true;
  customerCodeAvailable = snapshot.customer_code_auto === true;
  ordersAvailable = snapshot.orders_enabled === true;
  quantityAvailable = snapshot.quantity_management === true;
  billingAvailable = snapshot.service_billing === true;
  lotsAvailable = snapshot.manufacturing_lots === true;
  unknownProductionAvailable = snapshot.production_unknown === true;
  unknownShipmentAvailable = snapshot.shipment_date_unknown === true;
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
  if (!value && page === "orders")
    document.querySelectorAll(".order-line").forEach((el) => {
      const item = data.orders
        .find((o) => o.id === editing)
        ?.items.find((i) => i.id === el.dataset.id);
      if (item?.delivered) el.querySelector("button").disabled = true;
    });
  if (!value && page === "products" && shipped(editing) && $("#field-status"))
    $("#field-status").disabled = true;
  if (
    !value &&
    page === "products" &&
    data.products.find((p) => p.id === editing)?.serial_generated &&
    $("#field-category")
  )
    $("#field-category").disabled = true;
  if (!value && page === "shipments" && $("#field-orderItemId"))
    configureShipmentItem(true);
  if (!value && page === "orders")
    document.querySelectorAll(".order-line").forEach((el) => {
      const item = data.orders
        .find((o) => o.id === editing)
        ?.items.find((i) => i.id === el.dataset.id);
      if (item?.delivered)
        el.querySelector("[data-item=tracking_mode]").disabled = true;
    });
  if (
    !value &&
    page === "service" &&
    billingAvailable &&
    $("#field-billingType")
  )
    syncServiceBilling();
  if (!value && page === "products" && $("#production-unknown"))
    syncUnknownProduction();
  if (!value && page === "shipments" && $("#shipment-date-unknown"))
    syncUnknownShipment();
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
        data.shipments.filter((s) => s.date?.startsWith(today().slice(0, 7)))
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
      [
        "출고일 미상",
        data.shipments.filter((s) => !s.date).length,
        "월별 출고 집계에서 제외",
        "◷",
      ],
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
  if (page === "orders")
    items = [
      ["전체 수주", data.orders.length, "접수된 고객 주문", "▤"],
      [
        "진행 중",
        data.orders.filter((o) => !["완료", "취소"].includes(orderStage(o)))
          .length,
        "생산 및 출고 대기",
        "◷",
      ],
      [
        "완료",
        data.orders.filter((o) => orderStage(o) === "완료").length,
        "전체 수량 출고 완료",
        "✓",
      ],
      [
        "남은 수량",
        data.orders
          .filter((o) => o.stage !== "취소")
          .reduce((n, o) => n + orderTotals(o).remaining, 0),
        "미출고 제품 수량",
        "↗",
      ],
    ];
  if (page === "lots")
    items = [
      ["전체 LOT", data.lots.length, "등록된 생산 묶음", "▦"],
      [
        "진행 중",
        data.lots.filter((l) => l.status === "진행중").length,
        "제품 연결 가능",
        "◷",
      ],
      [
        "마감",
        data.lots.filter((l) => l.status === "마감").length,
        "생산 마감 묶음",
        "✓",
      ],
      [
        "LOT 미지정 제품",
        data.products.filter((p) => !p.lotId).length,
        "기존 제품 포함",
        "▧",
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
    if (page === "lots" && filter !== "전체" && r.status !== filter)
      return false;
    if (page === "orders" && filter !== "전체" && orderStage(r) !== filter)
      return false;
    if (
      page === "products" &&
      filter !== "전체" &&
      (filter === "검사대기" ? r.inspection !== filter : status(r) !== filter)
    )
      return false;
    if (page === "service" && filter !== "전체") {
      if (filter === "완료" && !r.completed) return false;
      if (filter === "진행중" && r.completed) return false;
      if (["유상", "무상"].includes(filter) && r.billingType !== filter)
        return false;
      if (
        ["미입금", "부분입금", "입금완료"].includes(filter) &&
        paymentStatus(r) !== filter
      )
        return false;
    }
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
        ? [
            "전체",
            "진행중",
            "완료",
            "유상",
            "무상",
            "미입금",
            "부분입금",
            "입금완료",
          ]
        : page === "orders"
          ? ["전체", "접수", "생산중", "출고대기", "완료", "취소"]
          : page === "lots"
            ? ["전체", "진행중", "마감"]
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
            return `<td>${["status", "inspection", "stage", "paymentStatus"].includes(key) ? badge(v) : esc(v === 0 ? 0 : v || "—")}</td>`;
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
  if (page === "lots" && (!cloudMode || !lotsAvailable)) {
    toast("제조 LOT DB 업데이트와 클라우드 로그인이 필요합니다.");
    return;
  }
  if (page === "orders" && (!cloudMode || !ordersAvailable)) {
    toast("수주관리 DB 업데이트와 클라우드 로그인이 필요합니다.");
    return;
  }
  if (page === "products" && !id && (!cloudMode || !serialAutoAvailable)) {
    toast(
      cloudMode
        ? "시리얼 자동 생성 DB 업데이트가 필요합니다. 관리자에게 요청하세요."
        : "자동 시리얼 등록은 클라우드 로그인 후 사용할 수 있습니다.",
    );
    return;
  }
  editing = id;
  const row = data[page].find((r) => r.id === id) || {};
  const s = schemas[page];
  $("#dialog-title").textContent = s.singular + (id ? " 수정" : " 등록");
  $("#form-error").textContent = "";
  $("#delete-button").hidden = !id || (cloudMode && role !== "admin");
  $("#form-fields").innerHTML = s.fields
    .filter(
      (f) =>
        f[2] !== "computed" &&
        !(page === "service" && !billingAvailable && billingKeys.has(f[0])) &&
        !(f[0] === "lotId" && !lotsAvailable),
    )
    .map(([key, label, type, required, choices]) => {
      let control;
      if (
        page === "customers" &&
        key === "code" &&
        !id &&
        cloudMode &&
        customerCodeAvailable
      )
        required = false;
      if (page === "products" && key === "category" && id && !row.category)
        required = false;
      if (["product", "select", "orderItem", "lot"].includes(type)) {
        let opts =
          type === "lot"
            ? data.lots
                .filter((l) => l.status === "진행중" || l.id === row.lotId)
                .map((l) => [
                  l.id,
                  `${l.code} · ${l.model} / ${l.specification || "사양 없음"} · ${l.status}`,
                ])
            : type === "product"
              ? data.products
                  .filter((p) => status(p) === "재고" || p.id === row.productId)
                  .map((p) => [p.id, `${p.serial} · ${p.code}`])
              : type === "orderItem"
                ? data.orders.flatMap((o) =>
                    o.items
                      .filter(
                        (i) =>
                          (o.stage !== "취소" && i.delivered < i.quantity) ||
                          i.id === row.orderItemId,
                      )
                      .map((i) => [
                        i.id,
                        `${o.number} · ${customer(o.customerId)?.name} · ${i.model} / ${i.specification || "사양 없음"} (남은 ${i.quantity - i.delivered}대)`,
                      ]),
                  )
                : choices.map((c) => [
                    c,
                    key === "category" ? `${c} · ${productCategories[c]}` : c,
                  ]);
        control = `<select id="field-${key}" name="${key}" ${required ? "required" : ""}><option value="">선택해 주세요</option>${opts.map(([v, l]) => `<option value="${esc(v)}" ${row[key] === v || (!id && type === "select" && v === choices[0]) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
      } else if (type === "textarea")
        control = `<textarea id="field-${key}" name="${key}" ${required ? "required" : ""} maxlength="2000">${esc(row[key] || "")}</textarea>`;
      else
        control = `<input id="field-${key}" name="${key}" type="${type}" value="${esc(row[key] || (!id && type === "date" && key !== "completed" && key !== "paidDate" && key !== "ended" ? today() : ""))}" ${required ? "required" : ""} maxlength="200">`;
      if (page === "products" && key === "serial")
        control = `<input id="field-serial" name="serial" value="${esc(row.serial || "")}" placeholder="저장 시 자동 생성" readonly>`;
      if (
        page === "customers" &&
        key === "code" &&
        cloudMode &&
        customerCodeAvailable
      )
        control = `<input id="field-code" name="code" value="${esc(row.code || "")}" placeholder="저장 시 자동 생성" readonly>`;
      if (page === "orders" && key === "number")
        control = `<input id="field-number" name="number" value="${esc(row.number || "")}" placeholder="저장 시 자동 생성" readonly>`;
      if (page === "shipments" && key === "quantity")
        control = `<input id="field-quantity" name="quantity" type="number" value="${row.quantity || 1}" min="1" max="1000000" step="1" required readonly>`;
      if (page === "service" && ["chargeAmount", "paidAmount"].includes(key))
        control = `<input id="field-${key}" name="${key}" type="number" value="${row[key] || 0}" min="0" max="1000000000000" step="1">`;
      if (type === "customer")
        control = `<input id="field-${key}" name="${key}" type="hidden" value="${esc(row[key] || "")}"><div class="customer-picker"><input id="customer-search" type="search" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="customer-results" placeholder="고객명·코드·연락처 검색" value="${esc(customer(row[key])?.name || "")}" required><div id="customer-results" role="listbox" hidden></div><small id="selected-customer" role="status"></small></div>`;
      if (type === "serviceProduct")
        control = `<input id="field-productId" name="productId" type="hidden" value="${esc(row.productId || "")}"><div class="serial-picker"><input id="service-product-search" type="search" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="service-product-results" placeholder="시리얼·모델명·고객명·LOT 검색" value="${esc(product(row.productId)?.serial || "")}" required><div id="service-product-results" role="listbox" hidden></div><small id="selected-service-product" role="status"></small></div>`;
      let help =
        type === "customer"
          ? "고객관리에서 등록한 고객을 선택하세요."
          : type === "product"
            ? "재고 제품을 선택하면 저장 시 출고 상태로 변경됩니다."
            : type === "serviceProduct"
              ? "번호 일부로 검색하고 결과에서 제품을 선택하세요. 출고 제품이 먼저 표시됩니다."
              : page === "products" && key === "status" && shipped(id)
                ? "출고 이력이 있는 제품은 출고 상태가 유지됩니다."
                : "";
      if (page === "shipments" && key === "name")
        help = "레일리프트·레일방제기 등 출고 제품명을 직접 입력하세요. 수주 모델명과 별도로 저장됩니다.";
      if (type === "lot")
        help =
          "모델명만 LOT와 일치해야 합니다. 사양과 생산일은 연결 조건으로 검사하지 않습니다. 마감 LOT에는 새 제품을 연결할 수 없습니다.";
      if (page === "products" && key === "serial")
        help = id
          ? "등록된 시리얼번호는 변경되지 않습니다."
          : "SN + 제품 구분 + 생산일(YYMMDD) + 구분별 누적 순번. 저장 시 DB가 확정합니다.";
      if (
        page === "products" &&
        row.serial_generated &&
        ["category", "production"].includes(key)
      )
        help = "번호에 포함된 제품 구분과 생산일은 변경할 수 없습니다.";
      if (
        page === "customers" &&
        key === "code" &&
        cloudMode &&
        customerCodeAvailable
      )
        help = id
          ? "등록된 고객코드는 유지됩니다."
          : "저장 시 C0001부터 누적 번호를 생성합니다.";
      return `<label class="field ${type === "textarea" ? "wide" : ""}" for="${type === "serviceProduct" ? "service-product-search" : type === "customer" ? "customer-search" : "field-" + key}">${label}${required ? "<b>*</b>" : ""}${control}${help ? `<small>${help}</small>` : ""}</label>`;
    })
    .join("");
  if (page === "products" && shipped(id)) {
    $("#field-status").value = "출고";
    $("#field-status").disabled = true;
  }
  if (page === "products" && row.serial_generated) {
    $("#field-category").disabled = true;
    $("#field-production").readOnly = true;
  }
  if (page === "products" && !id) {
    const options = `<label class="field wide" for="serial-mode">시리얼번호 입력 방식<select id="serial-mode"><option value="auto">자동 생성</option><option value="manual" ${serialManualAvailable ? "" : "disabled"}>수기 입력${serialManualAvailable ? "" : " (DB 업데이트 필요)"}</option></select></label>`;
    $("#form-fields").insertAdjacentHTML("afterbegin", options);
    $("#serial-mode").addEventListener("change", () => {
      const manual = $("#serial-mode").value === "manual";
      const field = $("#field-serial");
      field.readOnly = !manual;
      field.required = manual;
      field.value = "";
      field.placeholder = manual
        ? "시리얼번호를 입력하세요"
        : "저장 시 자동 생성";
      field.parentElement.querySelector("small").textContent = manual
        ? "기존 번호를 직접 입력합니다. 중복된 번호는 등록할 수 없습니다."
        : "SN + 제품 구분 + 생산일(YYMMDD) + 구분별 누적 순번. 저장 시 DB가 확정합니다.";
      syncUnknownProduction();
    });
  }
  if (page === "customers" && !id && cloudMode && customerCodeAvailable) {
    $("#form-fields").insertAdjacentHTML(
      "afterbegin",
      `<label class="field wide" for="customer-code-mode">고객코드 입력 방식<select id="customer-code-mode"><option value="auto">자동 생성</option><option value="manual">수기 입력</option></select></label>`,
    );
    $("#customer-code-mode").addEventListener("change", () => {
      const manual = $("#customer-code-mode").value === "manual";
      const field = $("#field-code");
      field.readOnly = !manual;
      field.required = manual;
      field.value = "";
      field.placeholder = manual
        ? "고객코드를 입력하세요"
        : "저장 시 자동 생성";
      field.parentElement.querySelector("small").textContent = manual
        ? "기존 코드를 직접 입력합니다. 중복 코드는 등록할 수 없습니다."
        : "저장 시 C0001부터 누적 번호를 생성합니다.";
    });
  }
  if (page === "orders") {
    $("#form-fields").insertAdjacentHTML(
      "beforeend",
      `<section class="wide order-lines"><div class="order-lines-heading"><h2>주문 품목</h2><button type="button" id="add-order-line" class="secondary">+ 품목 추가</button></div><p>모델명과 사양은 제품관리의 값과 동일하게 입력하세요. 시리얼 관리는 1번호당 1대, 수량 관리는 출고 수량으로 집계됩니다.</p><div id="order-lines"></div></section>`,
    );
    for (const item of row.items || [
      {
        id: crypto.randomUUID(),
        model: "",
        specification: "",
        quantity: 1,
        delivered: 0,
      },
    ])
      addOrderLine(item);
    $("#add-order-line").addEventListener("click", () =>
      addOrderLine({ id: crypto.randomUUID(), quantity: 1, delivered: 0 }),
    );
  }
  if (s.fields.some((f) => f[2] === "customer")) setupCustomerSearch(row);
  if (page === "shipments" && $("#field-orderItemId")) {
    $("#field-orderItemId").addEventListener("change", () =>
      configureShipmentItem(false),
    );
    configureShipmentItem(true);
  }
  if (page === "service" && billingAvailable) {
    const billingLabel = $("#field-billingType").closest("label");
    billingLabel.insertAdjacentHTML(
      "beforebegin",
      '<div class="form-section-title">비용·입금 정보</div>',
    );
    $("#form-fields").insertAdjacentHTML(
      "beforeend",
      '<p class="field wide billing-help">입금은 담당자가 확인 후 직접 입력합니다. 입금액은 누적 금액, 입금일은 최근 입금일입니다. 수리 완료와 입금 완료는 별도로 관리됩니다.</p>',
    );
    $("#field-billingType").addEventListener("change", syncServiceBilling);
    syncServiceBilling();
  }
  if (page === "service") setupServiceProductSearch(row);
  if (page === "lots" && id) renderLotHistory(row);
  if (
    page === "products" &&
    unknownProductionAvailable &&
    !row.serial_generated
  ) {
    const date = $("#field-production");
    date
      .closest("label")
      .insertAdjacentHTML(
        "afterend",
        `<label class="field wide production-unknown-toggle"><input id="production-unknown" type="checkbox" ${id && !row.production ? "checked" : ""}> 생산일 미상 (수기 등록 제품)</label>`,
      );
    $("#production-unknown").addEventListener("change", syncUnknownProduction);
    syncUnknownProduction();
  }
  if (page === "shipments" && unknownShipmentAvailable) {
    $("#field-date")
      .closest("label")
      .insertAdjacentHTML(
        "afterend",
        `<label class="field wide production-unknown-toggle"><input id="shipment-date-unknown" type="checkbox" ${id && !row.date ? "checked" : ""}> 출고일 미상 (과거 이력)</label>`,
      );
    $("#shipment-date-unknown").addEventListener("change", syncUnknownShipment);
    syncUnknownShipment();
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
    if (
      schemas[page].fields.some((f) => f[2] === "customer") &&
      !form.get("customerId")
    )
      throw Error("검색 결과에서 고객을 선택해 주세요.");
    if (page === "service" && !form.get("productId"))
      throw Error("검색 결과에서 시리얼번호를 선택해 주세요.");
    for (const [key, , type, required] of schemas[page].fields.filter(
      (f) => f[2] !== "computed",
    )) {
      if (page === "service" && !billingAvailable && billingKeys.has(key))
        continue;
      if (key === "lotId" && !lotsAvailable) continue;
      record[key] = String(
        form.get(key) ??
          (key === "status" && old
            ? old.status
            : key === "category" && old
              ? old.category || ""
              : ""),
      ).trim();
      if (
        required &&
        !(
          page === "shipments" &&
          key === "date" &&
          $("#shipment-date-unknown")?.checked
        ) &&
        !(
          page === "products" &&
          key === "production" &&
          $("#production-unknown")?.checked
        ) &&
        !(
          page === "shipments" &&
          key === "productId" &&
          linkedItem($("#field-orderItemId")?.value)?.item.tracking_mode ===
            "quantity"
        ) &&
        !(
          page === "customers" &&
          key === "code" &&
          !old &&
          $("#customer-code-mode")?.value === "auto"
        ) &&
        !record[key] &&
        !(page === "products" && key === "category" && old && !old.category)
      )
        throw Error("필수 항목을 입력해 주세요.");
      if (
        type === "select" &&
        !(
          page === "products" &&
          key === "category" &&
          old &&
          !old.category &&
          !record[key]
        ) &&
        !schemas[page].fields.find((f) => f[0] === key)[4].includes(record[key])
      )
        throw Error("올바른 값을 선택해 주세요.");
    }
    if (page === "products" && !old) {
      record.serial_mode = $("#serial-mode").value;
      if (record.serial_mode === "manual" && !record.serial)
        throw Error("시리얼번호를 입력해 주세요.");
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
    if (page === "customers" && !old && $("#customer-code-mode")) {
      record.customer_code_mode = $("#customer-code-mode").value;
      if (record.customer_code_mode === "manual" && !record.code)
        throw Error("고객코드를 입력해 주세요.");
    }
    if (
      page === "customers" &&
      data.customers.some(
        (r) =>
          r.id !== record.id &&
          r.code.toLowerCase() === record.code.toLowerCase(),
      )
    )
      throw Error("이미 등록된 고객코드입니다.");
    if (page === "service" && billingAvailable) {
      record.chargeAmount = Number(record.chargeAmount || 0);
      record.paidAmount = Number(record.paidAmount || 0);
      if (
        [record.chargeAmount, record.paidAmount].some(
          (n) => !Number.isSafeInteger(n) || n < 0 || n > 1000000000000,
        )
      )
        throw Error("금액은 0~1조 원 범위의 정수로 입력하세요.");
      if (record.paidAmount > record.chargeAmount)
        throw Error("입금액은 청구금액보다 클 수 없습니다.");
      if (
        record.billingType !== "유상" &&
        (record.chargeAmount || record.paidAmount || record.paidDate)
      )
        throw Error("미정 또는 무상 건은 청구·입금 금액을 0으로 설정하세요.");
      if (record.paidAmount > 0 && !record.paidDate)
        throw Error("입금일을 입력해 주세요.");
      if (record.paidAmount === 0) record.paidDate = "";
    }
    if (page === "shipments") {
      record.quantity = Number(record.quantity || 1);
      const quantityMode =
        linkedItem(record.orderItemId)?.item.tracking_mode === "quantity";
      if (
        !Number.isInteger(record.quantity) ||
        record.quantity < 1 ||
        record.quantity > 1000000
      )
        throw Error("출고 수량은 1~1,000,000의 정수로 입력하세요.");
      if (quantityMode) {
        record.productId = "";
        if (!quantityAvailable)
          throw Error("수량 관리 DB 업데이트가 필요합니다.");
      }
      if (
        !customer(record.customerId) ||
        (!quantityMode && !product(record.productId))
      )
        throw Error("고객과 제품을 먼저 등록해 주세요.");
      if (
        !quantityMode &&
        (data.shipments.some(
          (s) => s.id !== record.id && s.productId === record.productId,
        ) ||
          ((!old || old.productId !== record.productId) &&
            status(product(record.productId)) !== "재고"))
      )
        throw Error("이미 출고된 제품입니다.");
      if (
        record.date &&
        !quantityMode &&
        product(record.productId).production &&
        record.date < product(record.productId).production
      )
        throw Error("출고일은 제품 생산일 이후여야 합니다.");
    }
    if (page === "service") {
      if (!product(record.productId)) throw Error("제품을 먼저 등록해 주세요.");
      if (record.completed && record.completed < record.received)
        throw Error("완료일은 접수일 이후여야 합니다.");
    }
    if (page === "orders") {
      if (record.due < record.received)
        throw Error("납기일은 접수일 이후여야 합니다.");
      record.items = [...document.querySelectorAll(".order-line")].map(
        (el) => ({
          id: el.dataset.id,
          tracking_mode: el.querySelector("[data-item=tracking_mode]").value,
          model: el.querySelector("[data-item=model]").value.trim(),
          specification: el
            .querySelector("[data-item=specification]")
            .value.trim(),
          quantity: Number(el.querySelector("[data-item=quantity]").value),
        }),
      );
      if (
        !record.items.length ||
        record.items.some(
          (i) =>
            !i.model ||
            !Number.isInteger(i.quantity) ||
            i.quantity < 1 ||
            i.quantity > 1000000,
        )
      )
        throw Error("품목의 모델명과 올바른 수량을 입력해 주세요.");
    }
    if (page === "lots" && record.ended && record.ended < record.started)
      throw Error("생산 종료일은 시작일 이후여야 합니다.");
    const next = structuredClone(data);
    const index = next[page].findIndex((r) => r.id === record.id);
    if (index < 0) next[page].unshift(record);
    else next[page][index] = record;
    setBusy(true);
    await persist(next, record, old);
    $("#editor").close();
    render();
    toast(
      page === "products" && !old
        ? `제품이 등록되었습니다: ${data.products.find((p) => p.id === record.id)?.serial}`
        : "정보가 저장되었습니다.",
    );
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
  data = {
    products: [],
    customers: [],
    orders: [],
    lots: [],
    shipments: [],
    service: [],
  };
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

function addOrderLine(item) {
  const line = document.createElement("div");
  line.className = "order-line";
  line.dataset.id = item.id;
  line.innerHTML = `<label class="field item-tracking">관리 방식<select data-item="tracking_mode" ${item.delivered ? "disabled" : ""}><option value="serial" ${(item.tracking_mode || "serial") === "serial" ? "selected" : ""}>시리얼 관리</option><option value="quantity" ${item.tracking_mode === "quantity" ? "selected" : ""} ${quantityAvailable ? "" : "disabled"}>수량 관리${quantityAvailable ? "" : " (DB 업데이트 필요)"}</option></select></label><label class="field">모델명<input data-item="model" value="${esc(item.model || "")}" required maxlength="200" ${item.delivered ? "readonly" : ""}></label><label class="field">사양<input data-item="specification" value="${esc(item.specification || "")}" maxlength="200" ${item.delivered ? "readonly" : ""}></label><label class="field">수량<input data-item="quantity" type="number" value="${item.quantity}" min="${Math.max(1, item.delivered || 0)}" max="1000000" step="1" required></label><div class="item-progress">출고 ${item.delivered || 0} / 남은 ${item.quantity - (item.delivered || 0)}</div><button type="button" class="danger remove-order-line" ${item.delivered ? "disabled" : ""}>삭제</button>`;
  line.querySelector("[data-item=quantity]").addEventListener("input", (e) => {
    line.querySelector(".item-progress").textContent =
      `출고 ${item.delivered || 0} / 남은 ${Number(e.target.value) - (item.delivered || 0)}`;
  });
  line.querySelector("button").addEventListener("click", () => line.remove());
  $("#order-lines").append(line);
}
function configureShipmentItem(initial) {
  const link = linkedItem($("#field-orderItemId").value);
  const current = $("#field-productId").value;
  const quantityMode = link?.item.tracking_mode === "quantity";
  $("#field-productId").disabled = quantityMode;
  $("#field-productId").required = !quantityMode;
  $("#field-productId").closest(".field").hidden = quantityMode;
  $("#field-quantity").readOnly = !quantityMode;
  if (!quantityMode) $("#field-quantity").value = "1";
  if (quantityMode) {
    $("#field-productId").value = "";
    if (!initial) $("#field-quantity").value = "1";
  }
  $("#field-name").readOnly = false;
  if (link) {
    $("#field-customerId").value = link.order.customerId;
    updateCustomerDisplay(link.order.customerId);
  }
  if ($("#customer-search")) {
    $("#customer-search").readOnly = !!link;
    if (link) {
      $("#customer-results").hidden = true;
      $("#customer-search").setAttribute("aria-expanded", "false");
    }
  }
  const old = data.shipments.find((s) => s.id === editing);
  const options = data.products.filter(
    (p) =>
      (status(p) === "재고" || p.id === old?.productId) &&
      (!link ||
        (p.code.trim().toLowerCase() === link.item.model.trim().toLowerCase() &&
          (p.rail || "").trim().toLowerCase() ===
            link.item.specification.trim().toLowerCase())),
  );
  $("#field-productId").innerHTML =
    '<option value="">선택해 주세요</option>' +
    options
      .map(
        (p) =>
          `<option value="${esc(p.id)}">${esc(p.serial)} · ${esc(p.code)}</option>`,
      )
      .join("");
  if (!quantityMode && initial && options.some((p) => p.id === current))
    $("#field-productId").value = current;
}

function syncServiceBilling() {
  const paid = $("#field-billingType").value === "유상";
  for (const key of ["chargeAmount", "paidAmount", "paidDate"]) {
    const field = $("#field-" + key);
    field.readOnly = !paid;
    if (!paid) field.value = key === "paidDate" ? "" : "0";
  }
}

function renderLotHistory(lot) {
  const products = lotProducts(lot.id),
    shipments = lotShipments(lot.id),
    services = lotServices(lot.id);
  const list = (rows, empty) =>
    rows.length
      ? `<ul>${rows.map((text) => `<li>${text}</li>`).join("")}</ul>`
      : `<p>${empty}</p>`;
  $("#form-fields").insertAdjacentHTML(
    "beforeend",
    `<section class="lot-history"><h2>LOT 연결 이력</h2><h3>제품 ${products.length}개</h3>${list(
      products.map(
        (p) => `${esc(p.serial)} · ${esc(p.code)} · ${esc(status(p))}`,
      ),
      "연결된 제품이 없습니다.",
    )}<h3>출고 ${shipments.length}건</h3>${list(
      shipments.map(
        (s) =>
          `${esc(s.date || "미상")} · ${esc(customer(s.customerId)?.name)} · ${esc(product(s.productId)?.serial)}`,
      ),
      "출고 내역이 없습니다.",
    )}<h3>A/S ${services.length}건</h3>${list(
      services.map(
        (a) =>
          `${esc(a.received)} · ${esc(product(a.productId)?.serial)} · ${esc(a.symptom)} · ${a.completed ? "완료" : "진행중"}`,
      ),
      "A/S 내역이 없습니다.",
    )}</section>`,
  );
}
function setupServiceProductSearch(row) {
  const input = $("#service-product-search"),
    hidden = $("#field-productId"),
    list = $("#service-product-results"),
    summary = $("#selected-service-product");
  let matches = [],
    active = -1;
  const customerNames = new Map(data.customers.map((c) => [c.id, c.name])),
    lotCodes = new Map(data.lots.map((l) => [l.id, l.code]));
  const shipmentByProduct = new Map(
    data.shipments.filter((s) => s.productId).map((s) => [s.productId, s]),
  );
  const isShipped = (p) => shipmentByProduct.has(p.id) || p.status === "출고";
  const descriptions = new Map(
    data.products.map((p) => [
      p.id,
      [
        p.code,
        p.rail,
        isShipped(p) ? "출고" : "재고",
        customerNames.get(shipmentByProduct.get(p.id)?.customerId),
        lotCodes.get(p.lotId),
      ]
        .filter(Boolean)
        .join(" · "),
    ]),
  );
  const description = (p) => descriptions.get(p.id) || "";
  const indexed = data.products
    .map((p) => ({
      product: p,
      query: `${p.serial} ${description(p)}`.toLowerCase(),
    }))
    .sort(
      (a, b) =>
        Number(isShipped(b.product)) - Number(isShipped(a.product)) ||
        a.product.serial.localeCompare(b.product.serial),
    );
  function close() {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  }
  function choose(p) {
    hidden.value = p.id;
    input.value = p.serial;
    summary.textContent = description(p);
    $("#field-model").value = p.code;
    input.focus();
    close();
  }
  function search() {
    const q = input.value.trim().toLowerCase();
    matches = indexed
      .filter((entry) => !q || entry.query.includes(q))
      .map((entry) => entry.product);
    const total = matches.length;
    matches = matches.slice(0, 20);
    active = -1;
    list.innerHTML = matches.length
      ? matches
          .map(
            (p, i) =>
              `<button type="button" role="option" aria-selected="false" id="serial-result-${i}" data-match="${i}"><strong>${esc(p.serial)}</strong><span>${esc(description(p))}</span></button>`,
          )
          .join("")
      : `<p>검색 결과가 없습니다.</p>`;
    if (total > 20)
      list.insertAdjacentHTML(
        "beforeend",
        `<p>검색 결과 ${total}개 중 20개 표시 · 번호를 더 입력해 주세요.</p>`,
      );
    input.removeAttribute("aria-activedescendant");
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }
  list.addEventListener("click", (e) => {
    const b = e.target.closest("[data-match]");
    if (b) choose(matches[Number(b.dataset.match)]);
  });
  input.addEventListener("input", () => {
    hidden.value = "";
    summary.textContent = "검색 결과에서 제품을 선택해 주세요.";
    search();
  });
  input.addEventListener("focus", search);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !list.hidden) {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (["ArrowDown", "ArrowUp"].includes(e.key)) {
      e.preventDefault();
      if (list.hidden) search();
      if (!matches.length) return;
      active = Math.max(
        0,
        Math.min(matches.length - 1, active + (e.key === "ArrowDown" ? 1 : -1)),
      );
      list
        .querySelectorAll("[role=option]")
        .forEach((b, i) =>
          b.setAttribute("aria-selected", String(i === active)),
        );
      input.setAttribute("aria-activedescendant", `serial-result-${active}`);
      list
        .querySelector(`#serial-result-${active}`)
        .scrollIntoView({ block: "nearest" });
    }
    if (e.key === "Enter" && !list.hidden) {
      e.preventDefault();
      const exact = matches.find(
        (p) => p.serial.toLowerCase() === input.value.trim().toLowerCase(),
      );
      if (matches[active] || exact || matches.length === 1)
        choose(matches[active] || exact || matches[0]);
    }
  });
  input.addEventListener("blur", () =>
    setTimeout(() => {
      if (!list.contains(document.activeElement)) close();
    }, 150),
  );
  if (product(row.productId))
    summary.textContent = description(product(row.productId));
}

function syncUnknownProduction() {
  const checkbox = $("#production-unknown"),
    date = $("#field-production");
  if (!checkbox || !date) return;
  const old = data.products.find((p) => p.id === editing);
  const manual = old
    ? !old.serial_generated
    : $("#serial-mode")?.value === "manual";
  checkbox.disabled = !manual;
  if (!manual) checkbox.checked = false;
  date.required = !checkbox.checked;
  date.disabled = checkbox.checked;
  if (checkbox.checked) date.value = "";
}

function syncUnknownShipment() {
  const checkbox = $("#shipment-date-unknown"),
    date = $("#field-date");
  if (!checkbox || !date) return;
  date.required = !checkbox.checked;
  date.disabled = checkbox.checked;
  if (checkbox.checked) date.value = "";
}
function updateCustomerDisplay(id) {
  const c = customer(id);
  if (!$("#customer-search")) return;
  $("#customer-search").value = c?.name || "";
  $("#selected-customer").textContent = c
    ? [c.code, c.phone, c.address].filter(Boolean).join(" · ")
    : "";
}
function setupCustomerSearch(row) {
  const input = $("#customer-search"),
    hidden = $("#field-customerId"),
    list = $("#customer-results"),
    summary = $("#selected-customer");
  let matches = [],
    active = -1;
  const entries = data.customers.map((c) => ({
    c,
    text: [c.name, c.code, c.phone, c.address]
      .filter(Boolean)
      .join(" ")
      .toLowerCase(),
    phone: (c.phone || "").replace(/\D/g, ""),
  }));
  function close() {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  }
  function choose(c) {
    hidden.value = c.id;
    updateCustomerDisplay(c.id);
    input.focus();
    close();
  }
  function search() {
    if (input.readOnly) return;
    const q = input.value.trim().toLowerCase(),
      digits = /^[0-9+()\-\s]+$/.test(q) ? q.replace(/\D/g, "") : "";
    matches = entries
      .filter(
        (e) => !q || e.text.includes(q) || (digits && e.phone.includes(digits)),
      )
      .sort(
        (a, b) =>
          Number(b.c.code.toLowerCase() === q) -
          Number(a.c.code.toLowerCase() === q),
      )
      .map((e) => e.c);
    const total = matches.length;
    matches = matches.slice(0, 20);
    active = -1;
    list.innerHTML = matches.length
      ? matches
          .map(
            (c, i) =>
              `<button type="button" role="option" aria-selected="false" id="customer-result-${i}" data-customer="${i}"><strong>${esc(c.name)}</strong><span>${esc([c.code, c.phone, c.address].filter(Boolean).join(" · "))}</span></button>`,
          )
          .join("")
      : "<p>검색 결과가 없습니다.</p>";
    if (total > 20)
      list.insertAdjacentHTML(
        "beforeend",
        `<p>검색 결과 ${total}개 중 20개 표시 · 검색어를 더 입력해 주세요.</p>`,
      );
    input.removeAttribute("aria-activedescendant");
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }
  input.addEventListener("focus", search);
  input.addEventListener("input", () => {
    hidden.value = "";
    summary.textContent = "검색 결과에서 고객을 선택해 주세요.";
    search();
  });
  list.addEventListener("click", (e) => {
    const b = e.target.closest("[data-customer]");
    if (b) choose(matches[Number(b.dataset.customer)]);
  });
  input.addEventListener("keydown", (e) => {
    if (input.readOnly) return;
    if (e.key === "Escape" && !list.hidden) {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (["ArrowDown", "ArrowUp"].includes(e.key)) {
      e.preventDefault();
      if (list.hidden) search();
      if (!matches.length) return;
      active = Math.max(
        0,
        Math.min(matches.length - 1, active + (e.key === "ArrowDown" ? 1 : -1)),
      );
      list
        .querySelectorAll("[role=option]")
        .forEach((b, i) =>
          b.setAttribute("aria-selected", String(i === active)),
        );
      input.setAttribute("aria-activedescendant", `customer-result-${active}`);
      list
        .querySelector(`#customer-result-${active}`)
        .scrollIntoView({ block: "nearest" });
    }
    if (e.key === "Enter" && !list.hidden) {
      e.preventDefault();
      const exact = matches.find(
        (c) => c.code.toLowerCase() === input.value.trim().toLowerCase(),
      );
      if (matches[active] || exact || matches.length === 1)
        choose(matches[active] || exact || matches[0]);
    }
  });
  input.addEventListener("blur", () =>
    setTimeout(() => {
      if (!list.contains(document.activeElement)) close();
    }, 150),
  );
  list.addEventListener("focusout", () =>
    setTimeout(() => {
      if (
        document.activeElement !== input &&
        !list.contains(document.activeElement)
      )
        close();
    }, 0),
  );
  updateCustomerDisplay(row.customerId);
}

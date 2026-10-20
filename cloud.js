"use strict";
// Supabase Auth + PostgREST. No third-party script or admin credential required.
window.FlowCloud = (() => {
  const config = window.FLOW_CONFIG || {};
  const url = String(config.supabaseUrl || "").replace(/\/$/, "");
  const key = String(config.supabasePublishableKey || "");
  const usernameDomain = String(
    config.usernameEmailDomain || "flow.invalid",
  ).toLowerCase();
  const configured = !!(url && key);
  const sessionKey = "flow-auth:" + url;
  let session = null,
    refreshing = null,
    sessionGeneration = 0;
  if (configured) {
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url))
      throw Error("올바른 Supabase Project URL을 설정해 주세요.");
    if (key.startsWith("sb_secret_"))
      throw Error(
        "관리자용 키는 사용할 수 없습니다. publishable key를 설정하세요.",
      );
    if (key.split(".").length === 3) {
      try {
        if (
          JSON.parse(
            atob(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
          ).role === "service_role"
        )
          throw Error("SERVICE_ROLE");
      } catch (e) {
        if (e.message === "SERVICE_ROLE")
          throw Error("관리자용 키는 사용할 수 없습니다.");
      }
    }
    try {
      session = JSON.parse(sessionStorage.getItem(sessionKey) || "null");
    } catch {
      session = null;
    }
  }
  function remember(value) {
    sessionGeneration++;
    session = value;
    try {
      if (value) sessionStorage.setItem(sessionKey, JSON.stringify(value));
      else sessionStorage.removeItem(sessionKey);
    } catch {}
  }
  function message(error, status) {
    const m = error?.message || error?.msg || error?.error_description || "";
    const lotErrors = {
      LOT_CLOSED:
        "마감 LOT에는 제품을 추가하거나 기존 연결을 변경할 수 없습니다.",
      LOT_PRODUCT_MISMATCH: "제품의 모델명·사양이 LOT와 다릅니다.",
      LOT_PRODUCTION_DATE: "제품 생산일이 LOT 생산 기간에 포함되어야 합니다.",
      LOT_CODE_LOCKED: "제품이 연결된 LOT 번호는 변경할 수 없습니다.",
      LOT_LINKED_PRODUCTS:
        "연결된 제품과 맞지 않는 모델·사양·생산 기간으로 변경할 수 없습니다.",
    };
    for (const [code, label] of Object.entries(lotErrors))
      if (m.includes(code)) return label;
    const quantityErrors = {
      INVALID_SHIPMENT_QUANTITY: "출고 수량은 1~1,000,000의 정수여야 합니다.",
      SERIAL_SHIPMENT_REQUIRED:
        "시리얼 관리 출고는 제품을 선택하고 수량 1로 등록하세요.",
      QUANTITY_SHIPMENT_NO_SERIAL:
        "수량 관리 출고에는 시리얼 제품을 연결하지 않습니다.",
      ORDER_TRACKING_LOCKED:
        "출고 이력이 있는 품목의 관리 방식은 변경할 수 없습니다.",
    };
    for (const [code, label] of Object.entries(quantityErrors))
      if (m.includes(code)) return label;
    const orderErrors = {
      ORDER_ITEMS_REQUIRED: "수주에 품목을 1~100개 등록해 주세요.",
      INVALID_ORDER_ITEM: "수주 품목을 확인해 주세요.",
      ORDER_CUSTOMER_LOCKED:
        "출고 이력이 있는 수주의 고객은 변경할 수 없습니다.",
      ORDER_QUANTITY_BELOW_SHIPPED:
        "주문 수량은 이미 출고한 수량보다 적을 수 없습니다.",
      ORDER_ITEM_LOCKED: "출고한 품목의 모델명과 사양은 변경할 수 없습니다.",
      ORDER_CANCELLED: "취소된 수주에는 출고를 등록할 수 없습니다.",
      ORDER_CUSTOMER_MISMATCH: "수주의 고객과 출고 고객이 다릅니다.",
      ORDER_PRODUCT_MISMATCH: "수주 품목과 제품의 모델명·사양이 다릅니다.",
      ORDER_OVERSHIP: "주문 수량을 초과해 출고할 수 없습니다.",
      ORDER_SHIPMENT_DATE: "출고일은 수주 접수일 이후여야 합니다.",
    };
    for (const [code, label] of Object.entries(orderErrors))
      if (m.includes(code)) return label;
    if (m.includes("MANUAL_CUSTOMER_CODE_REQUIRED"))
      return "수기로 입력할 고객코드를 작성해 주세요.";
    if (m.includes("CUSTOMER_CODE_IMMUTABLE"))
      return "등록된 고객코드는 변경할 수 없습니다.";
    if (m.includes("INVALID_CUSTOMER_CODE_MODE"))
      return "고객코드 입력 방식을 선택해 주세요.";
    if (m.includes("MANUAL_SERIAL_REQUIRED"))
      return "수기로 입력할 시리얼번호를 작성해 주세요.";
    if (m.includes("SERIAL_CATEGORY_MISMATCH"))
      return "시리얼번호의 제품 구분 숫자와 선택한 제품 구분이 다릅니다.";
    if (m.includes("INVALID_SERIAL_MODE"))
      return "시리얼번호 입력 방식을 선택해 주세요.";
    if (m.includes("PRODUCT_CATEGORY_REQUIRED"))
      return "제품 구분을 선택해 주세요.";
    if (m.includes("SERIAL_SOURCE_IMMUTABLE"))
      return "자동 생성된 번호의 제품 구분과 생산일은 변경할 수 없습니다.";
    if (m.includes("SERIAL_IMMUTABLE"))
      return "등록된 시리얼번호는 변경할 수 없습니다.";
    if (
      error?.code === "email_not_confirmed" ||
      m.includes("Email not confirmed")
    )
      return "계정의 이메일 확인 상태가 미완료입니다. Supabase에서 Auto Confirm User 설정을 확인해 주세요.";
    if (error?.code === "PGRST202")
      return "DB 로그인 연결 함수가 없습니다. 관리자가 Supabase 설치 SQL을 실행해야 합니다.";
    if (m.includes("Invalid API key") || m.includes("Invalid API Key"))
      return "Supabase 공개 연결 키가 올바른지 확인해 주세요.";
    if (status === 429)
      return "로그인 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.";
    if (status === 401 || m.includes("Invalid login credentials"))
      return "아이디 또는 비밀번호를 확인해 주세요. 로그인이 만료되었다면 다시 로그인하세요.";
    if (m.includes("STAFF_REQUIRED"))
      return "직원 권한이 없습니다. 관리자에게 계정 등록을 요청하세요.";
    if (m.includes("ADMIN_REQUIRED")) return "삭제는 관리자만 할 수 있습니다.";
    if (m.includes("STALE_RECORD"))
      return "다른 직원이 이 정보를 변경했습니다. 목록을 새로고침한 뒤 다시 수정하세요.";
    if (m.includes("ALREADY_SHIPPED"))
      return "이미 출고된 제품입니다. 목록을 새로고침해 주세요.";
    if (m.includes("SHIPMENT_DATE"))
      return "출고일은 제품 생산일 이후여야 합니다.";
    if (error?.code === "23505")
      return "시리얼번호·고객코드 또는 출고 제품이 중복되었습니다.";
    if (error?.code === "23503")
      return "관련 이력이 있거나 참조할 고객·제품이 없습니다. 목록을 새로고침해 주세요.";
    if (
      error?.code === "23514" ||
      error?.code === "23502" ||
      error?.code === "22007"
    )
      return "필수 항목과 날짜, 상태를 확인해 주세요.";
    if (status === 403) return "이 작업에 접근할 권한이 없습니다.";
    return "요청을 처리하지 못했습니다. 연결 및 DB 설정을 확인해 주세요.";
  }
  async function request(
    path,
    { body, method = "POST", auth = false, token } = {},
  ) {
    let response;
    try {
      response = await fetch(url + path, {
        method,
        headers: {
          apikey: key,
          "Content-Type": "application/json",
          ...(auth
            ? { Authorization: "Bearer " + (token ?? session?.access_token) }
            : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw Error(
        "서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 목록을 새로고침해 주세요. 저장 요청이었다면 중복 등록 전 목록을 확인하세요.",
      );
    }
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      const error = Error(message(result, response.status));
      error.status = response.status;
      throw error;
    }
    return result;
  }
  async function refresh() {
    if (refreshing) return refreshing;
    if (!session?.refresh_token) throw Error("로그인이 필요합니다.");
    const generation = sessionGeneration;
    refreshing = (async () => {
      try {
        const next = await request("/auth/v1/token?grant_type=refresh_token", {
          body: { refresh_token: session.refresh_token },
        });
        if (generation === sessionGeneration) remember(next);
      } catch (e) {
        if (
          generation === sessionGeneration &&
          (e.status === 400 || e.status === 401)
        )
          remember(null);
        throw e;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }
  async function rpc(name, body = {}) {
    if (!session) throw Error("로그인이 필요합니다.");
    if ((session.expires_at || 0) * 1000 < Date.now() + 60000) await refresh();
    if (!session) throw Error("로그인이 필요합니다.");
    try {
      return await request("/rest/v1/rpc/" + name, { body, auth: true });
    } catch (e) {
      if (e.status !== 401) throw e;
      await refresh();
      return request("/rest/v1/rpc/" + name, { body, auth: true });
    }
  }
  return {
    configured,
    hasSession: () => !!session,
    username: () => {
      const email = session?.user?.email || "";
      return email.endsWith("@" + usernameDomain)
        ? email.slice(0, -usernameDomain.length - 1)
        : "직원";
    },
    async login(username, password) {
      const normalized = String(username).trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(normalized))
        throw Error("아이디는 영문·숫자·밑줄·하이픈으로 3~32자 입력하세요.");
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(usernameDomain))
        throw Error("아이디 로그인 설정을 확인해 주세요.");
      const email = normalized + "@" + usernameDomain;
      remember(
        await request("/auth/v1/token?grant_type=password", {
          body: { email, password },
        }),
      );
    },
    async logout() {
      const token = session?.access_token;
      remember(null);
      if (token)
        await request("/auth/v1/logout?scope=local", {
          body: {},
          auth: true,
          token,
        });
    },
    forget: () => remember(null),
    snapshot: () => rpc("flow_snapshot"),
    save: (table, record, expectedVersion) =>
      rpc("flow_save", {
        p_table: table,
        p_record: record,
        p_expected_version: expectedVersion ?? null,
      }),
    remove: (table, id, version) =>
      rpc("flow_delete", {
        p_table: table,
        p_id: id,
        p_expected_version: version,
      }),
  };
})();

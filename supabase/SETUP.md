# 무료 클라우드 연결

## 1. Supabase 프로젝트 생성

supabase.com에서 무료 프로젝트를 생성합니다. DB 비밀번호는 프로젝트 설정에 안전하게 보관하고 GitHub 또는 채팅에 넣지 마세요. 이 앱은 회사 한 곳의 직원들이 동일한 데이터를 공유하는 구성입니다.

## 2. DB 설치

새 프로젝트의 SQL Editor에서 `supabase/schema.sql` 전체를 한 번 실행합니다. 테이블, 중복/날짜 검사, 관계, RLS, 직원 확인, 관리자 삭제 권한 및 트랜잭션 RPC를 만듭니다. 이미 동일 이름의 테이블이 있다면 기존 DB를 삭제하지 말고 별도 마이그레이션을 검토하세요.

## 3. 직원 계정 만들기

Authentication 설정에서 **Allow new users to sign up**을 끕니다. Authentication → Users에서 **Add user → Create new user**로 직원 계정을 생성합니다. 비밀번호는 별도의 안전한 경로로 직원에게 전달합니다. 초기 버전은 관리자 생성 계정과 이메일/비밀번호 로그인만 지원합니다. 사용자 스스로 가입하거나 초대 메일 링크에서 비밀번호를 설정하는 화면은 없습니다.

Users 화면에서 사용자 UUID를 복사한 뒤 SQL Editor에서 아래를 실행합니다. UUID는 본인의 실제 사용자 ID로 바꿉니다.

```sql
insert into public.flow_members(user_id, role)
values ('사용자-UUID', 'admin');
-- 다른 직원은 'admin' 대신 'employee'를 사용합니다.
```

관리자·직원 모두 조회/등록/수정할 수 있고 삭제는 관리자만 가능합니다. 권한은 화면뿐 아니라 DB에서도 강제됩니다. 계정을 중단하려면 해당 사용자의 flow_members 행을 삭제하고 Auth 계정을 비활성화하세요. 자기 자신을 관리자로 등록할 수 있는 공개 API는 없습니다.

비밀번호 재설정은 관리자 대시보드에서 처리합니다. 셀프서비스 재설정 및 비밀번호 변경 화면은 후속 기능입니다. 사용자 계정을 직원마다 따로 생성하고 공유 계정을 사용하지 마세요.

## 4. 공개 연결 설정

Project Settings의 API/Data API/API Keys 화면에서 Project URL과 **publishable key**(또는 legacy anon key)를 확인해 루트의 `config.js`에 입력합니다.

```js
window.FLOW_CONFIG = {
  supabaseUrl: 'https://프로젝트ID.supabase.co',
  supabasePublishableKey: 'sb_publishable_공개키'
};
```

이 두 값은 브라우저에 공개되는 설정입니다. `service_role`, `sb_secret_` 키, DB 비밀번호는 넣지 마세요. 데이터 보호는 직원 인증, RLS 및 RPC 권한 검사로 처리합니다.

## 5. GitHub Pages

GitHub 저장소 Settings → Pages → Deploy from a branch → master / (root) → Save.

배포 후 `https://adh9608.github.io/web-study/`에서 직원 계정으로 로그인합니다. Authentication URL Configuration의 Site URL도 위 주소로 설정합니다. URL을 설정하는 것만으로 비밀번호 재설정 화면이 구현되는 것은 아닙니다.

## 검증

- 로그인 없이 제품/고객 데이터를 읽거나 변경할 수 없어야 합니다.
- Auth 계정만 있고 flow_members에 없는 사용자는 접근할 수 없어야 합니다.
- 관리자가 제품/고객/출고를 등록한 뒤 다른 직원과 다른 기기에서 동일한 데이터가 보여야 합니다.
- 직원은 삭제할 수 없어야 합니다. 직접 RPC를 호출해도 삭제가 거부되어야 합니다.
- 중복 시리얼/고객코드/출고 및 접수일 이전 완료일이 DB에서 거부되어야 합니다.
- 같은 항목을 동시에 수정하면 먼저 저장한 정보가 덮어써지지 않고 뒤 요청에 갱신 안내가 표시되어야 합니다.
- 오래된 값이 보이면 새로고침 버튼을 사용합니다. 자동 실시간 동기화는 아직 없습니다.

기존 브라우저 저장 데이터는 유지하지만 DB에 자동 업로드하지 않습니다. 설정이 비어 있을 때 로그인 화면의 ‘기존 브라우저 데이터 보기’에서 CSV를 백업할 수 있습니다. 클라우드 초기 DB는 비어 있습니다. 데이터 이전은 별도로 준비해야 합니다.

## 무료 플랜 및 백업

요금제의 데이터·트래픽 제한과 비활성 프로젝트 중지 정책은 Supabase의 현재 정책을 확인하세요. 무료 플랜의 자동 백업/복구 보장을 전제로 운영하지 마세요. 정기적으로 DB를 별도 백업하고 복구 방법을 확인해야 합니다. 화면의 CSV는 목록 내보내기이며 완전한 DB 복구용 파일이 아닙니다.

실제 프로젝트에서 SQL 실행 및 직원 로그인/저장 검증이 완료되기 전에는 운영 연결 완료로 보지 않습니다.
